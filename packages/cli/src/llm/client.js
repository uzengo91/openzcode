// Protocol dispatcher + connection test.
"use strict";

const { streamOpenAI, testOpenAI } = require("./openai");
const { streamAnthropic, testAnthropic } = require("./anthropic");

/** retry helper for connection-stage failures (429/5xx): exp backoff, max 3 retries */
async function openConnectionWithRetry(send, signal, { maxRetries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await send();
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt < maxRetries && (e?.cause || e?.message) && /fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND|aborted|timeout/i.test(`${e.message} ${e.cause?.code || ""}`)) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1500 * attempt + Math.random() * 800));
        continue;
      }
      throw e;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      attempt++;
      const retryableBody = await res.text().catch(() => "");
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt + Math.random() * 1000, 15000)));
      continue;
    }
    return res; // let caller produce the error with body
  }
}

async function chatStream({ provider, system, messages, tools, signal, onDelta }) {
  if (!provider) throw new Error("未配置模型 provider — 请先在设置中添加并启用一个模型服务");
  if (provider.protocol === "anthropic") {
    return streamAnthropic({ provider, system, messages, tools, signal, onDelta, openConnection: openConnectionWithRetry });
  }
  return streamOpenAI({ provider, system, messages, tools, signal, onDelta, openConnection: openConnectionWithRetry });
}

async function testProvider(provider, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("连接测试超时")), timeoutMs);
  try {
    const fn = provider.protocol === "anthropic" ? testAnthropic : testOpenAI;
    return await fn(provider, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatStream, testProvider };
