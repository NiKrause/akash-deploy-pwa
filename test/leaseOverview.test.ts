import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentHasActiveLease,
  deploymentIsOpenOrReclaimable,
} from "../src/akash/leaseOverview.ts";
import type { DeploymentOverviewEntry } from "../src/akash/deployService.ts";

function deployment(overrides: Partial<DeploymentOverviewEntry> = {}): DeploymentOverviewEntry {
  return {
    dseq: "1",
    deploymentState: "closed",
    groupState: "closed",
    createdAt: "1",
    escrowState: "closed",
    lockedEscrowAmount: "0",
    transferredAmount: "0",
    leases: [],
    ...overrides,
  };
}

test("deploymentHasActiveLease only treats active leases as active", () => {
  assert.equal(
    deploymentHasActiveLease(
      deployment({
        leases: [
          {
            dseq: "1",
            state: "insufficient_funds",
            provider: "akash1provider",
            priceAmount: "1",
            paymentState: "overdrawn",
            paymentBalance: "0",
            unsettledAmount: "0",
            withdrawnAmount: "0",
            reason: "lease_closed_reason_insufficient_funds",
          },
        ],
      })
    ),
    false
  );
});

test("deploymentIsOpenOrReclaimable hides terminal insufficient-funds deployments", () => {
  assert.equal(
    deploymentIsOpenOrReclaimable(
      deployment({
        groupState: "insufficient_funds",
        escrowState: "overdrawn",
        transferredAmount: "500000",
      })
    ),
    false
  );
});

test("deploymentIsOpenOrReclaimable keeps active, open, or funded deployments visible", () => {
  assert.equal(
    deploymentIsOpenOrReclaimable(
      deployment({
        leases: [
          {
            dseq: "1",
            state: "active",
            provider: "akash1provider",
            priceAmount: "1",
            paymentState: "open",
            paymentBalance: "0",
            unsettledAmount: "0",
            withdrawnAmount: "0",
            reason: "",
          },
        ],
      })
    ),
    true
  );
  assert.equal(deploymentIsOpenOrReclaimable(deployment({ deploymentState: "active" })), true);
  assert.equal(deploymentIsOpenOrReclaimable(deployment({ lockedEscrowAmount: "1" })), true);
});
