// Anthropic Messages-compatible client (SSE streaming + tool_use), mirroring
// the protocol ZCode uses for its coding-plan endpoints.
"use strict";

const { joinUrl, parseError } = require("./openai");

function toAnthropicMessages(messages, { imageWindow = 3 } = {}) {
  const lastImgIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i].parts || []).some((p) => p.type === "image") || (messages[i].parts || []).some((p) => (p.images || []).length)) return i;
    }
    return -1;
  })();
  const keepFrom = lastImgIdx === -1 ? messages.length : Math.max(0, messages.length - imageWindow);
  const out = [];
  const pushUser = (blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };
  messages.forEach((m, i) => {
    const keep = i >= keepFrom;
    if (m.role === "user") {
      const blocks = [];
      for (const p of m.parts || []) {
        if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
        else if (p.type === "image" && keep) blocks.push({ type: "image", source: { type: "base64", media_type: p.mime || "image/png", data: p.data } });
      }
      if (blocks.length) pushUser(blocks);
    } else if (m.role === "assistant") {
      const content = [];
      for (const p of m.parts || []) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        else if (p.type === "tool_use") content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const blocks = [];
      for (const p of m.parts || []) {
        if (p.type === "tool_result") {
          const inner = [];
          const txt = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
          if (txt) inner.push({ type: "text", text: txt });
          for (const img of p.images || []) {
            inner.push(keep
              ? { type: "image", source: { type: "base64", media_type: img.mime || "image/png", data: img.data } }
              : { type: "text", text: "[截图已省略]" });
          }
          blocks.push({ type: "tool_result", tool_use_id: p.tool_use_id, content: inner, is_error: !!p.is_error });
        }
      }
      if (blocks.length) pushUser(blocks);
    }
  });
  return out;
}

function messagesUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

async function streamAnthropic({ provider, system, messages, tools, signal, onDelta, openConnection }) {
  const body = {
    model: provider.model,
    max_tokens: 8192,
    stream: true,
    messages: toAnthropicMessages(messages),
  };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name, description: t.description, input_schema: t.parameters,
    }));
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (provider.apiKey) {
    headers["x-api-key"] = provider.apiKey;
    headers.authorization = `Bearer ${provider.apiKey}`;
  }

  const send = () => fetch(messagesUrl(provider.baseUrl), {
    method: "POST", headers, body: JSON.stringify(body), signal,
  });
  const res = openConnection ? await openConnection(send, signal) : await send();
  if (!res.ok) throw new Error(await parseError(res));

  const textChunks = [];
  const blocks = new Map(); // index -> {type, id, name, json}
  let usage = { promptTokens: 0, completionTokens: 0 };
  let stopReason = null;

  let buf = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(dataStr); } catch { continue; }

      if (ev.type === "message_start" && ev.message?.usage) {
        usage.promptTokens = ev.message.usage.input_tokens ?? 0;
      } else if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        blocks.set(ev.index, { type: cb.type, id: cb.id, name: cb.name, json: "" });
      } else if (ev.type === "content_block_delta") {
        const b = blocks.get(ev.index);
        const d = ev.delta || {};
        if (d.type === "text_delta" && d.text) {
          textChunks.push(d.text);
          onDelta && onDelta({ type: "text", text: d.text });
        } else if (d.type === "input_json_delta" && b) {
          b.json += d.partial_json || "";
        }
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) usage.completionTokens = ev.usage.output_tokens;
      }
    }
  }

  const toolCalls = [...blocks.entries()].sort((a, b) => a[0] - b[0])
    .filter(([, b]) => b.type === "tool_use")
    .map(([i, b]) => {
      let input = {};
      try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _raw: b.json }; }
      return { id: b.id || `toolu_${i}`, name: b.name, input };
    });

  return { text: textChunks.join(""), toolCalls, finishReason: stopReason, usage };
}

async function testAnthropic(provider, signal) {
  // Minimal real request: 1-token completion proves endpoint+key+model work.
  const res = await fetch(messagesUrl(provider.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider.apiKey || "",
      authorization: `Bearer ${provider.apiKey || ""}`,
    },
    body: JSON.stringify({ model: provider.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
    signal,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return { ok: true, models: [] };
}

module.exports = { streamAnthropic, testAnthropic, toAnthropicMessages, messagesUrl };
