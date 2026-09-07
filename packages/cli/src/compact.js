// Session compaction — replace old turns with an LLM summary when the context
// grows too large, preserving recent turns verbatim. Manual via /compact.
"use strict";

const { chatStream } = require("./llm/client");

/** rough context weight: chars/4 + images weight */
function estimateTokens(storage, sessionId) {
  const msgs = storage.getMessages(sessionId);
  let chars = 0;
  for (const m of msgs) {
    for (const p of m.parts || []) {
      if (p.type === "text") chars += (p.text || "").length;
      else if (p.type === "tool_result") chars += typeof p.content === "string" ? p.content.length : 200;
      else if (p.type === "image") chars += 1000;
      else if (p.type === "tool_use") chars += JSON.stringify(p.input || {}).length + 60;
    }
    chars += 20;
  }
  return { tokens: Math.ceil(chars / 4), messages: msgs.length };
}

async function summarize(provider, storage, sessionId, { keepRecent = 6 } = {}) {
  const msgs = storage.getMessages(sessionId);
  if (msgs.length <= keepRecent + 2) return { compacted: false, reason: "消息太少无需压缩" };

  const oldMsgs = msgs.slice(0, msgs.length - keepRecent);
  const transcript = oldMsgs.map((m) => {
    const role = m.role === "assistant" ? "助手" : m.role === "user" ? "用户" : "工具";
    const text = (m.parts || [])
      .map((p) => {
        if (p.type === "text") return p.text || "";
        if (p.type === "tool_use") return `[调用工具 ${p.name}]`;
        if (p.type === "tool_result") return `[结果] ${typeof p.content === "string" ? p.content.slice(0, 300) : ""}`;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .slice(0, 1500);
    return `${role}: ${text}`;
  }).join("\n").slice(0, 60000);

  const summaryRes = await chatStream({
    provider,
    system: "你是会话压缩器。把下面的对话历史压缩为一份结构化摘要, 供后续对话续接上下文。必须保留: 1) 用户的原始目标与所有约束 2) 已完成的关键步骤与结果 3) 重要文件/路径/命令 4) 未完成事项与下一步。用紧凑的中文要点列表, 不写客套话。",
    messages: [{ role: "user", parts: [{ type: "text", text: `对话历史:\n${transcript}\n\n请输出摘要:` }] }],
    tools: [],
    signal: undefined,
  });

  const summary = (summaryRes.text || "").trim() || "(摘要生成失败, 保留原状)";
  if (!summaryRes.text) return { compacted: false, reason: "摘要生成失败" };

  // Rewrite history: compacted marker + summary + recent messages verbatim
  storage.replaceMessages(sessionId, [
    { role: "user", parts: [{ type: "text", text: "[会话已压缩] 以下是此前对话的结构化摘要:\n\n" + summary }] },
    { role: "assistant", parts: [{ type: "text", text: "已了解压缩摘要, 继续任务。" }] },
    ...msgs.slice(msgs.length - keepRecent).map((m) => ({ role: m.role, parts: m.parts, createdAt: m.created_at })),
  ]);
  return { compacted: true, summary, replacedMessages: oldMsgs.length };
}

/** auto-compact check called before each turn */
async function maybeAutoCompact({ storage, sessionId, provider, config, emit }) {
  const threshold = (config && config.autoCompactThreshold) || 0.7;
  const ctxLimit = (config && config.contextWindow) || 128000;
  const { tokens, messages } = estimateTokens(storage, sessionId);
  if (tokens > ctxLimit * threshold && messages > 10) {
    emit && emit({ type: "compact_started", tokens, messages });
    const r = await summarize(provider, storage, sessionId, {});
    emit && emit({ type: "compact_done", ...r, tokensBefore: tokens });
    return r;
  }
  return { compacted: false };
}

module.exports = { estimateTokens, summarize, maybeAutoCompact };
