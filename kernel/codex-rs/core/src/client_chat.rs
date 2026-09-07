//! Chat Completions wire-protocol client.
//!
//! Restored for OpenAI-compatible endpoints (Alibaba Cloud MaaS GLM, and other
//! domestic providers) that only implement the classic `POST /chat/completions`
//! protocol instead of the Responses API.
//!
//! Responsibilities mirror `stream_responses_api` in `client.rs`:
//!
//! - Translate the conversation [`Prompt`] (Responses `ResponseItem`s) into a
//!   Chat Completions `messages` array plus `tools` definitions.
//! - POST to `{base_url}/chat/completions` with `stream: true` and
//!   `stream_options: {include_usage: true}` using the same transport, auth,
//!   and retry machinery as the Responses path.
//! - Parse the SSE stream and aggregate `delta.tool_calls` fragments (keyed by
//!   `index`) into complete `ResponseItem::FunctionCall` items, emitting the
//!   same `ResponseEvent` sequence the agent loop already consumes.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use codex_api::ApiError;
use codex_api::RequestTelemetry as ApiRequestTelemetry;
use codex_api::ReqwestTransport;
use codex_api::ResponseEvent;
use codex_api::ResponseStream as ApiResponseStream;
use codex_api::RetryConfig;
use codex_api::SseTelemetry;
use codex_api::TransportError;
use codex_client::EncodedJsonBody;
use codex_client::Request;
use codex_client::RequestBody;
use codex_client::RequestCompression;
use codex_client::run_with_retry;
use codex_login::default_client::add_originator_header;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::TokenUsage;
use codex_tools::ToolSpec;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use http::HeaderMap;
use http::HeaderValue;
use http::Method;
use http::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant as TokioInstant;
use tokio::time::timeout;
use tracing::debug;
use tracing::trace;

use crate::client_common::Prompt;
use crate::responses_metadata::CodexResponsesMetadata;

const CHAT_COMPLETIONS_PATH: &str = "/chat/completions";
const RESPONSE_STREAM_CHANNEL_CAPACITY: usize = 1600;

/// Builds the extra headers attached to Chat Completions requests.
///
/// Mirrors the Responses-path header construction minus Responses-specific
/// conventions that non-OpenAI chat gateways reject or ignore. Session
/// telemetry/tracing headers and the originator are still attached.
pub(crate) fn build_chat_headers(
    originator: &str,
    responses_metadata: &CodexResponsesMetadata,
    request_telemetry: Option<&Arc<dyn ApiRequestTelemetry>>,
) -> HeaderMap {
    let _ = request_telemetry;
    let mut headers = HeaderMap::new();
    add_originator_header(&mut headers, originator);
    if let Ok(header_value) = HeaderValue::from_str(&responses_metadata.thread_id) {
        headers.insert("x-client-request-id", header_value);
    }
    headers.extend(codex_api::build_session_headers(
        Some(responses_metadata.session_id.to_string()),
        Some(responses_metadata.thread_id.to_string()),
    ));
    headers
}

/// Content entries for a chat message. Either a plain string or an array of
/// typed content parts (required for image inputs).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

fn chat_text_content(text: String) -> ChatContent {
    ChatContent::Text(text)
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatContentPart {
    Text {
        text: String,
    },
    ImageUrl {
        image_url: ChatImageUrl,
    },
}

#[derive(Debug, Clone, Serialize)]
struct ChatImageUrl {
    url: String,
}

/// A single entry in the chat `messages` array.
#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<ChatContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ChatToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ChatToolCall {
    /// Echoed per-call identity. Use the upstream call id when replaying a
    /// recorded FunctionCall so the matching tool output lines back up.
    id: String,
    #[serde(rename = "type")]
    r#type: &'static str,
    function: ChatToolCallFunction,
}

#[derive(Debug, Clone, Serialize)]
struct ChatToolCallFunction {
    name: String,
    arguments: String,
}

/// Tool definition in Chat Completions format.
#[derive(Debug, Clone, Serialize)]
struct ChatTool {
    #[serde(rename = "type")]
    r#type: &'static str,
    function: ChatFunctionDefinition,
}

#[derive(Debug, Clone, Serialize)]
struct ChatFunctionDefinition {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ChatTool>,
    stream: bool,
    stream_options: ChatStreamOptions,
}

#[derive(Debug, Serialize)]
struct ChatStreamOptions {
    include_usage: bool,
}

