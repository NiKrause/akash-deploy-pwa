import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSdlPricingMatchesDeposit,
  collectPricingDenomsFromGroupSpecs,
  type GroupSpecWithPricing,
} from "../src/akash/deployValidation.ts";

const groups: GroupSpecWithPricing[] = [
  {
    resources: [
      { price: { denom: "uact" } },
      { price: { denom: " uakt " } },
      { price: { denom: "uact" } },
      {},
    ],
  },
  { resources: [{ price: { denom: "" } }] },
];

test("collectPricingDenomsFromGroupSpecs returns trimmed unique non-empty denoms", () => {
  assert.deepEqual(collectPricingDenomsFromGroupSpecs(groups), ["uact", "uakt"]);
});

test("assertSdlPricingMatchesDeposit accepts matching pricing denoms", () => {
  assert.doesNotThrow(() =>
    assertSdlPricingMatchesDeposit([{ resources: [{ price: { denom: "uact" } }] }], "uact")
  );
  assert.doesNotThrow(() => assertSdlPricingMatchesDeposit([{ resources: [] }], "uact"));
});

test("assertSdlPricingMatchesDeposit rejects pricing denoms that differ from escrow denom", () => {
  assert.throws(() => assertSdlPricingMatchesDeposit(groups, "uact"), {
    message: /SDL pricing uses bank denom\(s\) "uakt".*escrows deployment funds in "uact"/,
  });
});
