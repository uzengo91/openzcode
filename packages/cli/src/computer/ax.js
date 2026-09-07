// Element-level (semantic) computer control — macOS AX via osascript,
// Windows UIA via PowerShell, Linux graceful degradation.
// All functions resolve refs through a short-lived element-tree cache.
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

function run(file, args, { timeout = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, err, stdout, stderr });
    });
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

/* ---------------- mac: AppleScript element tree ---------------- */

// AppleScript that walks a process's UI tree and emits JSON-ish lines.
// We build it with a recursive handler; depth cap 6, element cap 200.
function macTreeScript(appName, maxElements) {
  const filter = appName
    ? `if (name of proc contains "${appName.replace(/"/g, '\\"')}") or ("${appName.replace(/"/g, '\\"')}" contains name of proc) then set procList to {proc}`
    : `set procList to {proc}`;
  return `on run
  tell application "System Events"
    set out to ""
    set n to 0
    set frontProc to first application process whose frontmost is true
    set proc to frontProc
    ${appName ? `set procList to every application process whose name contains "${appName.replace(/"/g, '\\"')}"` : `set procList to {frontProc}`}
    repeat with p in procList
      set pname to name of p
      set out to out & "PROC|" & pname & "|" & (frontmost of p as text) & linefeed
      repeat with w in windows of p
        set wname to ""
        try
          set wname to name of w
        end try
        set wpos to position of w
        set wsize to size of w
        set out to out & "WIN|" & wname & "|" & ((item 1 of wpos) as text) & "," & ((item 2 of wpos) as text) & "|" & ((item 1 of wsize) as text) & "," & ((item 2 of wsize) as text) & linefeed
        set out to walk(p, w, "  ", out, n, ${maxElements})
      end repeat
    end repeat
    return out
  end tell
end run

on walk(proc, el, indent, out, n, cap)
  tell application "System Events"
    try
      set kids to UI elements of el
    on error
      return out
    end try
    repeat with k in kids
      if n ≥ cap then return out
      set r to ""
      try
        set r to role of k
      end try
      set nm to ""
      try
        set nm to name of k
      end try
      if nm is missing value or nm is "" then
        try
          set nm to title of k
        end try
      end if
      if nm is missing value then set nm to ""
      set vl to ""
      try
        set vl to value of k as text
      end try
      if vl is missing value then set vl to ""
      set ps to ""
      try
        set ps to (position of k)
      end try
      set sz to ""
      try
        set sz to (size of k)
      end try
      set act to ""
      try
        set actList to actions of k
        repeat with a in actList
          set act to act & (name of a) & " "
        end repeat
      end try
      set ln to indent & "EL|" & r & "|" & (nm as text) & "|" & (vl as text) & "|"
      try
        set ln to ln & ((item 1 of ps) as text) & "," & ((item 2 of ps) as text) & "|" & ((item 1 of sz) as text) & "," & ((item 2 of sz) as text) & "|" & act
      end try
      set out to out & indent & ln & linefeed
      set n to n + 1
      if n < cap then
        set out to my walk(proc, k, indent & "  ", out, n, cap)
      end if
    end repeat
  end tell
  return out
