import assert from "node:assert/strict";
import test from "node:test";

import { fetchTendermintBlockTime } from "../src/lib/tendermintBlock.ts";

test("fetchTendermintBlockTime queries block height and reads header time", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMode: RequestMode | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMode = init?.mode;
    return new Response(
      JSON.stringify({
        result: {
          block: {
            header: {
              time: "2026-07-09T19:00:00Z",
            },
          },
        },
      }),
      { status: 200 }
    );
  };

  try {
    assert.equal(await fetchTendermintBlockTime("https://rpc.example///", " 123 "), "2026-07-09T19:00:00Z");
    assert.equal(requestedUrl, "https://rpc.example/block?height=123");
    assert.equal(requestedMode, "cors");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTendermintBlockTime skips invalid heights", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  try {
    assert.equal(await fetchTendermintBlockTime("https://rpc.example", "not-a-height"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
