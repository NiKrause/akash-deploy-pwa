function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readBlockTime(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.block)) return null;
  const header = value.result.block.header;
  if (!isRecord(header) || typeof header.time !== "string" || header.time.trim() === "") return null;
  return header.time;
}

export async function fetchTendermintBlockTime(rpcBase: string, height: string): Promise<string | null> {
  const normalizedHeight = height.trim();
  const base = trimSlash(rpcBase);
  if (!base || !/^\d+$/.test(normalizedHeight)) return null;

  const url = new URL(`${base}/block`);
  url.searchParams.set("height", normalizedHeight);
  const res = await fetch(url, { method: "GET", mode: "cors", cache: "force-cache" });
  if (!res.ok) throw new Error(`Block time query failed (${res.status})`);
  return readBlockTime(await res.json());
}