end walk`;
}

/* macOS: CGWindowList helper — window titles need only the screen-recording
 * permission (no Accessibility). Compiled once into tmpdir. */
let winlistBin = null;
async function ensureWinlist() {
  if (winlistBin) return winlistBin;
  const bin = path.join(os.tmpdir(), `openzcode-winlist-${process.getuid ? process.getuid() : 0}`);
  try { if (fs.existsSync(bin)) { winlistBin = bin; return bin; } } catch {}
  const src = [
    "#include <CoreGraphics/CoreGraphics.h>",
    "#include <CoreFoundation/CoreFoundation.h>",
    "#include <stdio.h>",
    'static void getstr(CFStringRef s, char *buf, int n) { buf[0] = 0; if (s) CFStringGetCString(s, buf, n, kCFStringEncodingUTF8); }',
    "int main() {",
    "  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);",
    "  for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {",
    "    CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);",
    "    int layer = -1; CFNumberRef lr = CFDictionaryGetValue(w, kCGWindowLayer);",
    "    if (lr) CFNumberGetValue(lr, kCFNumberIntType, &layer);",
    "    if (layer != 0) continue;",
    '    char owner[256] = "?", title[1024] = "";',
    "    getstr(CFDictionaryGetValue(w, kCGWindowOwnerName), owner, 256);",
    "    getstr(CFDictionaryGetValue(w, kCGWindowName), title, 1024);",
    "    double x=0,y=0,ww=0,hh=0; CFDictionaryRef b = CFDictionaryGetValue(w, kCGWindowBounds); CFNumberRef n;",
    '    if (b) { if ((n = CFDictionaryGetValue(b, CFSTR("X")))) CFNumberGetValue(n, kCFNumberDoubleType, &x);',
    '      if ((n = CFDictionaryGetValue(b, CFSTR("Y")))) CFNumberGetValue(n, kCFNumberDoubleType, &y);',
    '      if ((n = CFDictionaryGetValue(b, CFSTR("Width")))) CFNumberGetValue(n, kCFNumberDoubleType, &ww);',
    '      if ((n = CFDictionaryGetValue(b, CFSTR("Height")))) CFNumberGetValue(n, kCFNumberDoubleType, &hh); }',
    '    printf("%s | %s | (%d,%d) %dx%d\\n", owner, title[0]?title:"(无标题)", (int)x,(int)y,(int)ww,(int)hh);',
    "  }",
    "  return 0;",
    "}",
  ].join("\n");
  const compile = await run("/usr/bin/clang", ["-framework", "CoreGraphics", "-framework", "CoreFoundation", "-x", "c", "-", "-o", bin], { timeout: 60000, input: src });
  if (compile.code === 0 && fs.existsSync(bin)) { winlistBin = bin; return bin; }
  return null;
}

async function macWindowList() {
  const bin = await ensureWinlist();
  if (bin) {
    const r = await run(bin, [], { timeout: 10000 });
    if (r.code === 0 && r.stdout.trim()) return { ok: true, output: r.stdout.trim() };
  }
  // degraded: System Events (needs Accessibility)
  const script = 'tell application "System Events" to get {name, name of windows} of (every application process whose visible is true)';
  const r = await run("osascript", ["-e", script], { timeout: 15000 });
  if (r.code === 0 && r.stdout.trim()) return { ok: true, output: r.stdout.trim() };
  return { ok: false, output: "无法枚举窗口 — 需要屏幕录制或辅助功能权限" };
}

/* element cache: appHint → { at, lines } (10s) */
const cache = new Map();
const CACHE_MS = 10000;

async function macAppState(appHint, maxElements = 200) {
  const script = macTreeScript(appHint || null, maxElements);
  const r = await run("osascript", ["-e", script], { timeout: 20000 });
  if (r.code !== 0) {
    const msg = (r.stderr || r.err?.message || "").trim();
    if (/assistive access|not allowed/i.test(msg)) {
      return { ok: false, error: "辅助功能权限未授予", hint: "系统设置 → 隐私与安全性 → 辅助功能 → 勾选运行 OpenZCode 引擎的终端/Electron" };
    }
    return { ok: false, error: msg.slice(0, 300) || "osascript 失败" };
  }
  return { ok: true, text: r.stdout || "(空树)" };
}

/* ---------------- win: UIA via PowerShell ---------------- */

function winTreeScript(appHint) {
  const filter = appHint
    ? `$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match "${appHint.replace(/'/g, "''")}" }`
    : `$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 5`;
  return `
