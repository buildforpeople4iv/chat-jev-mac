import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

// iife, not esm: content.js is loaded via chrome.scripting.executeScript,
// which runs an injected file as a classic script — it cannot contain a
// top-level `import`/`export`. Bundling all three entry points the same way
// keeps this simple instead of special-casing one of them.
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/panel/panel.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  outbase: "src",
});

mkdirSync("dist/panel", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");
cpSync("src/panel/index.html", "dist/panel/index.html");

console.log("built dist/ — chrome://extensions -> Load unpacked -> select extension/dist");
