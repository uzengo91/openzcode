// OpenAI-compatible chat-completions client with SSE streaming + tool calls.
// Normalized internal message format (see agent/loop.js):
//   {role: "user"|"assistant"|"tool", parts: [
//      {type:"text", text} |
//      {type:"tool_use", id, name, input} |
//      {type:"tool_result", tool_use_id, content, is_error}]}
"use strict";

function toOpenAIMessages(system, messages, { imageWindow = 3 } = {}) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  const lastTextIdx = (() => {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0 && messages.length - i <= imageWindow; i--) {
      if ((messages[i].parts || []).some((p) => p.type === "image")) { idx = i; break; }
    }
    return idx === -1 ? messages.length : idx; // keep images from this index onward
  })();
  messages.forEach((m, i) => {
    const keepImages = i >= lastTextIdx;
    if (m.role === "user") {
      out.push({ role: "user", content: partsToOpenAIContent(m.parts, keepImages) });
    } else if (m.role === "assistant") {
      const text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
      const toolUses = (m.parts || []).filter((p) => p.type === "tool_use");
      const msg = { role: "assistant", content: text || (toolUses.length ? null : "") };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id, type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      for (const p of m.parts || []) {
        if (p.type === "tool_result") {
          const contentParts = [];
          if (p.text !== undefined || p.content !== undefined) {
            const txt = typeof (p.content ?? p.text) === "string" ? (p.content ?? p.text) : JSON.stringify(p.content ?? p.text);
            contentParts.push({ type: "text", text: txt });
          }
          for (const img of p.images || []) contentParts.push(imageToOpenAI(img, keepImages));
          out.push({ role: "tool", tool_call_id: p.tool_use_id, content: contentParts });
        }
      }
    }
  });
  return out;
}

function imageToOpenAI(img, keep) {
  if (!keep) return { type: "text", text: "[截图已省略]" };
  return { type: "image_url", image_url: { url: `data:${img.mime || "image/png"};base64,${img.data}` } };
}

function partsToOpenAIContent(parts, keepImages) {
  const blocks = [];
  for (const p of parts || []) {
    if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
    else if (p.type === "image") blocks.push(imageToOpenAI(p, keepImages));
  }
  if (!blocks.length) return "";
  if (blocks.every((b) => b.type === "text")) return blocks.map((b) => b.text).join("\n");
  return blocks;
}

function joinUrl(base, suffix) {
  return base.replace(/\/+$/, "") + suffix;
}

async function parseError(res) {
  let body = "";
  try { body = await res.text(); } catch {}
  const snippet = body.length > 500 ? body.slice(0, 500) + "…" : body;
  return `HTTP ${res.status} ${res.statusText}: ${snippet}`;
}

function makeSseParser(onEvent) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { onEvent(null, true); return; }
      try { onEvent(JSON.parse(data), false); } catch {}
    }
  };
}

async function streamOpenAI({ provider, system, messages, tools, signal, onDelta, openConnection }) {
  const body = {
    model: provider.model,
    messages: toOpenAIMessages(system, messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const headers = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const send = () => fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
    method: "POST", headers, body: JSON.stringify(body), signal,
  });
  const res = openConnection ? await openConnection(send, signal) : await send();
  if (!res.ok) throw new Error(await parseError(res));

  const textChunks = [];
  const toolAcc = new Map(); // index -> {id, name, arguments}
  let usage = null;
  let finishReason = null;

  const handleData = (data, done) => {
    if (done) return;
    if (data.usage) usage = data.usage;
    const choice = data.choices && data.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      textChunks.push(delta.content);
      onDelta && onDelta({ type: "text", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = typeof tc.index === "number" ? tc.index : 0;
        if (!toolAcc.has(i)) toolAcc.set(i, { id: null, name: "", arguments: "" });
        const acc = toolAcc.get(i);
        if (tc.id) acc.id = tc.id;
        if (tc.function) {
          if (tc.function.name) acc.name += tc.function.name;
          if (typeof tc.function.arguments === "string") acc.arguments += tc.function.arguments;
        }
      }
    }
  };

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("text/event-stream")) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const push = makeSseParser(handleData);
    // idle timeout: abort if no bytes arrive for a while (server accepted the
    // connection but stalls) — prevents turns hanging forever
    const idleMs = Number(process.env.OPENZCODE_STREAM_IDLE_TIMEOUT_MS) || 90000;
    for (;;) {
      const idle = setTimeout(() => reader.cancel(new Error(`流空闲超时 (${idleMs}ms 无数据)`)), idleMs);
      let done, chunk;
      try {
        ({ done, value: chunk } = await reader.read());
      } catch (e) {
        clearTimeout(idle);
        if (textChunks.length || toolAcc.size) break; // got partial data, treat as end
        throw new Error(`模型流中断: ${e.message || e}`);
      }
      clearTimeout(idle);
      if (done) break;
      push(decoder.decode(chunk, { stream: true }));
    }
    push(decoder.decode());
  } else {
    // Gateway ignored stream:true — fall back to a single JSON payload.
    const data = await res.json();
    handleData({
      choices: [{
        delta: data.choices?.[0]?.message || {},
        finish_reason: data.choices?.[0]?.finish_reason,
      }],
      usage: data.usage,
    }, false);
  }

  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([i, acc]) => {
    let input = {};
    try { input = acc.arguments ? JSON.parse(acc.arguments) : {}; } catch { input = { _raw: acc.arguments }; }
    return { id: acc.id || `call_${i}`, name: acc.name, input };
  });

  return {
    text: textChunks.join(""),
    toolCalls,
    finishReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 }
      : { promptTokens: 0, completionTokens: 0 },
  };
}

async function testOpenAI(provider, signal) {
  const headers = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetch(joinUrl(provider.baseUrl, "/models"), { headers, signal });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  const models = (data.data || []).map((m) => m.id).slice(0, 50);
  return { ok: true, models };
}

module.exports = { streamOpenAI, testOpenAI, toOpenAIMessages, joinUrl, parseError };
