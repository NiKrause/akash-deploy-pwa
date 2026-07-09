import { getEndpoints, type NetworkMode } from "../config/networks";

/**
 * Align legacy `uakt` / `uact` placement pricing lines to the escrow denom this build uses,
 * so persisted session YAML matches `getEndpoints(mode).deploymentEscrowMinimalDenom`.
 */
export function alignSdlPricingDenomsToEscrow(yaml: string, escrowDenom: string): string {
  return yaml
    .replace(/denom:\s*(?:uakt|uact)\b/g, `denom: ${escrowDenom}`)
    .replace(/denom:\s*"(?:uakt|uact)"/g, `denom: "${escrowDenom}"`)
    .replace(/denom:\s*'(?:uakt|uact)'/g, `denom: '${escrowDenom}'`);
}

/** Default smoke-test SDL (nginx). Placement pricing denom follows deployment escrow. */
export function getDefaultSdl(mode: NetworkMode): string {
  const d = getEndpoints(mode).deploymentEscrowMinimalDenom;
  return `version: "2.0"

services:
  web:
    image: nginx:1.27-alpine
    expose:
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    web:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 512Mi
  placement:
    dcloud:
      pricing:
        web:
          denom: ${d}
          amount: 10000

deployment:
  web:
    dcloud:
      profile: web
      count: 1
`;
}

/** Mainnet default (backward compatible export). */
export const DEFAULT_SDL = getDefaultSdl("mainnet");
