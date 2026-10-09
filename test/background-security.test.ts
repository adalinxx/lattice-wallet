import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response as WalletResponse } from "../src/lib/wallet/types.ts";

test("background accepts only its own wallet page and passive reads do not extend unlock", async () => {
  let listener!: (msg: Request, sender: { id: string; url: string }, reply: (r: WalletResponse) => void) => boolean;
  let alarms = 0;
  const prefix = "chrome-extension://disposable-test-id/";
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "disposable-test-id", getURL: (path: string) => prefix + path,
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    alarms: { create: () => { alarms += 1; }, onAlarm: { addListener: () => {} } },
  } });
  await import("../src/background/service-worker.ts");
  const passive = { type: "getState" } as const;
  const ignored = () => assert.fail("invalid sender received a response");
  assert.equal(listener(passive, { id: "other", url: prefix + "popup/index.html" }, ignored), false);
  assert.equal(listener(passive, { id: "disposable-test-id", url: prefix + "popup/index.html.evil" }, ignored), false);
  const reply = new Promise<WalletResponse>((resolve) => {
    assert.equal(listener(passive, { id: "disposable-test-id", url: prefix + "popup/index.html?view=wallet" }, resolve), true);
  });
  assert.equal((await reply).ok, true);
  assert.equal(alarms, 0);
});