fn chat_tools_from_prompt(tools: &[ToolSpec]) -> Vec<ChatTool> {
    tools
        .iter()
        .filter_map(|tool| match tool {
            ToolSpec::Function(function) => Some(ChatTool {
                r#type: "function",
                function: ChatFunctionDefinition {
                    name: function.name.clone(),
                    description: (!function.description.is_empty())
                        .then(|| function.description.clone()),
                    parameters: serde_json::to_value(&function.parameters).ok(),
                },
            }),
            // Chat Completions has no wire representation for Responses-only
            // tool kinds (namespaces, web search, freeform tools, tool
            // search); they are dropped rather than sending invalid payloads.
            ToolSpec::Namespace(_) | ToolSpec::ToolSearch { .. } => None,
            ToolSpec::WebSearch { .. } => None,
            ToolSpec::Freeform(_) => None,
        })
        .collect()
}

fn content_items_to_chat_parts(content: &[ContentItem]) -> ChatContent {
    let mut parts: Vec<ChatContentPart> = Vec::with_capacity(content.len());
    let mut text_only = String::new();
    let mut is_text_only = true;
    for item in content {
        match item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                if !text_only.is_empty() {
                    text_only.push('\n');
                }
                text_only.push_str(text);
                parts.push(ChatContentPart::Text { text: text.clone() });
            }
            ContentItem::InputImage { image_url, .. } => {
                is_text_only = false;
                parts.push(ChatContentPart::ImageUrl {
                    image_url: ChatImageUrl {
                        url: image_url.clone(),
                    },
                });
            }
            ContentItem::InputAudio { .. } => {
                // Chat audio input is not supported on most OpenAI-compatible
                // gateways; keep the request valid by dropping the part.
            }
        }
    }
    if is_text_only {
        chat_text_content(text_only)
    } else {
        ChatContent::Parts(parts)
    }
}

fn function_call_output_text(output: &codex_protocol::models::FunctionCallOutputPayload) -> String {
    match output.body.to_text() {
        Some(text) => text,
        None => serde_json::to_string(&output.body)
            .unwrap_or_else(|_| String::from("<unserializable tool output>")),
    }
}

/// Converts Responses `ContentItem`s from a tool output payload to chat text.
fn output_content_items_to_text(
    items: &[FunctionCallOutputContentItem],
) -> Option<String> {
    let segments = items
        .iter()
        .filter_map(|item| match item {
            FunctionCallOutputContentItem::InputText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    (!segments.is_empty()).then(|| segments.join("\n"))
}

/// Translates the conversation history (`Prompt.input`) into chat messages.
pub(crate) fn build_chat_messages(prompt: &Prompt) -> Vec<ChatMessage> {
    let mut messages = Vec::with_capacity(prompt.input.len() + 1);
    if !prompt.base_instructions.text.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: Some(chat_text_content(prompt.base_instructions.text.clone())),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    for item in &prompt.input {
        match item {
            ResponseItem::Message {
                role, content, ..
            } => {
                messages.push(ChatMessage {
                    role: role.clone(),
                    content: Some(content_items_to_chat_parts(content)),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                });
            }
            ResponseItem::AgentMessage { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|part| match part {
                        codex_protocol::models::AgentMessageInputContent::InputText { text } => {
                            Some(text.as_str())
                        }
                        codex_protocol::models::AgentMessageInputContent::EncryptedContent {
                            ..
                        } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: Some(chat_text_content(text)),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                });
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: None,
                    tool_calls: Some(vec![ChatToolCall {
                        id: call_id.clone(),
                        r#type: "function",
                        function: ChatToolCallFunction {
                            name: name.clone(),
                            arguments: arguments.clone(),
                        },
                    }]),
                    tool_call_id: None,
                    name: None,
                });
            }
            ResponseItem::CustomToolCall {
                name,
                input,
                call_id,
                ..
            } => {
                // Freeform custom tool calls have no chat equivalent; send the
                // raw input as the arguments payload of a function call.
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: None,
                    tool_calls: Some(vec![ChatToolCall {
                        id: call_id.clone(),
                        r#type: "function",
                        function: ChatToolCallFunction {
                            name: name.clone(),
                            arguments: input.clone(),
                        },
                    }]),
                    tool_call_id: None,
                    name: None,
                });
            }
            ResponseItem::FunctionCallOutput {
                call_id,
                output,
                name,
                ..
            } => {
                let text = function_call_output_text(output);
                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: Some(chat_text_content(text)),
                    tool_calls: None,
                    tool_call_id: Some(call_id.clone().unwrap_or_default()),
                    name: name.clone(),
                });
            }
            ResponseItem::CustomToolCallOutput {
                call_id,
                output,
                name,
                ..
            } => {
                let text = function_call_output_text(output);
                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: Some(chat_text_content(text)),
                    tool_calls: None,
                    tool_call_id: Some(call_id.clone()),
                    name: name.clone(),
                });
            }
            ResponseItem::LocalShellCall {
                call_id, action, ..
            } => {
                // Represent a recorded shell invocation as a function call so
                // the following tool output remains attached to something.
                let arguments = serde_json::to_string(action).unwrap_or_else(|_| "{}".into());
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: None,
                    tool_calls: Some(vec![ChatToolCall {
                        id: call_id.clone().unwrap_or_default(),
                        r#type: "function",
                        function: ChatToolCallFunction {
                            name: "shell".to_string(),
                            arguments,
                        },
                    }]),
                    tool_call_id: None,
                    name: None,
                });
            }
            // Reasoning, compaction summaries, web search records, image
            // generation records and other provider-side bookkeeping items do
            // not exist in the chat protocol and are skipped.
            ResponseItem::Reasoning { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::AdditionalTools { .. }
            | ResponseItem::ConfigurationUpdate { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::Other => {}
        }
    }

    messages
}

