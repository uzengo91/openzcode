use super::build_chat_messages;
use super::build_chat_request;
use super::finish_chat_stream;
use super::handle_chat_data;
use super::process_chat_sse;
use super::spawn_chat_response_stream;
use assert_matches::assert_matches;
use codex_api::ApiError;
use codex_api::ResponseEvent;
use codex_http_client::TransportError;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolSpec;
use futures::StreamExt;
use futures::TryStreamExt;
use futures::stream;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::io::ReaderStream;

use crate::client_common::Prompt;

fn chat_prompt() -> Prompt {
    Prompt {
        input: vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "hello".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: "hi there".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCall {
                id: None,
                name: "shell".to_string(),
                namespace: None,
                arguments: r#"{"command":["ls"]}"#.to_string(),
                encrypted_function_args: None,
                call_id: "call-1".to_string(),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCallOutput {
                id: None,
                call_id: Some("call-1".to_string()),
                name: Some("shell".to_string()),
                namespace: None,
                output: codex_protocol::models::FunctionCallOutputPayload::from_text(
                    "file1\nfile2".to_string(),
                ),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::Reasoning {
                id: None,
                summary: vec![],
                content: None,
                encrypted_content: None,
                internal_chat_message_metadata_passthrough: None,
            },
        ],
        base_instructions: BaseInstructions {
            text: "you are a helpful assistant".to_string(),
            provenance: None,
        },
        ..Default::default()
    }
}

#[test]
fn chat_messages_translate_response_items() {
    let messages = build_chat_messages(&chat_prompt());
    assert_eq!(messages.len(), 5);

    assert_eq!(messages[0].role, "system");
    assert_matches!(
        &messages[0].content,
        Some(super::ChatContent::Text(text)) if text == "you are a helpful assistant"
    );

    assert_eq!(messages[1].role, "user");
    assert_matches!(
        &messages[1].content,
        Some(super::ChatContent::Text(text)) if text == "hello"
    );

    assert_eq!(messages[2].role, "assistant");
    assert_matches!(
        &messages[2].content,
        Some(super::ChatContent::Text(text)) if text == "hi there"
    );

    assert_eq!(messages[3].role, "assistant");
    let tool_calls = messages[3].tool_calls.as_ref().unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].id, "call-1");
    assert_eq!(tool_calls[0].function.name, "shell");
    assert_eq!(tool_calls[0].function.arguments, r#"{"command":["ls"]}"#);

    assert_eq!(messages[4].role, "tool");
    assert_eq!(messages[4].tool_call_id.as_deref(), Some("call-1"));
    assert_matches!(
        &messages[4].content,
        Some(super::ChatContent::Text(text)) if text == "file1\nfile2"
    );
}

