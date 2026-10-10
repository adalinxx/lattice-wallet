import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { writeBundleNotices } = await import(new URL("../scripts/bundle-notices.mjs", import.meta.url).href);

test("bundle notices retain separate versions, verbatim licenses, NOTICE and embedded attributions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wallet-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "wallet" }));
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "# Manual attribution\n");
  writeFileSync(join(root, "app.js"), "export {};");
  const inputs: Record<string, object> = { "app.js": {} };
  for (const [dir, version] of [["node_modules/dependency", "1.0.0"], ["vendor/sdk/node_modules/dependency", "2.0.0"]]) {
    mkdirSync(join(root, dir!), { recursive: true });
    writeFileSync(join(root, dir!, "package.json"), JSON.stringify({ name: "dependency", version, license: "MIT" }));
    writeFileSync(join(root, dir!, "LICENSE"), `Copyright author ${version}\r\nPermission text\r\n`);
    writeFileSync(join(root, dir!, "NOTICE"), `Required notice ${version}\n`);
    writeFileSync(join(root, dir!, "index.js"), "/* Copyright embedded helper author. Permission granted. */\nexport {};");
    inputs[`${dir}/index.js`] = {};
  }
  writeBundleNotices({ inputs }, root);
  const notices = readFileSync(join(root, "dist/THIRD_PARTY_NOTICES.md"), "utf8");
  for (const version of ["1.0.0", "2.0.0"]) {
    assert.ok(notices.includes(`Copyright author ${version}\r\nPermission text\r\n`));
    assert.ok(notices.includes(`Required notice ${version}\n`));
  }
  assert.match(notices, /Copyright embedded helper author/);
  const inventory = JSON.parse(readFileSync(join(root, "dist/THIRD_PARTY_INVENTORY.json"), "utf8"));
  assert.deepEqual(inventory.map((entry: { version: string }) => entry.version), ["1.0.0", "2.0.0"]);
  writeBundleNotices({ inputs: Object.fromEntries(Object.entries(inputs).reverse()) }, root);
  assert.equal(readFileSync(join(root, "dist/THIRD_PARTY_NOTICES.md"), "utf8"), notices);
  rmSync(join(root, "node_modules/dependency/LICENSE"));
  assert.throws(() => writeBundleNotices({ inputs }, root), /Missing upstream license/);
});
