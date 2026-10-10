import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { HOSTED_NODE_ORIGINS, LATTICE_EXPLORER_RPC } from "../src/lib/config.ts";
import { discoveryOrigins, ensureOrigins } from "../src/popup/app.ts";
import { describe, NodePermissionError } from "../src/lib/wallet/node.ts";

test("browser permission failures are not reported as node outages", () => {
  const message = "Chrome has blocked access to this hosted node.";
  assert.equal(describe(new NodePermissionError(message)), message);
  assert.equal(describe(new TypeError("Failed to fetch")), "node unreachable");
});

test("required hosted permissions are exact and match automatic discovery", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, [...HOSTED_NODE_ORIGINS]);
  assert.deepEqual(new Set(discoveryOrigins(LATTICE_EXPLORER_RPC)), new Set(HOSTED_NODE_ORIGINS));
  assert.ok(!manifest.host_permissions.includes("https://*/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"), "custom nodes remain optional");
  let prompts = 0;
  const host = {
    hasOrigins: async (origins: string[]) => origins.every((origin) => manifest.host_permissions.includes(origin)),
    requestOrigins: async () => { prompts += 1; return false; },
  };
  for (const origin of HOSTED_NODE_ORIGINS) assert.equal(await ensureOrigins(host, [origin]), true);
  assert.equal(await ensureOrigins(host, discoveryOrigins(LATTICE_EXPLORER_RPC)), true);
  assert.equal(prompts, 0, "hosted connection does not invoke the permission request");
  for (const origin of ["https://node.example/*", "https://evil.rpc.lattice.build/*", "http://rpc.lattice.build/*"]) {
    assert.equal(await ensureOrigins(host, [origin]), false, "non-allowlisted host cannot bypass permission");
  }
  assert.equal(prompts, 3);
});