#[test]
fn chat_request_shape_includes_tools_and_stream_options() {
    let mut prompt = chat_prompt();
    prompt.tools = vec![ToolSpec::Function(ResponsesApiTool {
        name: "shell".to_string(),
        description: "Run a shell command".to_string(),
        strict: false,
        defer_loading: None,
        parameters: codex_tools::JsonSchema::object(
            BTreeMap::from([(
                "command".to_string(),
                codex_tools::JsonSchema::array(
                    codex_tools::JsonSchema::string(/*description*/ None),
                    /*description*/ None,
                ),
            )]),
            /*required*/ None,
            None,
        ),
        output_schema: None,
    })]
    .into();
    let request = build_chat_request(&prompt, "glm-4.6");
    assert_eq!(request.model, "glm-4.6");
    assert!(request.stream);
    assert!(request.stream_options.include_usage);
    assert_eq!(request.tools.len(), 1);
    assert_eq!(request.tools[0].r#type, "function");
    assert_eq!(request.tools[0].function.name, "shell");
    assert_eq!(
        request.tools[0].function.description.as_deref(),
        Some("Run a shell command")
    );
    assert!(request.tools[0].function.parameters.is_some());
}

fn sse_body(events: &[String]) -> String {
    let mut out = String::new();
    for data in events {
        out.push_str("data: ");
        out.push_str(data);
        out.push_str("\n\n");
    }
    out
}

async fn collect_chat_events(body: String) -> Vec<Result<ResponseEvent, ApiError>> {
    let reader = std::io::Cursor::new(body);
    let byte_stream: codex_http_client::ByteStream = Box::pin(
        ReaderStream::new(reader).map_err(|err| TransportError::Network(err.to_string())),
    );
    let (tx, mut rx) = mpsc::channel::<Result<ResponseEvent, ApiError>>(16);
    tokio::spawn(process_chat_sse(
        byte_stream,
        tx,
        Duration::from_millis(5_000),
        /*telemetry*/ None,
    ));
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    events
}

#[tokio::test]
async fn chat_sse_text_deltas_aggregate_into_events() {
    let body = sse_body(&[
        json!({"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hel"}}]}).to_string(),
        json!({"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {"content": "lo"}}]}).to_string(),
        json!({"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).to_string(),
        "[DONE]".to_string(),
    ]);
    let events = collect_chat_events(body).await;

    assert_eq!(events.len(), 3);
    assert_matches!(
        &events[0],
        Ok(ResponseEvent::OutputTextDelta(delta)) if delta == "Hel"
    );
    assert_matches!(
        &events[1],
        Ok(ResponseEvent::OutputTextDelta(delta)) if delta == "lo"
    );
    match &events[2] {
        Ok(ResponseEvent::Completed {
            response_id,
            token_usage,
            end_turn,
            ..
        }) => {
            assert_eq!(response_id, "chatcmpl-1");
            let usage = token_usage.as_ref().expect("usage should be present");
            assert_eq!(usage.input_tokens, 10);
            assert_eq!(usage.output_tokens, 5);
            assert_eq!(usage.total_tokens, 15);
            assert_eq!(*end_turn, Some(true));
        }
        other => panic!("expected completed event, got {other:?}"),
    }
}

#[tokio::test]
async fn chat_sse_tool_calls_aggregate_by_index() {
    let body = sse_body(&[
        json!({
            "id": "chatcmpl-2",
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": [
                    {"index": 0, "id": "call-abc", "type": "function",
                     "function": {"name": "she", "arguments": ""}},
                    {"index": 1, "id": "call-def", "type": "function",
                     "function": {"name": "other", "arguments": "{}"}},
                ]}
            }]
        }).to_string(),
        json!({
            "id": "chatcmpl-2",
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": [
                    {"index": 0, "function": {"arguments": "{\"command\":"}},
                    {"index": 0, "function": {"arguments": "[\"ls\"]}"}},
                ]}
            }]
        }).to_string(),
        json!({"id": "chatcmpl-2", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}).to_string(),
        "[DONE]".to_string(),
    ]);
    let events = collect_chat_events(body).await;

    // Tool calls are aggregated across the whole stream and emitted in index
    // order before the terminal Completed event.
    assert_eq!(events.len(), 3);
    match &events[0] {
        Ok(ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            ..
        })) => {
            assert_eq!(name, "she");
            assert_eq!(arguments, "{\"command\":[\"ls\"]}");
            assert_eq!(call_id, "call-abc");
        }
        other => panic!("expected first function call, got {other:?}"),
    }
    match &events[1] {
        Ok(ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            ..
        })) => {
            assert_eq!(name, "other");
            assert_eq!(arguments, "{}");
            assert_eq!(call_id, "call-def");
        }
        other => panic!("expected second function call, got {other:?}"),
    }
    assert_matches!(
        &events[2],
        Ok(ResponseEvent::Completed { end_turn, .. }) if *end_turn == Some(true)
    );
}

