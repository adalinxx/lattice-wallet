// Build the extension into dist/. No remote code: everything is bundled from
// vendored, lockfile-pinned deps. Run: `node build.mjs` (add --watch to watch).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Static assets: manifest + design tokens + mark, and the popup HTML/CSS.
cpSync("public", outdir, { recursive: true });
mkdirSync(`${outdir}/popup`, { recursive: true });
cpSync("src/popup/index.html", `${outdir}/popup/index.html`);
cpSync("src/popup/popup.css", `${outdir}/popup/popup.css`);

const ctx = await esbuild.context({
  entryPoints: {
    "popup/popup": "src/popup/popup.ts",
    "background/service-worker": "src/background/service-worker.ts",
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  legalComments: "none",
  minify: !watch,
  sourcemap: watch,
});

if (watch) {
  await ctx.watch();
  console.log("watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("built -> dist/");
}
