export function formatMicroAmount(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  const s = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const whole = n / 1_000_000n;
  const rem = n % 1_000_000n;
  const frac = rem.toString().padStart(6, "0").replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return frac ? `${wholeText}.${frac}` : wholeText;
}

/** Integer string in a micro-denom, optionally containing comma separators. */
export function isPositiveMicroAmountString(raw: string): boolean {
  const s = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return false;
  return BigInt(s) > 0n;
}
