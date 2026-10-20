import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { ALL_HTTPS_ORIGINS, HOSTED_NODE_ORIGINS, LATTICE_EXPLORER_RPC } from "../src/lib/config.ts";
import { discoveryOrigins, ensureOrigins } from "../src/popup/app.ts";
import { describe, NodePermissionError } from "../src/lib/wallet/node.ts";

test("browser permission failures are not reported as node outages", () => {
  const message = "Chrome has blocked access to this hosted node.";
  assert.equal(describe(new NodePermissionError(message)), message);
  assert.equal(describe(new TypeError("Failed to fetch")), "node unreachable");
});

test("required hosted permissions are exact; connecting to them never prompts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, [...HOSTED_NODE_ORIGINS]);
  assert.ok(!manifest.host_permissions.includes(ALL_HTTPS_ORIGINS), "every HTTPS node is never granted at install");
  assert.ok(manifest.optional_host_permissions.includes(ALL_HTTPS_ORIGINS), "it stays an optional grant");
  let prompts = 0;
  const host = {
    hasOrigins: async (origins: string[]) => origins.every((origin) => manifest.host_permissions.includes(origin)),
    requestOrigins: async () => { prompts += 1; return false; },
  };
  for (const origin of HOSTED_NODE_ORIGINS) assert.equal(await ensureOrigins(host, [origin]), true);
  assert.equal(prompts, 0, "hosted connection does not invoke the permission request");
  for (const origin of ["https://node.example/*", "https://evil.rpc.lattice.build/*", "http://rpc.lattice.build/*"]) {
    assert.equal(await ensureOrigins(host, [origin]), false, "non-allowlisted host cannot bypass permission");
  }
  assert.equal(prompts, 3);
});

test("automatic discovery asks once to reach every HTTPS node, since the hosts it walks to are declared as it goes", async () => {
  assert.deepEqual(discoveryOrigins(LATTICE_EXPLORER_RPC), [ALL_HTTPS_ORIGINS]);
  assert.deepEqual(discoveryOrigins("https://my-node.example"), [ALL_HTTPS_ORIGINS]);
  assert.deepEqual(discoveryOrigins("http://127.0.0.1:8080"), [ALL_HTTPS_ORIGINS, "http://127.0.0.1/*"], "a starting node on this computer is named too");
  const granted = new Set<string>(HOSTED_NODE_ORIGINS);
  let prompts = 0;
  const host = {
    hasOrigins: async (origins: string[]) => origins.every((origin) => granted.has(origin)),
    requestOrigins: async (origins: string[]) => { prompts += 1; origins.forEach((origin) => granted.add(origin)); return true; },
  };
  assert.equal(await ensureOrigins(host, discoveryOrigins(LATTICE_EXPLORER_RPC)), true);
  assert.equal(await ensureOrigins(host, discoveryOrigins(LATTICE_EXPLORER_RPC)), true);
  assert.equal(prompts, 1, "granted once, not again on the next discovery");
});


test("all optional node origins overlap required content scripts: do not offer API revocation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));
  const scriptOrigins = new Set(manifest.content_scripts.flatMap((script: { matches: string[] }) => script.matches));
  for (const origin of manifest.optional_host_permissions) assert.ok(scriptOrigins.has(origin));
  // Chromium UnpackOriginPermissions classifies these as required_scriptable_hosts;
  // PermissionsRemoveFunction rejects the entire batch before revoking anything.
  const popup = await readFile(new URL("../src/popup/popup.ts", import.meta.url), "utf8");
  assert.doesNotMatch(popup, /chrome\.permissions\.(remove|getAll)\(/);
  assert.match(popup, /siteAccessHelp: CHROME_SITE_ACCESS_HELP/);
});
