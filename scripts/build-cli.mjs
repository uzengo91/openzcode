// Bundle the CLI into a single openzcode.cjs — the "single binary" that both
// the terminal launcher and the Electron App (ELECTRON_RUN_AS_NODE) execute.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "packages/cli/src/index.js");
const out = path.join(root, "packages/cli/dist/openzcode.cjs");

fs.mkdirSync(path.dirname(out), { recursive: true });

const result = await build({
  entryPoints: [src],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out,
  minify: false,
  sourcemap: false,
  banner: {
    js: [
      "/*!",
      ` * OpenZCode CLI bundle — single-file, dual-form (TUI / app-server --stdio).`,
      ` * runtime: electron-node | entry: openzcode.cjs | built ${new Date().toISOString()}`,
      ` * Load with ELECTRON_RUN_AS_NODE=1 <electron> openzcode.cjs <args>`,
      " */",
    ].join("\n"),
  },
  logLevel: "info",
});

const size = fs.statSync(out).size;
console.log(`✓ openzcode.cjs ${(size / 1024).toFixed(1)} KB`);
