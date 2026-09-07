// Browser control via playwright-core (optional dependency).
// Launch strategy: prefer an installed browser (chrome → msedge → chrome-beta →
// brave → chromium downloaded by playwright). Zero browser downloads when the
// user already has Chrome/Edge. All methods fail gracefully with hints.
"use strict";

let core = null;
function requireCore() {
  if (core) return core;
  try { core = require("playwright-core"); return core; }
  catch {
    throw new Error("playwright-core 未安装 — 在安装目录运行: npm i playwright-core (或全局 npm i -g playwright-core)");
  }
}

const CHANNELS = ["chrome", "msedge", "chrome-beta", "msedge-beta", "brave", "chromium"];

class BrowserManager {
  constructor({ headless } = {}) {
    this.headless = headless ?? process.env.OPENZCODE_BROWSER_HEADLESS === "0" ? false : (headless ?? true);
    this.chromium = null;
    this.context = null;
    this.pages = [];      // active pages, [0] = active
    this.launchInfo = null;
    this.starting = null;
  }

  async status() {
    let playwright = false;
    try { requireCore(); playwright = true; } catch { return { playwright: false, running: false, pages: 0, channel: null, error: null }; }
    return {
      playwright: true,
      running: !!this.chromium,
      pages: this.pages.filter((p) => !p.isClosed()).length,
      channel: this.launchInfo?.channel || null,
      error: this.launchInfo?.error || null,
    };
  }

  async launch() {
    if (this.chromium && this.chromium.isConnected()) return this.chromium;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const pw = requireCore();
      const errors = [];
      for (const channel of CHANNELS) {
        try {
          this.chromium = await pw.chromium.launch({
            channel,
            headless: this.headless,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          });
          this.launchInfo = { channel };
          this.context = this.chromium.contexts()[0] || await this.chromium.newContext({ viewport: { width: 1440, height: 900 } });
          if (!this.pages.length) this.pages = [await this.newPage()];
          return this.chromium;
        } catch (e) {
          errors.push(`${channel}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
        }
      }
      this.launchInfo = { error: errors.join(" | ") };
      throw new Error(
        `没有可用的浏览器。已尝试: ${errors.join("; ")}。` +
        `请安装 Chrome/Edge，或运行 npx playwright install chromium 后重试。`
      );
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async newPage() {
    const page = await this.context.newPage();
    page.setDefaultTimeout(20000);
    this.pages.unshift(page);
    page.on("close", () => { this.pages = this.pages.filter((p) => p !== page); });
    return page;
  }

  activePage() {
    this.pages = this.pages.filter((p) => !p.isClosed());
    return this.pages[0] || null;
  }

  async page() {
    await this.launch();
    return this.activePage() || await this.newPage();
  }

  async navigate(url) {
    const page = await this.page();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return this.describe(page);
  }

  describe(page) {
    return page.evaluate(() => ({ title: document.title, url: location.href })).catch(() => ({ title: "", url: "" }));
  }

  /** aria snapshot with refs usable by click/type */
  async snapshot() {
    const page = await this.page();
    let snap = null;
    try { snap = await page.locator("body").ariaSnapshot(); }
    catch { snap = null; }
    const meta = await this.describe(page);
    if (snap) return { text: `页面: ${meta.title} (${meta.url})\n\n${snap}`, url: meta.url, title: meta.title };
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 6000) || "").catch(() => "");
    return { text: `页面: ${meta.title} (${meta.url})\n\n[无 aria 快照, 正文摘要]\n${text}`, url: meta.url, title: meta.title };
  }

  async clickRef(ref, { button = "left", double = false } = {}) {
    const page = await this.page();
    const loc = page.locator(`aria-ref=${ref}`);
    if (double) await loc.dblclick({ button: button === "right" ? "right" : "left" });
    else await loc.click({ button: button === "right" ? "right" : "left" });
    return this.describe(page);
  }

  async fillRef(ref, text, { submit = false } = {}) {
    const page = await this.page();
    const loc = page.locator(`aria-ref=${ref}`);
    await loc.fill(text);
    if (submit) await loc.press("Enter");
    return this.describe(page);
  }

  async evaluate(js) {
    const page = await this.page();
    const fn = js.includes("=>") || js.includes("function") ? js : `(async () => { ${js} })()`;
    const result = await page.evaluate(fn);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  async screenshotPage({ fullPage = false } = {}) {
    const page = await this.page();
    const buf = await page.screenshot({ fullPage, type: "png" });
    return { image: { data: buf.toString("base64"), mime: "image/png" } };
  }

  async pressKey(keyStr) {
    const page = await this.page();
    await page.keyboard.press(keyStr);
    return this.describe(page);
  }

  close() {
    try { this.chromium && this.chromium.close(); } catch {}
    this.chromium = null;
    this.context = null;
    this.pages = [];
    this.launchInfo = null;
  }
}

module.exports = { BrowserManager };
