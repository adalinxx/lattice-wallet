// The approval window's words for a request: who each address is, which
// record names each payee, and which other sites a message names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addressGroups, addressNames, nameAddresses, otherHosts, payeeRecords, paymentsToShow, shortAddress } from "../src/lib/wallet/review.ts";

const you = "bafyreigsucgdpgsycj3aalba422glkmkneyok6jhf6gpuws4l3osaxvvi4";
const holder = "bafyreif7j3lv63cxezrwnsfbu7bo2qwyy7pffy7rmq7gyxbhnd43qweeau";
const other = "bafyreihm62pyiohb4snwythcngcmbrfmqysv6bgyhrolfaqkmxu7xpmwoa";

test("an address is grouped by four, and shortened only as the popup does", () => {
  assert.equal(addressGroups(holder).join(""), holder);
  assert.ok(addressGroups(holder).slice(0, -1).every((g) => g.length === 4));
  assert.equal(shortAddress(holder), "bafyreif7j3l…43qweeau");
  assert.equal(shortAddress("short"), "short");
});

test("a payee is named by the first record whose old value holds it; else by none", () => {
  const actions = [{ key: "note", newValue: holder }, { key: "own/x/A12", oldValue: `${holder}@250`, newValue: you }];
  assert.deepEqual(payeeRecords(actions, [{ to: holder, amount: "250" }, { to: other, amount: "5" }]), ["own/x/A12", null],
    "a new value proves nothing: only an old value, which the chain checks, names a payee");
});

test("payments no record names are shown first; each group keeps the page's order", () => {
  const actions = [{ key: "own/x/A12", oldValue: `${holder}@250`, newValue: you }];
  const third = "bafyreiaamwrombbsr2dupov6sqkrco5j7bmwtaehgfo4zgnzpl4zbcpvca";
  const payments = [{ to: holder, amount: "250" }, { to: other, amount: "5" }, { to: third, amount: "7" }];
  assert.deepEqual(paymentsToShow(actions, payments).map((p) => p.amount), ["5", "7", "250"]);
});

test("names: the signer is you, payees are numbered when several, other accounts by label", () => {
  const one = addressNames(you, [{ to: holder, amount: "1" }], [{ address: you, label: "Main" }, { address: other, label: "Savings" }]);
  assert.equal(one.size, 3);
  assert.equal(one.get(you), "you");
  assert.equal(one.get(other), "Savings");
  assert.equal(one.get(holder), "payee");
  const two = addressNames(you, [{ to: holder, amount: "1" }, { to: other, amount: "1" }], []);
  assert.deepEqual([two.get(holder), two.get(other)], ["payee 1", "payee 2"]);
  assert.equal(addressNames(you, [], [{ address: you, label: "Main" }]).get(you), "you", "you, not the label, for the signer");
});

test("known addresses inside text become names; the rest stays text", () => {
  const names = new Map([[you, "you"], [holder, "payee"]]);
  assert.deepEqual(nameAddresses(`own/${holder}/A12`, names), [{ text: "own/" }, { name: "payee", address: holder }, { text: "/A12" }]);
  assert.deepEqual(nameAddresses(`${holder}@250`, names), [{ name: "payee", address: holder }, { text: "@250" }]);
  assert.deepEqual(nameAddresses("no addresses", names), [{ text: "no addresses" }]);
  assert.deepEqual(nameAddresses("", names), []);
});

test("a message's other sites: hosts in URLs and a sign-in line, not words with dots", () => {
  const origin = "https://fanfare.example";
  assert.deepEqual(otherHosts("bank.example wants you to sign in with your account:\nURI: https://bank.example/login", origin), ["bank.example"]);
  assert.deepEqual(otherHosts("https://evil.example:8443/x and ftp://user@files.example/y", origin), ["evil.example", "files.example"]);
  assert.deepEqual(otherHosts("fanfare.example wants you to sign in\nhttps://door.fanfare.example/scan https://fanfare.example", origin), [], "the asking site and its subdomains are its own");
  assert.deepEqual(otherHosts("see notes.txt and v1.2, door berlin/A12", origin), [], "bare words with dots are not hosts");
});
