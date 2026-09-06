// OpenZCode CI smoke test — NO network / NO LLM required.
// Verifies the built bundle in app-server mode: RPC protocol, config registry,
// session lifecycle, storage layout, error framing, robustness to garbage input.
// Usage: node scripts/test-ci.mjs   (bundle path via OPENZCODE_BUNDLE, default repo dist)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = process.env.OPENZCODE_BUNDLE || path.join(ROOT, "packages/cli/dist/openzcode.cjs");

if (!fs.existsSync(BUNDLE)) {
  console.error(`✗ bundle 不存在: ${BUNDLE} (先运行 npm run build:cli)`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openzcode-ci-"));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
};

const child = spawn(process.execPath, [BUNDLE, "app-server", "--stdio"], {
  env: { ...process.env, OPENZCODE_CONFIG_DIR: path.join(tmp, "data"), OPENZCODE_WORKSPACE: ws },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const events = [];
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : resolve(msg.result);
  } else if (msg.method === "session/event") {
    events.push(msg.params);
  }
});

const request = (method, params, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

try {
  console.log("== OpenZCode CI smoke (无 LLM) ==");
  const info = await request("initialize", {});
  check("initialize 握手", info.protocolVersion >= 1 && !!info.version);
  check("bundle 为单文件产物", fs.statSync(BUNDLE).size > 10000, `${BUNDLE}`);

  // error framing
  try { await request("no/such/method", {}); check("未知方法应报错", false); }
  catch (e) { check("未知方法返回 -32601", e.code === -32601, `code=${e.code}`); }

  // config registry (fake provider, masked echo)
  const cfg = await request("config/setProvider", {
    name: "fake", baseUrl: "https://ci-invalid.local/v1", apiKey: "sk-test-1234567890",
    model: "dummy-model", protocol: "openai", setDefault: true,
  });
  check("provider 保存 + 默认标记", cfg.providers.length === 1 && cfg.defaultProviderId === cfg.providers[0].id);
  check("apiKey 脱敏回显", !JSON.stringify(cfg).includes("sk-test-1234567890"));

  const test = await request("config/testProvider", { idOrName: "fake" }, 30000);
  check("不可达端点测试返回 ok:false", test.ok === false, test.message);

  // session lifecycle + storage
  const session = await request("session/create", { workspace: ws });
  check("session/create", !!session.id);
  const msgs = await request("session/messages", { sessionId: session.id });
  check("session/messages 空列表", Array.isArray(msgs) && msgs.length === 0);
  const list = await request("session/list", { workspace: ws });
  check("session/list", list.some((s) => s.id === session.id));

  // turn against an unreachable provider → fast turn_done{ok:false} (not a crash)
  events.length = 0;
  await request("session/send", { sessionId: session.id, text: "hi" });
  const ev = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const done = events.find((e) => e.event?.type === "turn_done");
      if (done) { clearInterval(iv); resolve(done.event); }
      else if (Date.now() - t0 > 30000) { clearInterval(iv); resolve(null); }
    }, 200);
  });
  check("不可达 provider 时回合快速失败且不崩溃", ev && ev.ok === false, JSON.stringify(ev)?.slice(0, 120));
  const msgs2 = await request("session/messages", { sessionId: session.id });
  check("用户消息已持久化", msgs2.some((m) => m.role === "user"));

  // garbage input robustness
  child.stdin.write("this is not json\n\n\n");
  await new Promise((r) => setTimeout(r, 300));
  const still = await request("server/info", {});
  check("垃圾输入后 RPC 仍存活", !!still.version);

  // storage layout on disk
  check("SQLite 数据库已创建", fs.existsSync(path.join(tmp, "data", "db.sqlite")) || fs.existsSync(path.join(tmp, "data", "db.json")));

  // session/delete
  await request("session/delete", { sessionId: session.id });
  const list2 = await request("session/list", { workspace: ws });
  check("session/delete", !list2.some((s) => s.id === session.id));

  console.log(`\n== CI 结果: ${passed} 通过, ${failed} 失败 ==`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\n✗ CI 测试失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
