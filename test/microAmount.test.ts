import assert from "node:assert/strict";
import test from "node:test";

import { formatMicroAmount, isPositiveMicroAmountString } from "../src/lib/microAmount.ts";

test("formatMicroAmount renders integer micro-denoms as decimal coin amounts", () => {
  assert.equal(formatMicroAmount("0"), "0");
  assert.equal(formatMicroAmount("1"), "0.000001");
  assert.equal(formatMicroAmount("1000000"), "1");
  assert.equal(formatMicroAmount("123456789"), "123.456789");
  assert.equal(formatMicroAmount("123456000"), "123.456");
  assert.equal(formatMicroAmount("1234567890123"), "1,234,567.890123");
});

test("formatMicroAmount rejects empty or non-integer values", () => {
  assert.equal(formatMicroAmount(null), null);
  assert.equal(formatMicroAmount(""), null);
  assert.equal(formatMicroAmount("1.5"), null);
  assert.equal(formatMicroAmount("-1"), null);
  assert.equal(formatMicroAmount("not-a-number"), null);
});

test("isPositiveMicroAmountString accepts positive integer strings with separators", () => {
  assert.equal(isPositiveMicroAmountString("1"), true);
  assert.equal(isPositiveMicroAmountString("1,000,000"), true);
  assert.equal(isPositiveMicroAmountString(" 000001 "), true);
  assert.equal(isPositiveMicroAmountString("0"), false);
  assert.equal(isPositiveMicroAmountString("0,000"), false);
  assert.equal(isPositiveMicroAmountString("1.5"), false);
  assert.equal(isPositiveMicroAmountString("-1"), false);
});
