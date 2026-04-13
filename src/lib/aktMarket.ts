/** CoinGecko id for Akash (mainnet AKT spot; reasonable estimate for sandbox uakt display). */
const COINGECKO_AKT_USD =
  "https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd";

const UAKT_PER_AKT = 1_000_000n;

export async function fetchAktUsdPrice(): Promise<number | null> {
  try {
    const res = await fetch(COINGECKO_AKT_USD);
    if (!res.ok) return null;
    const data = (await res.json()) as { "akash-network"?: { usd?: number } };
    const p = data["akash-network"]?.usd;
    return typeof p === "number" && Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/** Human-readable AKT from integer uakt string (chain amount). */
export function formatUaktStringToAkt(uaktRaw: string | null): string | null {
  if (uaktRaw == null || uaktRaw === "") return null;
  const s = uaktRaw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const whole = n / UAKT_PER_AKT;
  const rem = n % UAKT_PER_AKT;
  const frac = rem.toString().padStart(6, "0").replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  return frac ? `${w}.${frac}` : w;
}

/** For USD math; may lose precision for extremely large on-chain balances. */
export function uaktStringToAktNumber(uaktRaw: string | null): number | null {
  if (uaktRaw == null || uaktRaw === "") return null;
  const s = uaktRaw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  return Number(BigInt(s)) / 1_000_000;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
