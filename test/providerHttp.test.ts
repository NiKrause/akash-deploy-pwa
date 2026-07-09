import assert from "node:assert/strict";
import test from "node:test";

import { fetchFromProviderOrExplain, providerHttpBase, providerProxyRequestUrl } from "../src/akash/providerHttp.ts";

const originalFetch = globalThis.fetch;
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");

function setLocationHref(href: string) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href },
  });
}

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  if (originalLocationDescriptor) {
    Object.defineProperty(globalThis, "location", originalLocationDescriptor);
  } else {
    delete (globalThis as { location?: Location }).location;
  }
}

test.afterEach(restoreGlobals);

test("providerHttpBase normalizes provider host URIs", () => {
  assert.equal(providerHttpBase("provider.example.com"), "https://provider.example.com");
  assert.equal(providerHttpBase(" provider.example.com/// "), "https://provider.example.com");
  assert.equal(providerHttpBase("http://provider.example.com///"), "http://provider.example.com");
  assert.equal(providerHttpBase("https://provider.example.com///"), "https://provider.example.com");
});

test("fetchFromProviderOrExplain passes through successful responses", async () => {
  const response = new Response("ok", { status: 200 });
  globalThis.fetch = test.mock.fn(() => Promise.resolve(response));

  const actual = await fetchFromProviderOrExplain("https://provider.example.com/status", {}, {
    action: "load status",
    cliHint: "Use the CLI.",
  });

  assert.equal(actual, response);
});

test("providerProxyRequestUrl preserves a variable provider target URL", () => {
  assert.equal(
    providerProxyRequestUrl(
      "https://proxy.example.workers.dev/akash-provider",
      "https://provider.quanglong.org:8443/deployment/27642688/manifest"
    ),
    "https://proxy.example.workers.dev/akash-provider?url=https%3A%2F%2Fprovider.quanglong.org%3A8443%2Fdeployment%2F27642688%2Fmanifest"
  );
});

test("fetchFromProviderOrExplain uses provider proxy when configured", async () => {
  const response = new Response("ok", { status: 200 });
  const fetchMock = test.mock.fn(() => Promise.resolve(response));
  globalThis.fetch = fetchMock;

  await fetchFromProviderOrExplain("https://provider.example.com/deployment/123/manifest", {}, {
    action: "upload the manifest",
    cliHint: "Use the CLI.",
    providerProxyUrl: "https://proxy.example.workers.dev/",
  });

  assert.equal(
    fetchMock.mock.calls[0]?.arguments[0],
    "https://proxy.example.workers.dev/?url=https%3A%2F%2Fprovider.example.com%2Fdeployment%2F123%2Fmanifest"
  );
});

test("fetchFromProviderOrExplain explains mixed-content browser failures", async () => {
  setLocationHref("https://app.example.com/");
  globalThis.fetch = test.mock.fn(() => Promise.reject(new TypeError("Failed to fetch")));

  await assert.rejects(
    () =>
      fetchFromProviderOrExplain("http://provider.example.com/status", {}, {
        action: "load lease status",
        cliHint: "Use the CLI.",
      }),
    /app is on HTTPS but the provider URL is HTTP/
  );
});

test("fetchFromProviderOrExplain explains generic provider reachability failures", async () => {
  setLocationHref("http://localhost:5173/");
  globalThis.fetch = test.mock.fn(() => Promise.reject(new TypeError("Failed to fetch")));

  await assert.rejects(
    () =>
      fetchFromProviderOrExplain("https://provider.example.com/status", {}, {
        action: "load lease status",
        cliHint: "Use the CLI.",
      }),
    /typical causes: no CORS headers for this origin, host offline, or firewall\/ad blocker/
  );
});
