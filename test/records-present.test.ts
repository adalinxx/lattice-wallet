import { test } from "node:test";
import assert from "node:assert/strict";
import { recordsPresent } from "../src/lib/wallet/node.ts";
import { recordState } from "./fixtures/record-state.ts";

test("conditional-record reads follow verified volumes and detect changed presence without writes", async () => {
  for (const exists of [false, true]) {
    const fixture = recordState(exists);
    const result = await recordsPresent("https://node.example", ["Nexus"], ["optional", "missing"], async (input, init) => {
      assert.ok(!init?.method || init.method === "GET");
      return fixture.respond(new URL(input)) ?? new Response("", { status: 404 });
    });
    assert.deepEqual(result, exists ? ["optional"] : []);
  }
});

test("conditional-record reads fail closed when content bytes do not match the requested CID", async () => {
  const absent = recordState(false), present = recordState(true);
  await assert.rejects(recordsPresent("https://node.example", ["Nexus"], ["optional"], async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/chain/info") return absent.respond(url)!;
    return present.respond(new URL(`https://node.example/volumes/${present.tip}?chainPath=Nexus`))!;
  }), /root|CID|digest|match/i);
});
