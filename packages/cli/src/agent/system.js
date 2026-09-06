// System prompt builder: identity + workspace context + AGENTS.md injection.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { VERSION, APP_NAME } = require("../version");

function buildSystemPrompt({ workspace, toolNames }) {
  const lines = [];
  lines.push(`You are ${APP_NAME}, an interactive coding agent (MVP, v${VERSION}).`);
  lines.push(`你在一个终端/桌面应用中帮助用户完成软件工程任务：阅读与修改代码、执行命令、维护任务清单。`);
  lines.push("");
  lines.push(`# 运行环境`);
  lines.push(`- 今天日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 工作目录: ${workspace}`);
  lines.push(`- 平台: ${os.platform()} ${os.arch()}, Node ${process.version}`);
  lines.push(`- 工作目录之外的绝对路径也可以读写，但修改类操作需要用户批准（ask 模式下）。`);
  lines.push("");
  lines.push(`# 工作准则`);
  lines.push(`1. 先理解再动手：改代码前先 read_file / grep 确认现状，不要凭空猜测文件内容。`);
  lines.push(`2. 多步骤任务先用 todo_write 建立清单，完成一项更新一项；不要重复劳动。`);
  lines.push(`3. 编辑文件用 edit_file 做精确替换，old_string 必须逐字符匹配；新建文件用 write_file。`);
  lines.push(`4. 运行命令用 bash；破坏性命令（删除、覆盖、推送）先向用户说明。`);
  lines.push(`5. 回复使用与用户一致的语言（通常为中文），保持简洁、结论先行。`);
  lines.push(`6. 任务完成后简要汇报结果；测试失败要如实说明。`);
  if (toolNames && toolNames.length) {
    lines.push("");
    lines.push(`# 可用工具`);
    lines.push(toolNames.join(", "));
  }

  // AGENTS.md / CLAUDE.md instruction files (workspace conventions)
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(workspace, name);
    try {
      const content = fs.readFileSync(p, "utf8").trim();
      if (content) {
        lines.push("");
        lines.push(`# ${name} (工作区约定, 自动注入)`);
        lines.push(content.slice(0, 4000));
        break;
      }
    } catch {}
  }
  return lines.join("\n");
}

module.exports = { buildSystemPrompt };