Add-Type -AssemblyName UIAutomationClient
${filter}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  $name = $el.Current.Name
  $pid2 = $el.Current.ProcessId
  $pname = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
  if ("${(appHint || "").replace(/'/g, "''")}" -ne "" -and $pname -notmatch "${(appHint || "").replace(/'/g, "''")}") { continue }
  Write-Output ("WIN|" + $name + "|" + $el.Current.BoundingRectangle.X + "," + $el.Current.BoundingRectangle.Y + "|" + $el.Current.BoundingRectangle.Width + "," + $el.Current.BoundingRectangle.Height + "|" + $pname)
  $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $i = 0
  foreach ($k in $kids) {
    if ($i -ge 200) { break }
    $kn = $k.Current.Name
    $kt = $k.Current.ControlType.ProgrammaticName
    $kv = ""
    try { $kv = $k.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    $r = $k.Current.BoundingRectangle
    Write-Output ("EL|" + $kt + "|" + $kn + "|" + $kv + "|" + $r.X + "," + $r.Y + "|" + $r.Width + "," + $r.Height)
    $i++
  }
}`;
}

async function winAppState(appHint) {
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", winTreeScript(appHint)], { timeout: 30000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.err?.message || "").slice(0, 300) };
  return { ok: true, text: r.stdout || "(空树)" };
}

/* ---------------- unified appState + cache + ref index ---------------- */

function formatTree(raw, appHint) {
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  const elements = [];
  let refN = 0;
  let winCount = 0;
  for (const line of lines) {
    if (line.startsWith("PROC|") || line.startsWith("WIN|")) {
      out.push(line.replace("PROC|", "应用: ").replace(/\\|/g, " "));
      if (line.startsWith("WIN|")) {
        winCount++;
        const parts = line.split("|");
        out.push(`  窗口: "${parts[1]}" @ (${parts[2]}) 尺寸(${parts[3]})`);
      }
      continue;
    }
    const m = /^\s*EL\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
    if (!m) continue;
    const [, role, name, value, pos, size, actions] = m;
    refN++;
    const ref = `e${refN}`;
    elements.push({ ref, role, name, value, pos, size, actions: actions.trim().split(/\s+/).filter(Boolean) });
    out.push(`  [${ref}] ${role} "${name.slice(0, 40)}"${value ? ` value:"${value.slice(0, 40)}"` : ""} @(${pos}) ${size}${actions ? ` actions:${actions.trim()}` : ""}`);
    if (refN >= 200) { out.push("  …(已达 200 元素上限, 截断)"); break; }
  }
  return { text: out.join("\n") || "(无元素)", elements, winCount };
}

async function appState(options = {}) {
  const appHint = options.appHint ? String(options.appHint) : "";
  const key = appHint || "*";
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { ok: true, output: cached.text, elements: cached.elements, cached: true };
  }
  // CGWindowList-based fallback is always available on macOS: build a
  // window-level "tree" (windows are clickable by center coordinates) when AX
  // is not granted, so the agent still has structured targets to work with.
  let raw;
  if (IS_MAC) {
    const r = await macAppState(appHint);
    if (!r.ok) {
      const wl = await macWindowList();
      const fallback = buildWindowFallback(wl.output || "");
      return { ok: true, output: fallback.text + "\n\n(AX 元素树不可用: " + r.error + (r.hint ? " — " + r.hint : "") + ")\n窗口中心可点击: computer_click_ref e1/e2/…; 或 computer_screenshot 后坐标点击。", elements: fallback.elements };
    }
    if (!r.text || !r.text.includes("EL|")) {
      const wl = await macWindowList();
      const fallback = buildWindowFallback(wl.output || "");
      return {
        ok: true,
        output: fallback.text + "\n\n(AX 元素树为空 — 需要辅助功能权限: 系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Electron/终端。窗口中心已可直接点击。)",
        elements: fallback.elements,
      };
    }
    raw = r.text;
  } else if (IS_WIN) {
    const r = await winAppState(appHint);
    if (!r.ok) return { ok: false, output: `获取元素树失败: ${r.error}` };
    raw = r.text;
  } else {
    return { ok: false, output: "Linux 元素树需要 AT-SPI (python3-atspi) — 当前仅支持坐标模式 (computer_click 等)" };
  }
  const { text, elements } = formatTree(raw, appHint);
  cache.set(key, { at: Date.now(), text, elements });
  return { ok: true, output: text + "\n\n(引用 ref 如 e5 可用于 computer_click_ref/computer_set_value)", elements };
}

/* window-level fallback targets from CGWindowList output lines */
function buildWindowFallback(winlistOutput) {
  const out = ["窗口级元素树(CGWindowList):"];
  const elements = [];
  let n = 0;
  for (const line of String(winlistOutput || "").split("\n")) {
    const m = /^(.*?) \| (.*?) \| \((-?\d+),(-?\d+)\) (\d+)x(\d+)$/.exec(line.trim());
    if (!m) continue;
    n++;
    const ref = `e${n}`;
    const [, owner, title, x, y, w, h] = m;
    elements.push({ ref, role: "AXWindow", name: title, value: "", pos: `${x},${y}`, size: `${w},${h}`, actions: ["AXPress"] });
    out.push(`  [${ref}] AXWindow "${title}" (${owner}) @(${x},${y}) ${w}x${h} — 中心可点击`);
  }
  if (!n) out.push("  (无可见窗口)");
  return { text: out.join("\n"), elements };
}

function findRef(ref, appHint) {
  const key = appHint || "*";
  const cached = cache.get(key);
  if (!cached) return null;
  return cached.elements.find((e) => e.ref === ref) || null;
}

function center(pos, size) {
  const [x, y] = String(pos).split(",").map((n) => parseInt(n, 10));
  const [w, h] = String(size).split(",").map((n) => parseInt(n, 10) || [0, 0]);
  return { x: (isNaN(x) ? 0 : x) + Math.floor((isNaN(w) ? 0 : w) / 2), y: (isNaN(y) ? 0 : y) + Math.floor((isNaN(h) ? 0 : h) / 2) };
}

async function clickElement(ref, options = {}) {
  const appHint = options.appHint ? String(options.appHint) : "";
  const el = findRef(ref, appHint);
  if (!el) {
    await appState({ appHint });
    const again = findRef(ref, appHint);
    if (!again) return { ok: false, output: `引用 ${ref} 不在最近的元素树中 — 先调 computer_app_state 刷新` };
    return clickElement(ref, options);
  }
  // mac: try AXPress via osascript (background click); fall back to coordinate
  if (IS_MAC && el.actions.includes("AXPress") && options.button !== "right" && !options.double) {
    const script = `tell application "System Events" to perform action "AXPress" of (first UI element whose position is {${el.pos.split(",")[0]}, ${el.pos.split(",")[1]}})`;
    // AXPress-by-position is fragile; simpler: click via System Events at element path is complex — use coordinate click
  }
  const { click } = require("./index");
  const c = center(el.pos, el.size);
  await click(c.x, c.y, options.double ? "double" : options.button === "right" ? "right" : "left");
  return { ok: true, output: `已点击 [${ref}] ${el.role} "${(el.name || "").slice(0, 30)}" @ (${c.x}, ${c.y})` };
}

async function setElementValue(ref, text, options = {}) {
  const appHint = options.appHint ? String(options.appHint) : "";
  let el = findRef(ref, appHint);
  if (!el) { await appState({ appHint }); el = findRef(ref, appHint); }
  if (!el) return { ok: false, output: `引用 ${ref} 不在最近的元素树中 — 先调 computer_app_state 刷新` };

  if (IS_MAC) {
    // clicking into the field first, then typing, is the most robust path on mac AX
    const { click, type } = require("./index");
    const c = center(el.pos, el.size);
    await click(c.x, c.y, "left");
    await new Promise((r) => setTimeout(r, 150));
    await type(String(text));
    return { ok: true, output: `已向 [${ref}] ${el.role} 输入 ${String(text).length} 字符(点击+键入)` };
  }
  if (IS_WIN) {
    const ps = `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($k in $all) {
  if ($k.Current.Name -eq '${String(el.name || "").replace(/'/g, "''")}') {
    $k.SetFocus()
    $v = $k.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $v.SetValue('${String(text).replace(/'/g, "''")}')
    Write-Output "OK"
    break
  }
}`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
    if (r.code === 0 && r.stdout.includes("OK")) return { ok: true, output: `已设值 [${ref}]` };
    return { ok: false, output: `UIA SetValue 失败: ${(r.stderr || "").slice(0, 150)}` };
  }
  return { ok: false, output: "Linux 暂不支持元素级设值" };
}

async function listWindows() {
  if (IS_MAC) {
    return macWindowList();
  }
  if (IS_WIN) {
    const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Output ($_.ProcessName + ' | "' + $_.MainWindowTitle + '"') }`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 });
    if (r.code !== 0) return { ok: false, output: (r.stderr || "").slice(0, 200) };
    return { ok: true, output: r.stdout || "(无可见窗口)" };
  }
  const r = await run("wmctrl", ["-l"]);
  if (r.code !== 0) return { ok: false, output: "Linux 需要 wmctrl (apt install wmctrl)" };
  return { ok: true, output: r.stdout };
}