#[tokio::test]
async fn chat_sse_non_stream_json_gateway_fallback_via_single_chunk() {
    // A gateway that ignores stream:true returns one JSON blob. When it is
    // delivered without SSE framing the eventsource parser never emits data
    // events, so the stream ends and we produce the Completed event with no
    // aggregated items.
    let body = json!({
        "id": "chatcmpl-3",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    })
    .to_string();
    let events = collect_chat_events(body).await;
    // No SSE data events => no output items, but a terminal Completed event is
    // still emitted so the turn ends deterministically.
    assert_eq!(events.len(), 1);
    assert_matches!(&events[0], Ok(ResponseEvent::Completed { .. }));
}

#[test]
fn handle_chat_data_ignores_malformed_json() {
    let mut text_seen = false;
    let mut tool_calls = BTreeMap::new();
    let mut finish_reason = None;
    let mut response_id = None;
    let mut usage = None;
    let events = handle_chat_data(
        "not json",
        &mut text_seen,
        &mut tool_calls,
        &mut finish_reason,
        &mut response_id,
        &mut usage,
    );
    assert!(events.is_empty());
    assert!(!text_seen);
}

#[test]
fn finish_chat_stream_generates_synthetic_call_ids() {
    let mut tool_calls = BTreeMap::new();
    tool_calls.insert(
        0,
        super::PendingToolCall {
            id: String::new(),
            name: "shell".to_string(),
            arguments: "{}".to_string(),
        },
    );
    let events = finish_chat_stream(
        /*text_seen*/ false,
        &mut tool_calls,
        /*finish_reason*/ None,
        /*response_id*/ None,
        /*usage*/ None,
    );
    assert_eq!(events.len(), 2);
    match &events[0] {
        ResponseEvent::OutputItemDone(ResponseItem::FunctionCall { call_id, .. }) => {
            assert!(call_id.starts_with("call_"));
        }
        other => panic!("expected function call, got {other:?}"),
    }
    assert_matches!(&events[1], ResponseEvent::Completed { .. });
}

#[tokio::test]
async fn spawn_chat_response_stream_sets_upstream_request_id() {
    let body = sse_body(&[
        json!({"id": "chatcmpl-9", "choices": [{"index": 0, "delta": {"content": "ok"}}]}).to_string(),
        "[DONE]".to_string(),
    ]);
    let bytes = stream::iter(vec![Ok(bytes::Bytes::from(body))]);
    let stream_response = codex_client::StreamResponse {
        status: http::StatusCode::OK,
        headers: {
            let mut headers = http::HeaderMap::new();
            headers.insert("x-request-id", http::HeaderValue::from_static("req-77"));
            headers
        },
        bytes: Box::pin(bytes),
    };
    let mut api_stream = spawn_chat_response_stream(
        stream_response,
        Duration::from_millis(5_000),
        /*telemetry*/ None,
    );
    assert_eq!(api_stream.upstream_request_id.as_deref(), Some("req-77"));
    let mut events = Vec::new();
    while let Some(event) = api_stream.next().await {
        events.push(event.expect("event should be ok"));
    }
    assert!(matches!(
        events.last(),
        Some(ResponseEvent::Completed { .. })
    ));
}

#[tokio::test]
async fn chat_sse_stream_error_is_forwarded() {
    let byte_stream: codex_http_client::ByteStream = Box::pin(stream::iter(vec![
        Ok(bytes::Bytes::from_static(
            b"data: {\"id\": \"x\", \"choices\": []}\n\n",
        )),
        Err(TransportError::Network("reset".to_string())),
    ]));
    let (tx, mut rx) = mpsc::channel::<Result<ResponseEvent, ApiError>>(16);
    tokio::spawn(process_chat_sse(
        byte_stream,
        tx,
        Duration::from_millis(5_000),
        /*telemetry*/ None,
    ));
    let mut saw_error = false;
    while let Some(event) = rx.recv().await {
        if event.is_err() {
            saw_error = true;
        }
    }
    assert!(saw_error, "transport error should be surfaced as Err");
}
