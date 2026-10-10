import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Resolve every bundle input to its nearest package, retaining separate installed
// versions (the SDK can pin a different version from the wallet).
export function writeBundleNotices(meta, root = process.cwd(), outdir = "dist") {
  const packages = new Map();
  for (const input of Object.keys(meta.inputs).sort()) {
    const file = resolve(root, input);
    let dir = dirname(file);
    while (!existsSync(resolve(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`No package metadata for bundle input: ${input}`);
      dir = parent;
    }
    if (dir === resolve(root)) continue;
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    if (!pkg.name || !pkg.version || !pkg.license) throw new Error(`Missing package attribution: ${input}`);
    let entry = packages.get(dir);
    if (!entry) {
      const licenses = readdirSync(dir).filter((name) => /^(licen[cs]e|notice|copying|copyright)([._-].*)?$/i.test(name)).sort();
      if (!licenses.some((name) => /^(licen[cs]e|copying)([._-].*)?$/i.test(name))) throw new Error(`Missing upstream license: ${pkg.name}@${pkg.version}`);
      entry = { name: pkg.name, version: pkg.version, license: pkg.license, licenses, dir, comments: new Set() };
      packages.set(dir, entry);
    }
    // Also retain embedded upstream attributions, e.g. TypeScript helpers inside
    // hash-wasm, which are not a separate package in esbuild's dependency graph.
    for (const comment of readFileSync(file, "utf8").match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []) {
      if (/copyright|@license|@preserve|SPDX-License-Identifier/i.test(comment)) entry.comments.add(comment);
    }
  }
  const entries = [...packages.values()].sort((a, b) => `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : `${a.name}@${a.version}` > `${b.name}@${b.version}` ? 1 : 0);
  let notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  notices += "\n\n# Bundled package licenses (generated from build inputs)\n";
  for (const entry of entries) {
    notices += `\n## ${entry.name}@${entry.version}\n\nDeclared license: ${entry.license}\n`;
    for (const name of entry.licenses) notices += `\n### ${name}\n\n${readFileSync(resolve(entry.dir, name), "utf8")}\n`;
    if (entry.comments.size) notices += `\n### Upstream source notices\n\n${[...entry.comments].sort().join("\n\n")}\n`;
  }
  writeFileSync(resolve(root, outdir, "THIRD_PARTY_NOTICES.md"), notices);
  writeFileSync(resolve(root, outdir, "THIRD_PARTY_INVENTORY.json"), JSON.stringify(entries.map(({ name, version, license, licenses }) => ({ name, version, license, licenses })), null, 2) + "\n");
  return entries.map(({ name, version }) => `${name}@${version}`);
}
