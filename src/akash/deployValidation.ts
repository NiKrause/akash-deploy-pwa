export type GroupSpecWithPricing = {
  resources?: { price?: { denom?: string | undefined } | undefined }[] | undefined;
};

/** Every `ResourceUnit.price.denom` in the manifest must match the deployment deposit denom. */
export function collectPricingDenomsFromGroupSpecs(groupSpecs: GroupSpecWithPricing[]): string[] {
  const found = new Set<string>();
  for (const gs of groupSpecs) {
    for (const ru of gs.resources ?? []) {
      const d = ru.price?.denom?.trim();
      if (d) found.add(d);
    }
  }
  return [...found];
}

export function assertSdlPricingMatchesDeposit(groupSpecs: GroupSpecWithPricing[], depDenom: string): void {
  const denoms = collectPricingDenomsFromGroupSpecs(groupSpecs);
  if (!denoms.length) return;
  const wrong = denoms.filter((d) => d !== depDenom);
  if (!wrong.length) return;
  const uniq = [...new Set(wrong)].join('", "');
  throw new Error(
    `SDL pricing uses bank denom(s) "${uniq}" but this app escrows deployment funds in "${depDenom}". They must be the same on-chain — set every profiles → placement → pricing → denom in your SDL to "${depDenom}", then deploy again.`
  );
}