pub(crate) fn build_chat_request(prompt: &Prompt, model: &str) -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: model.to_string(),
        messages: build_chat_messages(prompt),
        tools: chat_tools_from_prompt(&prompt.tools),
        stream: true,
        stream_options: ChatStreamOptions {
            include_usage: true,
        },
    }
}

/// Aggregated state for one streamed chat tool call.
#[derive(Debug, Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Deserialized chat delta chunk (subset of the OpenAI Chat Completions wire
/// schema; tolerant of additional fields).
#[derive(Debug, Deserialize)]
struct ChatChunk {
    id: Option<String>,
    choices: Option<Vec<ChatChunkChoice>>,
    usage: Option<ChatUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChunkChoice {
    #[serde(default)]
    delta: ChatDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ChatDelta {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ChatDeltaToolCall>>,
}

#[derive(Debug, Deserialize)]
struct ChatDeltaToolCall {
    #[serde(default)]
    index: Option<i64>,
    #[serde(default)]
    id: Option<String>,
    function: Option<ChatDeltaToolCallFunction>,
}

#[derive(Debug, Deserialize)]
struct ChatDeltaToolCallFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatUsage {
    #[serde(default)]
    prompt_tokens: i64,
    #[serde(default, rename = "prompt_tokens_details")]
    prompt_tokens_details: Option<ChatPromptTokensDetails>,
    #[serde(default)]
    completion_tokens: i64,
    #[serde(default, rename = "completion_tokens_details")]
    completion_tokens_details: Option<ChatCompletionTokensDetails>,
    #[serde(default)]
    total_tokens: i64,
}

#[derive(Debug, Deserialize, Default)]
struct ChatPromptTokensDetails {
    #[serde(default, rename = "cached_tokens")]
    cached_tokens: i64,
}

#[derive(Debug, Deserialize, Default)]
struct ChatCompletionTokensDetails {
    #[serde(default, rename = "reasoning_tokens")]
    reasoning_tokens: i64,
}

impl From<ChatUsage> for TokenUsage {
    fn from(usage: ChatUsage) -> Self {
        Self {
            input_tokens: usage.prompt_tokens,
            cached_input_tokens: usage
                .prompt_tokens_details
                .map(|details| details.cached_tokens)
                .unwrap_or_default(),
            cache_write_input_tokens: 0,
            output_tokens: usage.completion_tokens,
            reasoning_output_tokens: usage
                .completion_tokens_details
                .map(|details| details.reasoning_tokens)
                .unwrap_or_default(),
            total_tokens: usage.total_tokens,
            codex_rollout_budget_units: None,
        }
    }
}

/// Parses one `data:` payload from a chat SSE stream into zero or more events.
fn handle_chat_data(
    data: &str,
    text_seen: &mut bool,
    tool_calls: &mut BTreeMap<i64, PendingToolCall>,
    finish_reason: &mut Option<String>,
    response_id: &mut Option<String>,
    usage: &mut Option<ChatUsage>,
) -> Vec<ResponseEvent> {
    if data == "[DONE]" {
        return Vec::new();
    }
    let Ok(chunk) = serde_json::from_str::<ChatChunk>(data) else {
        debug!(payload_bytes = data.len(), "failed to parse chat SSE chunk");
        return Vec::new();
    };
    if chunk.id.is_some() && response_id.is_none() {
        response_id.clone_from(&chunk.id);
    }
    if let Some(chunk_usage) = chunk.usage {
        *usage = Some(chunk_usage);
    }
    let Some(choice) = chunk.choices.into_iter().next() else {
        return Vec::new();
    };
    if choice
        .finish_reason
        .as_deref()
        .is_some_and(|reason| !reason.is_empty())
    {
        *finish_reason = choice.finish_reason.clone();
    }
    let mut events = Vec::new();
    if let Some(content) = choice.delta.content
        && !content.is_empty()
    {
        *text_seen = true;
        events.push(ResponseEvent::OutputTextDelta(content));
    }
    if let Some(delta_calls) = choice.delta.tool_calls {
        for call in delta_calls {
            let index = call.index.unwrap_or(0);
            let entry = tool_calls.entry(index).or_default();
            if let Some(id) = call.id
                && !id.is_empty()
            {
                entry.id = id;
            }
            if let Some(function) = call.function {
                if let Some(name) = function.name
                    && !name.is_empty()
                {
                    entry.name.push_str(&name);
                }
                if let Some(arguments) = function.arguments {
                    entry.arguments.push_str(&arguments);
                }
            }
        }
    }
    events
}

/// Terminal processing after the SSE stream ends: emit aggregated tool calls
/// as `OutputItemDone(FunctionCall)` events, then the `Completed` event.
fn finish_chat_stream(
    text_seen: bool,
    tool_calls: &mut BTreeMap<i64, PendingToolCall>,
    finish_reason: Option<String>,
    response_id: Option<String>,
    usage: Option<ChatUsage>,
) -> Vec<ResponseEvent> {
    let _ = text_seen;
    let mut events = Vec::new();
    for (_, call) in std::mem::take(tool_calls) {
        if call.name.is_empty() && call.arguments.is_empty() {
            continue;
        }
        let id = if call.id.is_empty() {
            format!("call_{}", uuid::Uuid::now_v7().simple())
        } else {
            call.id
        };
        events.push(ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
            id: Some(codex_protocol::ResponseItemId::with_suffix(
                "fc",
                uuid::Uuid::now_v7(),
            )),
            name: call.name,
            namespace: None,
            arguments: call.arguments,
            encrypted_function_args: None,
            call_id: id,
            internal_chat_message_metadata_passthrough: None,
        }));
    }
    let token_usage = usage.map(TokenUsage::from);
    events.push(ResponseEvent::Completed {
        response_id: response_id.unwrap_or_default(),
        token_usage,
        usage_metadata: None,
        end_turn: match finish_reason.as_deref() {
            Some("tool_calls") | Some("function_call") | Some("stop") => Some(true),
            Some("length") | Some("content_filter") => Some(true),
            _ => None,
        },
    });
    events
}