async function clipboardGet() {
  if (IS_MAC) {
    const r = await run("pbpaste", []);
    return { ok: r.code === 0, output: r.stdout || "(剪贴板为空)" };
  }
  if (IS_WIN) {
    const r = await run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"]);
    return { ok: r.code === 0, output: r.stdout || "(剪贴板为空)" };
  }
  const r = await run("xclip", ["-selection", "clipboard", "-o"]);
  if (r.code !== 0) return { ok: false, output: "Linux 需要 xclip" };
  return { ok: true, output: r.stdout };
}

async function clipboardSet(text) {
  if (IS_MAC) {
    const r = await run("pbcopy", [], { input: String(text) });
    return { ok: r.code === 0, output: `已写入剪贴板 (${String(text).length} 字符)` };
  }
  if (IS_WIN) {
    const r = await run("powershell", ["-NoProfile", "-Command", `$input | Set-Clipboard`], { input: String(text) });
    return { ok: r.code === 0, output: `已写入剪贴板 (${String(text).length} 字符)` };
  }
  const r = await run("xclip", ["-selection", "clipboard"], { input: String(text) });
  if (r.code !== 0) return { ok: false, output: "Linux 需要 xclip" };
  return { ok: true, output: `已写入剪贴板 (${String(text).length} 字符)` };
}

