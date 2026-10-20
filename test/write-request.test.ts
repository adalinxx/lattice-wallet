import { test } from "node:test";
import assert from "node:assert/strict";
import { absentKeys, decodeWriteRequest, fillWriteRequest } from "../src/lib/wallet/write-request.ts";
import { parseProviderCall } from "../src/lib/wallet/provider.ts";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";

const future = "2030-01-01T00:00:00.000Z";
const at = Date.UTC(2029, 0, 1);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const uri = (value: unknown) => `lattice://write?v=1&intent=${encode(value)}`;
const owner = importPrivateKey("c1".repeat(32)).address;
const me = importPrivateKey("c2".repeat(32)).address;

const claim = {
  version: 1, chainPath: ["Nexus", "moniker"], expiresAt: future, label: "Buy @rae",
  actions: [
    { key: "name/rae", newValue: "{account}" },
    { key: "user/{account}/profile", newValue: '{"handle":"rae"}', ifAbsent: true },
  ],
};
const buy = {
  ...claim,
  actions: [{ key: "name/rae", oldValue: `${owner}@500`, newValue: "{account}" }],
  payments: [{ to: owner, amount: "500" }],
};

test("decodes a request exactly, dropping anything else the page sent", () => {
  assert.deepEqual(decodeWriteRequest(uri({ ...buy, returnUrl: "https://untrusted.example/", nonce: "9" }), at), {
    version: 1, chainPath: ["Nexus", "moniker"], expiresAt: future, label: "Buy @rae",
    actions: [{ key: "name/rae", oldValue: `${owner}@500`, newValue: "{account}" }],
    payments: [{ to: owner, amount: "500" }],
  });
  assert.deepEqual(decodeWriteRequest(uri({ ...claim, label: undefined }), at).payments, [], "no payments, and no label");
  assert.equal(decodeWriteRequest(uri({ ...claim, fee: "0" }), at).fee, "0", "a proposed fee, as a page write has");
});

test("refuses requests that are not a well-formed, current lattice://write", () => {
  const refused = (value: unknown, pattern: RegExp, now = at) => assert.throws(() => decodeWriteRequest(typeof value === "string" ? value : uri(value), now), pattern);
  refused("", /empty or too large/);
  refused(`lattice://write?v=1&intent=${"A".repeat(20_000)}`, /empty or too large/);
  refused("https://moniker.example/", /not a supported/);
  refused("lattice://order?v=1&intent=e30", /not a supported/);
  refused("lattice://write?v=2&intent=e30", /not a supported/);
  refused("lattice://write?v=1", /no intent/);
  refused("lattice://write?v=1&intent=not*base64", /encoding/);
  refused(`lattice://write?v=1&intent=${Buffer.from("{").toString("base64url")}`, /JSON/);
  refused({ ...claim, version: 2 }, /version/);
  refused(claim, /expired/, Date.UTC(2031, 0, 1));
  refused({ ...claim, expiresAt: "soon" }, /expired/);
  refused({ ...claim, chainPath: ["Other"] }, /chain/);
  refused({ ...claim, chainPath: ["Nexus", "a/b"] }, /chain/);
  refused({ ...claim, actions: [] }, /writes nothing/);
  refused({ ...claim, actions: [{ key: "k" }] }, /changes nothing/);
  refused({ ...claim, actions: [{ key: 7, newValue: "v" }] }, /malformed/);
  refused({ ...claim, actions: [{ key: "k", newValue: "v", ifAbsent: "yes" }] }, /malformed/);
  refused({ ...claim, actions: [{ key: "k", oldValue: "{account}", newValue: "v" }] }, /only in keys and new values/);
  refused({ ...claim, actions: [{ key: "k", oldValue: "a", newValue: "v", ifAbsent: true }] }, /must be new/);
  refused({ ...claim, actions: [{ key: "k", oldValue: "a", ifAbsent: true }] }, /must be new/);
  refused({ ...buy, payments: [{ to: "{account}", amount: "1" }] }, /account address/);
  refused({ ...buy, payments: [{ to: owner, amount: "0" }] }, /above zero/);
  refused({ ...buy, payments: [{ to: owner, amount: "1" }, { to: owner, amount: "2" }] }, /once/);
  refused({ ...buy, payments: [{ to: owner, amount: "9223372036854775808" }] }, /decimal integer|too large/);
  refused({ ...claim, fee: 1 }, /fee/);
  refused({ ...claim, fee: "01" }, /fee/);
  refused({ ...claim, label: "x".repeat(65) }, /label/);
  refused({ ...claim, label: "Buy\n@rae" }, /label/);
  refused({ ...claim, label: "Buy ‮@rae" }, /label/);
});

test("fills in the chosen account, and leaves out a record only meant to be new when it is there", () => {
  const intent = decodeWriteRequest(uri(claim), at);
  assert.deepEqual(absentKeys(intent, me), [`user/${me}/profile`]);
  assert.deepEqual(fillWriteRequest(intent, me, new Set(), "2"), {
    chainPath: ["Nexus", "moniker"], fee: "2",
    actions: [{ key: "name/rae", newValue: me }, { key: `user/${me}/profile`, newValue: '{"handle":"rae"}' }],
  });
  assert.deepEqual(fillWriteRequest(intent, me, new Set([`user/${me}/profile`]), "1").actions, [{ key: "name/rae", newValue: me }]);
});

test("a request that would pay the chosen account is refused for that account only", () => {
  const intent = decodeWriteRequest(uri(buy), at);
  assert.throws(() => fillWriteRequest(intent, owner, new Set(), "1"), /pays the account you chose/);
  assert.deepEqual(fillWriteRequest(intent, me, new Set(), "1").payments, [{ to: owner, amount: "500" }]);
  assert.throws(() => fillWriteRequest(decodeWriteRequest(uri({ ...buy, payments: [{ to: owner, amount: "9223372036854775807" }] }), at), me, new Set(), "1"), /too large/);
});

test("a page opens a request as its own call, checked the same way", () => {
  const call = parseProviderCall({ method: "openRequest", params: { uri: uri(claim) } });
  assert.equal("method" in call && call.method, "openRequest");
  assert.deepEqual(parseProviderCall({ method: "openRequest", params: {} }), { error: "openRequest needs a lattice://write request" });
  assert.deepEqual(parseProviderCall({ method: "openRequest", params: { uri: uri({ ...claim, expiresAt: "2000-01-01T00:00:00Z" }) } }), { error: "This request has expired" });
});