/// Streams one turn via the Chat Completions API.
///
/// The returned [`ResponseStream`] is the same type the Responses path uses,
/// built around an mpsc channel plus an internal reader task, so the agent
/// loop can consume both transports identically. Retry semantics reuse the
/// shared `run_with_retry` policy from the provider configuration.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_chat_completions(
    transport: ReqwestTransport,
    base_url: String,
    auth: codex_api::SharedAuthProvider,
    extra_headers: HeaderMap,
    retry_policy: RetryConfig,
    idle_timeout: std::time::Duration,
    prompt: &Prompt,
    model: &str,
    session_telemetry: &codex_otel::SessionTelemetry,
    request_telemetry: Option<Arc<dyn ApiRequestTelemetry>>,
    sse_telemetry: Option<Arc<dyn SseTelemetry>>,
    inference_trace_attempt: &codex_rollout_trace::InferenceTraceAttempt,
) -> Result<ApiResponseStream, ApiError> {
    let request_body = build_chat_request(prompt, model);
    let body = EncodedJsonBody::encode(&request_body)
        .map_err(|e| ApiError::Stream(format!("failed to encode chat request: {e}")))?;

    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        CHAT_COMPLETIONS_PATH.trim_start_matches('/')
    );
    let mut headers = extra_headers;
    if !headers.contains_key(http::header::ACCEPT) {
        headers.insert(
            http::header::ACCEPT,
            HeaderValue::from_static("text/event-stream"),
        );
    }
    inference_trace_attempt.add_request_headers(&mut headers);
    let request = Request {
        method: Method::POST,
        url,
        headers,
        body: Some(RequestBody::EncodedJson(body)),
        compression: RequestCompression::None,
        timeout: None,
    };
    let make_request = || request.clone();
    let transport_for_retry = transport.clone();
    let stream_response = run_with_retry(
        retry_policy.to_policy(),
        make_request,
        move |req, _attempt| {
            let auth = auth.clone();
            let transport = transport_for_retry.clone();
            let request_telemetry = request_telemetry.clone();
            async move {
                let req = auth
                    .apply_auth(req)
                    .await
                    .map_err(TransportError::from)?;
                let start = Instant::now();
                let result = transport.stream(req).await;
                if let Some(t) = request_telemetry.as_ref() {
                    let (status, err) = match &result {
                        Ok(resp) => (Some(resp.status), None),
                        Err(err) => (http_status_of(err), Some(err)),
                    };
                    t.on_request(_attempt, status, err, start.elapsed());
                }
                result
            }
        },
    )
    .await
    .map_err(ApiError::Transport)?;

    session_telemetry.counter("codex.chat.stream_started", /*inc*/ 1, &[]);
    Ok(spawn_chat_response_stream(
        stream_response,
        idle_timeout,
        sse_telemetry,
    ))
}

