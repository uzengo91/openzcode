// Protocol dispatcher + connection test.
"use strict";

const { streamOpenAI, testOpenAI } = require("./openai");
const { streamAnthropic, testAnthropic } = require("./anthropic");

async function chatStream({ provider, system, messages, tools, signal, onDelta }) {
  if (!provider) throw new Error("未配置模型 provider — 请先在设置中添加并启用一个模型服务");
  if (provider.protocol === "anthropic") {
    return streamAnthropic({ provider, system, messages, tools, signal, onDelta });
  }
  return streamOpenAI({ provider, system, messages, tools, signal, onDelta });
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
