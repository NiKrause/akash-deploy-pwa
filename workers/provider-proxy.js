const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function text(status, message) {
  return withCors(
    new Response(message, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  );
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.startsWith("[") ||
    isPrivateIpv4(h)
  );
}

function isAllowedAkashProviderRequest(method, target) {
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  if (isBlockedHostname(target.hostname)) return false;
  if (method === "PUT" && /^\/deployment\/[0-9]+\/manifest$/.test(target.pathname)) return true;
  if (method === "GET" && /^\/lease\/[0-9]+\/[0-9]+\/[0-9]+\/status$/.test(target.pathname)) return true;
  return false;
}

function forwardedHeaders(request) {
  const headers = new Headers();
  for (const name of ["Authorization", "Content-Type", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return text(204, "");

    const requestUrl = new URL(request.url);
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget) return text(400, "Missing url query parameter");

    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return text(400, "Invalid target URL");
    }

    if (!isAllowedAkashProviderRequest(request.method, target)) {
      return text(403, "Target is not an allowed Akash provider API request");
    }

    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers: forwardedHeaders(request),
      body: request.method === "PUT" ? request.body : undefined,
    });

    return withCors(upstream);
  },
};
