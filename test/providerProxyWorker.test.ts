import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/provider-proxy.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("provider proxy rejects non-Akash target paths", async () => {
  const response = await worker.fetch(
    new Request("https://proxy.example/?url=https%3A%2F%2Fprovider.example.com%2Fanything")
  );

  assert.equal(response.status, 403);
});

test("provider proxy rejects local/private targets", async () => {
  const response = await worker.fetch(
    new Request("https://proxy.example/?url=http%3A%2F%2F127.0.0.1%2Fdeployment%2F123%2Fmanifest", {
      method: "PUT",
    })
  );

  assert.equal(response.status, 403);
});

test("provider proxy forwards allowed manifest uploads with CORS headers", async () => {
  const upstream = new Response("uploaded", { status: 202 });
  const fetchMock = test.mock.fn(() => Promise.resolve(upstream));
  globalThis.fetch = fetchMock;

  const response = await worker.fetch(
    new Request("https://proxy.example/?url=https%3A%2F%2Fprovider.example.com%3A8443%2Fdeployment%2F123%2Fmanifest", {
      method: "PUT",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
      body: "{}",
      duplex: "half",
    } as RequestInit)
  );

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], "https://provider.example.com:8443/deployment/123/manifest");
});
