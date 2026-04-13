/** gRPC-gateway path that should return JSON when REST is healthy */
const REST_NODE_INFO = "/cosmos/base/tendermint/v1beta1/node_info";

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

/**
 * Probe Cosmos REST (gRPC-gateway): GET node_info.
 */
export async function probeRestGateway(restBase: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const base = trimSlash(restBase);
  if (!base) return { ok: false, error: "Empty URL" };
  const url = `${base}${REST_NODE_INFO}`;
  try {
    const res = await fetch(url, { method: "GET", mode: "cors", cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) {
      return { ok: false, error: "Unexpected content-type" };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Probe Tendermint RPC: GET /status (returns JSON with node_info / sync_info).
 */
export async function probeTendermintRpc(rpcBase: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const base = trimSlash(rpcBase);
  if (!base) return { ok: false, error: "Empty URL" };
  const url = `${base}/status`;
  try {
    const res = await fetch(url, { method: "GET", mode: "cors", cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data: unknown = await res.json();
    if (data === null || typeof data !== "object") {
      return { ok: false, error: "Invalid JSON body" };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
