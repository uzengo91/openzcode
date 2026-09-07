use std::sync::Arc;

use codex_core::ModelClient;
use codex_core::Prompt;
use codex_core::ResponseEvent;
use codex_features::Feature;
use codex_login::auth::AgentIdentityAuthPolicy;
use codex_model_provider_info::ModelProviderInfo;
use codex_model_provider_info::WireApi;
use codex_otel::SessionTelemetry;
use codex_protocol::ThreadId;
use codex_protocol::config_types::ReasoningSummary;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::SessionSource;
use core_test_support::TestCodexResponsesRequestKind;
use core_test_support::load_default_config_for_test;
use core_test_support::responses_metadata as test_responses_metadata;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event;
use assert_matches::assert_matches;
use futures::StreamExt;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::matchers::method;
use wiremock::matchers::path;

const TEST_INSTALLATION_ID: &str = "11111111-1111-8111-8111-111111111111";

/// Builds a chat-wire provider pointed at the mock server.
fn chat_provider(base_url: String) -> ModelProviderInfo {
    ModelProviderInfo {
        name: "mock-chat".into(),
        base_url: Some(base_url),
        env_key: None,
        env_key_instructions: None,
        experimental_bearer_token: None,
        auth: None,
        aws: None,
        wire_api: WireApi::Chat,
        query_params: None,
        http_headers: None,
        env_http_headers: None,
        request_max_retries: Some(0),
        stream_max_retries: Some(0),
        stream_idle_timeout_ms: Some(10_000),
        websocket_connect_timeout_ms: None,
        requires_openai_auth: false,
        supports_websockets: false,
        supports_standalone_web_search: false,
    }
}

fn sse_body(events: Vec<serde_json::Value>) -> String {
    let mut body = String::new();
    for data in events {
        body.push_str("data: ");
        body.push_str(&data.to_string());
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    body
}

fn simple_chat_body(text: &str) -> String {
    sse_body(vec![
        json!({
            "id": "chatcmpl-test",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}}]
        }),
        json!({
            "id": "chatcmpl-test",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
        }),
    ])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_wire_api_sends_chat_completions_request_and_completes() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(simple_chat_body("hello world")),
        )
        .expect(1)
        .mount(&server)
        .await;

    let base_url = format!("{}/v1", server.uri());
    let test = test_codex()
        .with_config(move |config| {
            config.model_provider = chat_provider(base_url);
        })
        .build(&server)
        .await
        .unwrap();

    test.submit_turn("hi").await.unwrap();

    let turn_complete =
        wait_for_event(&test.codex, |event| matches!(event, EventMsg::TurnComplete(_))).await;
    let EventMsg::TurnComplete(complete) = turn_complete else {
        panic!("expected TurnComplete");
    };
    assert!(
        complete.error.is_none(),
        "turn error: {:?}",
        complete.error
    );

    let requests = server.received_requests().await.expect("requests recorded");
    let chat_request = requests
        .iter()
        .find(|request| request.url.path() == "/chat/completions")
        .expect("chat/completions request should be captured");
    let body: serde_json::Value = serde_json::from_slice(&chat_request.body).unwrap();

    // Request must be chat format.
    assert_eq!(body["model"].as_str(), Some("gpt-5.5"));
    assert_eq!(body["stream"], json!(true));
    assert_eq!(
        body["stream_options"],
        json!({"include_usage": true}),
        "stream_options.include_usage must be requested for usage accounting"
    );
    let messages = body["messages"].as_array().expect("messages array");
    assert!(
        messages
            .iter()
            .any(|message| message["role"] == json!("system")),
        "base instructions must map to a system message"
    );
    assert!(
        messages
            .iter()
            .any(|message| message["role"] == json!("user")),
        "user input must map to a user message"
    );
    // No Responses-API-specific fields may leak into the chat request.
    assert!(body.get("input").is_none());
    assert!(body.get("instructions").is_none());
    assert!(body.get("previous_response_id").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_wire_api_tool_call_round_trip() {
    let server = MockServer::start().await;
    // First response streams a tool call; second responds with text.
    let tool_call_body = sse_body(vec![
        json!({
            "id": "chatcmpl-tool",
            "choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "id": "call-xyz", "type": "function",
                 "function": {"name": "shell", "arguments": "{\"command\""}}
            ]}}]
        }),
        json!({
            "id": "chatcmpl-tool",
            "choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": ":[\"echo hi\"]}"}}
            ]}}]
        }),
        json!({
            "id": "chatcmpl-tool",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]
        }),
    ]);
    let completion_body = sse_body(vec![
        json!({
            "id": "chatcmpl-final",
            "choices": [{"index": 0, "delta": {"content": "done"}}]
        }),
        json!({
            "id": "chatcmpl-final",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 2, "total_tokens": 22}
        }),
    ]);

    // Mount ordered responses: first the tool call, then the completion.
    struct SeqResponder {
        num_calls: std::sync::atomic::AtomicUsize,
    }
    impl wiremock::Respond for SeqResponder {
        fn respond(&self, _: &wiremock::Request) -> wiremock::ResponseTemplate {
            use std::sync::atomic::Ordering;
            let call = self.num_calls.fetch_add(1, Ordering::SeqCst);
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(if call == 0 {
                    tool_call_body.clone()
                } else {
                    completion_body.clone()
                })
        }
    }
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(SeqResponder {
            num_calls: std::sync::atomic::AtomicUsize::new(0),
        })
        .expect(2)
        .mount(&server)
        .await;

    let base_url = format!("{}/v1", server.uri());
    let test = test_codex()
        .with_config(move |config| {
            config.model_provider = chat_provider(base_url);
        })
        .build(&server)
        .await
        .unwrap();

    test.submit_turn("run echo").await.unwrap();
    wait_for_event(&test.codex, |event| matches!(event, EventMsg::TurnComplete(_))).await;

    let requests = server.received_requests().await.expect("requests recorded");
    assert_eq!(requests.len(), 2, "tool call must trigger a follow-up request");

    // The second request must carry the assistant tool_calls message and the
    // matching tool output message from the first response.
    let second: serde_json::Value =
        serde_json::from_slice(&requests[1].body).unwrap();
    let messages = second["messages"].as_array().expect("messages");
    let has_tool_calls_message = messages.iter().any(|message| {
        message["role"] == json!("assistant")
            && message["tool_calls"]
                .as_array()
                .is_some_and(|calls| !calls.is_empty())
    });
    assert!(
        has_tool_calls_message,
        "second request should replay the aggregated tool call: {second}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message["role"] == json!("tool")),
        "second request should include the tool output message"
    );
}

