// An account's label follows the handle it sets for itself on Moniker, while
// the label is still one the wallet chose; nothing else renames it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { automaticLabel, handleLabel, isMonikerChain, MONIKER_CHAINS } from "../src/lib/wallet/moniker.ts";

const me = "bafyme";
const auto = { address: me, kind: "hd" as const, index: 1, label: "Account 2" };
const moniker = ["Nexus", "moniker"];
const naming = (handle: string | undefined, key = `user/${me}/name`) => ({ chainPath: moniker, actions: [{ key, newValue: handle }] });

test("Moniker's chains are the listed ones, whole", () => {
  for (const chain of MONIKER_CHAINS) assert.ok(isMonikerChain(chain));
  assert.ok(!isMonikerChain(["Nexus"]));
  assert.ok(!isMonikerChain(["Nexus", "moniker", "child"]));
  assert.ok(!isMonikerChain(["Nexus", "testnet", "moniker"]));
});

test("a label is the wallet's own while it is the default name or a handle", () => {
  assert.ok(automaticLabel(auto));
  assert.ok(automaticLabel({ kind: "imported", index: 0, label: "Imported 1" }));
  assert.ok(automaticLabel({ ...auto, label: "@rae_2" }));
  assert.ok(!automaticLabel({ ...auto, label: "Account 1" }), "another account's default is a name chosen");
  assert.ok(!automaticLabel({ ...auto, label: "Work" }));
  assert.ok(!automaticLabel({ ...auto, label: "@Rae" }));
  assert.ok(!automaticLabel({ ...auto, label: "@ rae" }));
});

test("an account setting its own handle on Moniker takes it as its label", () => {
  assert.equal(handleLabel(naming("rae"), auto), "@rae");
  assert.equal(handleLabel({ ...naming("rae"), chainPath: ["Nexus", "testnet", "moniker-da6f57"] }, auto), "@rae", "the trial chain too");
  assert.equal(handleLabel(naming("bo"), { ...auto, label: "@rae" }), "@bo", "a new handle replaces the old");
  assert.equal(handleLabel({ chainPath: moniker, actions: [{ key: "name/rae", newValue: me }, ...naming("rae").actions] }, auto), "@rae");
});

test("nothing else renames an account", () => {
  assert.equal(handleLabel(naming("rae"), { ...auto, label: "Work" }), null, "a name the person chose");
  assert.equal(handleLabel({ ...naming("rae"), chainPath: ["Nexus", "stoa"] }, auto), null, "another chain");
  assert.equal(handleLabel(naming("rae", "user/bafyother/name"), auto), null, "another account's handle");
  assert.equal(handleLabel(naming("rae", `user/${me}/profile`), auto), null, "another record");
  for (const bad of ["Rae", "rae!", "", "r a e", "@rae"]) assert.equal(handleLabel(naming(bad), auto), null, `not a handle: ${bad}`);
  assert.equal(handleLabel(naming(undefined), auto), null, "a delete");
  assert.equal(handleLabel(naming("rae"), { ...auto, label: "@rae" }), null, "already so named");
});