async function axStatus() {
  if (IS_MAC) {
    const probe = await run("osascript", ["-e", `tell application "System Events" to get name of first application process whose frontmost is true`], { timeout: 8000 });
    if (probe.code === 0) {
      // process enumeration works; verify the window tree is actually readable
      const tree = await macAppState(null, 50);
      const readable = tree.ok && tree.text && tree.text.includes("EL|");
      return {
        platform: "darwin",
        backend: "AppleScript/System Events" + (readable ? "" : " (进程可达, 窗口树为空)"),
        available: readable,
        hint: readable ? null : "辅助功能未生效 — 系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Electron/终端。窗口列表(computer_windows)/截屏/坐标点击不受影响。",
      };
    }
    if (/assistive access|not allowed/i.test(probe.stderr || "")) {
      return { platform: "darwin", backend: "AppleScript/System Events", available: false, hint: "系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Electron/终端" };
    }
    return { platform: "darwin", backend: "AppleScript/System Events", available: false, hint: (probe.stderr || "").slice(0, 150) };
  }
  if (IS_WIN) {
    const probe = await run("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName UIAutomationClient; Write-Output ok"], { timeout: 15000 });
    return { platform: "win32", backend: "UIAutomation", available: probe.code === 0, hint: probe.code === 0 ? null : (probe.stderr || "").slice(0, 150) };
  }
  return { platform: "linux", backend: "AT-SPI (未实现, 仅坐标模式)", available: false, hint: "安装 python3-atspi 后可获得元素级支持(路线图)" };
}

module.exports = { appState, clickElement, setElementValue, listWindows, clipboardGet, clipboardSet, axStatus };