/// Direct ModelClient test: request body shape and response event mapping.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_wire_api_model_client_stream_events() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(simple_chat_body("hello ")),
        )
        .expect(1)
        .mount(&server)
        .await;

    let codex_home = TempDir::new().expect("failed to create TempDir");
    let mut config = load_default_config_for_test(&codex_home).await;
    config.model_provider = chat_provider(format!("{}/v1", server.uri()));
    let config = Arc::new(config);

    let thread_id = ThreadId::new();
    let session_source = SessionSource::Cli;
    let model_info =
        codex_core::test_support::construct_model_info_offline("gpt-5.5", &config);
    let session_telemetry = SessionTelemetry::new(
        thread_id,
        "gpt-5.5",
        model_info.slug.as_str(),
        /*account_id*/ None,
        /*account_email*/ None,
        /*auth_mode*/ None,
        "test_originator".to_string(),
        /*log_user_prompts*/ false,
        "test".to_string(),
        session_source.clone(),
    );

    let client = ModelClient::new(
        /*auth_manager*/ None,
        AgentIdentityAuthPolicy::JwtOnly,
        thread_id,
        config.model_provider.clone(),
        session_source.clone(),
        "test_originator".to_string(),
        config.model_verbosity,
        config.features.enabled(Feature::ContentItemKinds),
        /*enable_request_compression*/ false,
        /*include_timing_metrics*/ false,
        /*beta_features_header*/ None,
        /*concurrent_reasoning_summaries_enabled*/ false,
        /*attestation_provider*/ None,
        config.http_client_factory(),
    );
    let responses_metadata = {
        let thread = thread_id.to_string();
        test_responses_metadata(
            TEST_INSTALLATION_ID,
            &thread,
            &thread,
            /*turn_id*/ None,
            format!("{thread}:0"),
            &session_source,
            /*parent_thread_id*/ None,
            TestCodexResponsesRequestKind::Turn,
        )
    };
    let mut client_session = client.new_session();

    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".into(),
            content: vec![ContentItem::InputText {
                text: "hello".into(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: "be brief".into(),
            provenance: None,
        },
        ..Default::default()
    };

    let mut stream = client_session
        .stream(
            &prompt,
            &model_info,
            &session_telemetry,
            /*effort*/ None,
            ReasoningSummary::None,
            /*service_tier*/ None,
            &responses_metadata,
            &codex_rollout_trace::InferenceTraceContext::disabled(),
        )
        .await
        .expect("chat stream should start");

    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        let event = event.expect("stream event should be ok");
        let is_completed = matches!(event, ResponseEvent::Completed { .. });
        events.push(event);
        if is_completed {
            break;
        }
    }

    // Event sequence: one text delta, then Completed.
    assert_eq!(events.len(), 2, "events: {events:?}");
    assert_matches!(
        &events[0],
        ResponseEvent::OutputTextDelta(delta) if delta == "hello "
    );
    match &events[1] {
        ResponseEvent::Completed {
            response_id,
            token_usage,
            end_turn,
            ..
        } => {
            assert_eq!(response_id, "chatcmpl-test");
            let usage = token_usage.as_ref().expect("usage from include_usage");
            assert_eq!(usage.input_tokens, 12);
            assert_eq!(usage.output_tokens, 4);
            assert_eq!(usage.total_tokens, 16);
            assert_eq!(*end_turn, Some(true));
        }
        other => panic!("expected completed, got {other:?}"),
    }

    let requests = server.received_requests().await.expect("requests");
    let chat_request = requests
        .iter()
        .find(|request| request.url.path() == "/chat/completions")
        .expect("chat request");
    let body: serde_json::Value = serde_json::from_slice(&chat_request.body).unwrap();
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], json!("system"));
    assert_eq!(messages[0]["content"], json!("be brief"));
    assert_eq!(messages[1]["role"], json!("user"));
    assert_eq!(messages[1]["content"], json!("hello"));
    assert_eq!(body["stream_options"], json!({"include_usage": true}));
    assert_eq!(body["model"], json!("gpt-5.5"));
}
