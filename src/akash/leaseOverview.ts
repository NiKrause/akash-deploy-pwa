import type { DeploymentOverviewEntry } from "./deployService";
import { isPositiveMicroAmountString } from "../lib/microAmount.ts";

export function deploymentHasActiveLease(deployment: DeploymentOverviewEntry): boolean {
  return deployment.leases.some((lease) => lease.state === "active");
}

export function deploymentIsOpenOrReclaimable(deployment: DeploymentOverviewEntry): boolean {
  return (
    deploymentHasActiveLease(deployment) ||
    deployment.deploymentState !== "closed" ||
    isPositiveMicroAmountString(deployment.lockedEscrowAmount)
  );
}
