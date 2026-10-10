import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeOrderRequest } from "../src/lib/wallet/order.ts";
import { importPrivateKey } from "../src/lib/crypto/accounts.ts";

const future = "2030-01-01T00:00:00.000Z";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const uri = (value: unknown) => `lattice://order?v=1&intent=${encode(value)}`;

const wireSell = {
  version: 1, intentId: "request-1", parentChain: ["Nexus"], childChain: ["Nexus", "testnet"],
  asset: "LAT", expiresAt: future, side: "sell_child", orderType: "limit",
  amountDeposited: "200000000", amountDemanded: "300000000",
};
const sell = { ...wireSell } as Record<string, unknown>;
delete sell.intentId;

test("decodes an adjacent-chain sell request and ignores website-only metadata", () => {
  assert.deepEqual(decodeOrderRequest(uri({ ...wireSell, returnUrl: "https://untrusted.example/", recipient: "ignored" }), Date.UTC(2029, 0, 1)), sell);
});

test("rejects expired, malformed, non-adjacent and out-of-range requests", () => {
  assert.throws(() => decodeOrderRequest(uri(sell), Date.UTC(2031, 0, 1)), /expired/);
  assert.throws(() => decodeOrderRequest("https://example.com/"), /supported/);
  assert.throws(() => decodeOrderRequest(uri({ ...sell, childChain: ["Nexus", "a", "b"] }), Date.UTC(2029, 0, 1)), /direct parent/);
  assert.throws(() => decodeOrderRequest(uri({ ...sell, amountDeposited: "18446744073709551616" }), Date.UTC(2029, 0, 1)), /out of range/);
});

const seller = importPrivateKey("c1".repeat(32)).address;
const deposit = { demander: seller, amountDemanded: "100", amountDeposited: "300", depositNonce: "8" };
const buy = (deposits: unknown, extra: Record<string, unknown> = {}) => uri({
  version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT", expiresAt: future,
  side: "buy_child", orderType: "take", deposits, ...extra,
});
const at = Date.UTC(2029, 0, 1);

test("decodes a buy of named sell orders exactly, dropping anything else the page sent", () => {
  const decoded = decodeOrderRequest(buy([{ ...deposit, blockHeight: "9", note: "ignored" }, { ...deposit, depositNonce: "18446744073709551615" }], { intentId: "x", returnUrl: "https://untrusted.example/" }), at);
  assert.deepEqual(decoded, {
    version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT", expiresAt: future,
    side: "buy_child", orderType: "take",
    deposits: [deposit, { ...deposit, depositNonce: "18446744073709551615" }],
  });
});

test("rejects a buy that does not name well-formed, distinct sell orders", () => {
  assert.throws(() => decodeOrderRequest(buy([]), at), /must name the sell orders/);
  assert.throws(() => decodeOrderRequest(buy("all"), at), /must name the sell orders/);
  assert.throws(() => decodeOrderRequest(buy([deposit, { ...deposit }]), at), /twice/);
  assert.throws(() => decodeOrderRequest(buy(["x"]), at), /not an object/);
  for (const [bad, message] of [
    [{ demander: "bafynope" }, /Sell order 1 has an invalid seller address/],
    [{ demander: "<img src=x onerror=alert(1)>" }, /invalid seller address/],
    [{ depositNonce: "-1" }, /invalid nonce/], [{ depositNonce: 8 }, /invalid nonce/], [{ depositNonce: "18446744073709551616" }, /invalid nonce/],
    [{ amountDemanded: "0" }, /parent amount is out of range/], [{ amountDemanded: "1e3" }, /parent amount is invalid/], [{ amountDemanded: "0x10" }, /parent amount is invalid/],
    [{ amountDeposited: "18446744073709551616" }, /child amount is out of range/], [{ amountDeposited: 300 }, /child amount is invalid/],
  ] as const) {
    assert.throws(() => decodeOrderRequest(buy([{ ...deposit, ...bad }]), at), message);
  }
  assert.throws(() => decodeOrderRequest(buy([deposit], { childChain: ["Nexus", "a", "b"] }), at), /direct parent/);
  assert.throws(() => decodeOrderRequest(buy([deposit]), Date.UTC(2031, 0, 1)), /expired/);
});

test("the old buy-by-amount request is refused with a way forward", () => {
  const market = { version: 1, parentChain: ["Nexus"], childChain: ["Nexus", "testnet"], asset: "LAT", expiresAt: future, side: "buy_child", orderType: "market" };
  for (const amounts of [{ maxAmountDemanded: "10" }, { desiredAmountDeposited: "20" }]) {
    assert.throws(() => decodeOrderRequest(uri({ ...market, ...amounts }), at), /no longer supported.*Choose the sell orders/);
  }
});

test("a request can name as many sell orders as fit the handoff limit", () => {
  const many = (count: number) => buy(Array.from({ length: count }, (_, i) => ({ ...deposit, depositNonce: String(i) })));
  assert.equal(decodeOrderRequest(many(60), at).side, "buy_child");
  assert.throws(() => decodeOrderRequest(many(200), at), /too large/);
});
