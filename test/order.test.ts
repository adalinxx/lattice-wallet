import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeOrderRequest } from "../src/lib/wallet/order.ts";

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

test("accepts one buy bound but rejects an ambiguous buy", () => {
  const base = { ...sell, side: "buy_child", orderType: "market" };
  delete (base as Record<string, unknown>).amountDeposited;
  delete (base as Record<string, unknown>).amountDemanded;
  const decoded = decodeOrderRequest(uri({ ...base, maxAmountDemanded: "10" }), Date.UTC(2029, 0, 1));
  assert.equal(decoded.side, "buy_child");
  assert.throws(() => decodeOrderRequest(uri({ ...base, maxAmountDemanded: "10", desiredAmountDeposited: "20" }), Date.UTC(2029, 0, 1)), /exactly one/);
});