fn http_status_of(error: &TransportError) -> Option<StatusCode> {
    match error {
        TransportError::Http { status, .. } => Some(*status),
        _ => None,
    }
}

/// Converts a `StreamResponse` into the shared `ResponseStream`, mirroring
/// `codex_api::sse::spawn_response_stream` but with chat semantics.
fn spawn_chat_response_stream(
    stream_response: codex_api::StreamResponse,
    idle_timeout: std::time::Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
) -> ApiResponseStream {
    let upstream_request_id = stream_response
        .headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let (tx_event, rx_event) =
        mpsc::channel::<Result<ResponseEvent, ApiError>>(RESPONSE_STREAM_CHANNEL_CAPACITY);
    tokio::spawn(process_chat_sse(
        stream_response.bytes,
        tx_event,
        idle_timeout,
        telemetry,
    ));
    ApiResponseStream {
        rx_event,
        upstream_request_id,
    }
}

/// Reads the chat SSE stream and forwards mapped `ResponseEvent`s.
async fn process_chat_sse(
    stream: codex_http_client::ByteStream,
    tx_event: mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: std::time::Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
) {
    let mut stream = stream.eventsource();
    let mut text_seen = false;
    let mut tool_calls: BTreeMap<i64, PendingToolCall> = BTreeMap::new();
    let mut finish_reason: Option<String> = None;
    let mut response_id: Option<String> = None;
    let mut usage: Option<ChatUsage> = None;

    loop {
        let start = TokioInstant::now();
        let poll = tokio::select! {
            biased;
            _ = tx_event.closed() => return,
            poll = timeout(idle_timeout, stream.next()) => poll,
        };
        if let Some(t) = telemetry.as_ref() {
            t.on_sse_poll(&poll, start.elapsed());
        }
        let sse = match poll {
            Ok(Some(Ok(sse))) => sse,
            Ok(Some(Err(e))) => {
                debug!("chat SSE error: {e:#}");
                let _ = tx_event.send(Err(ApiError::Stream(e.to_string()))).await;
                return;
            }
            Ok(None) => break,
            Err(_) => {
                let _ = tx_event
                    .send(Err(ApiError::Stream("idle timeout waiting for SSE".into())))
                    .await;
                return;
            }
        };
        trace!("chat SSE event: {}", &sse.data);
        if sse.data == "[DONE]" {
            break;
        }
        for event in handle_chat_data(
            &sse.data,
            &mut text_seen,
            &mut tool_calls,
            &mut finish_reason,
            &mut response_id,
            &mut usage,
        ) {
            if tx_event.send(Ok(event)).await.is_err() {
                return;
            }
        }
    }

    for event in finish_chat_stream(
        text_seen,
        &mut tool_calls,
        finish_reason,
        response_id,
        usage,
    ) {
        let _ = tx_event.send(Ok(event)).await;
    }
}

#[cfg(test)]
#[path = "client_chat_tests.rs"]
mod tests;
