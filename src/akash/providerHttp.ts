export function providerHttpBase(hostUri: string): string {
  const t = hostUri.trim();
  if (t.startsWith("http://") || t.startsWith("https://")) return t.replace(/\/+$/, "");
  return `https://${t.replace(/\/+$/, "")}`;
}

export function providerProxyRequestUrl(proxyUrl: string, targetUrl: string): string {
  const u = new URL(proxyUrl);
  u.searchParams.set("url", targetUrl);
  return u.toString();
}

function isBrowserFetchNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const m = error.message;
  return m === "Failed to fetch" || m === "Load failed" || /networkerror|network request failed/i.test(m);
}

/**
 * Browser `fetch` to a provider host often fails with a generic "Failed to fetch" when the
 * provider omits CORS headers, blocks cross-origin traffic, or when HTTPS pages call HTTP URLs.
 */
export async function fetchFromProviderOrExplain(
  targetUrl: string,
  init: RequestInit,
  opts: { action: string; cliHint: string; providerProxyUrl?: string | undefined }
): Promise<Response> {
  const { action, cliHint, providerProxyUrl } = opts;
  const requestUrl = providerProxyUrl ? providerProxyRequestUrl(providerProxyUrl, targetUrl) : targetUrl;
  let mixedContent = false;
  try {
    if (typeof globalThis.location !== "undefined") {
      const page = globalThis.location.href;
      if (!providerProxyUrl && page.startsWith("https:") && targetUrl.startsWith("http:")) mixedContent = true;
    }
  } catch {
    /* ignore */
  }

  try {
    return await fetch(requestUrl, init);
  } catch (e) {
    if (!isBrowserFetchNetworkError(e)) throw e;
    let u: URL;
    try {
      u = new URL(providerProxyUrl ? requestUrl : targetUrl);
    } catch {
      throw new Error(
        `Could not reach the provider (${targetUrl}) to ${action}. The browser blocked or could not complete the request (often CORS or mixed content). ${cliHint}`
      );
    }
    const hostPart = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    if (mixedContent) {
      throw new Error(
        `Could not ${action} at ${hostPart}: this app is on HTTPS but the provider URL is HTTP, which browsers block (mixed content). Use a provider with HTTPS, run this app over HTTP during development, or use a desktop/CLI client. ${cliHint}`
      );
    }
    if (providerProxyUrl) {
      throw new Error(
        `Could not reach the provider proxy at ${u.host} while trying to ${action} (${targetUrl}). Check VITE_PROVIDER_PROXY_URL and the worker deployment. ${cliHint}`
      );
    }
    throw new Error(
      `Could not ${action} at ${hostPart} (${targetUrl}). The wallet step may have succeeded, but the browser could not reach the provider (typical causes: no CORS headers for this origin, host offline, or firewall/ad blocker). ${cliHint}`
    );
  }
}
