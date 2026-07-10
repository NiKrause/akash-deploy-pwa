import { getEndpoints, type NetworkMode } from "../config/networks.ts";

export type SdlTemplateId = "ucan-store" | "nginx-smoke";

type SdlTemplate = {
  id: SdlTemplateId;
  name: string;
  description: string;
  render: (mode: NetworkMode) => string;
};

function env(name: string): string {
  const v = import.meta.env?.[name];
  return typeof v === "string" ? v.trim() : "";
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

function renderUcanStoreSdl(mode: NetworkMode): string {
  const d = getEndpoints(mode).deploymentEscrowMinimalDenom;
  const sshPublicKey = env("VITE_UCAN_STORE_SSH_PUBLIC_KEY");
  const sshPublicPort = env("VITE_UCAN_STORE_SSH_PUBLIC_PORT") || "2222";
  const sshExpose = sshPublicKey
    ? `
      - port: 22
        as: ${sshPublicPort}
        to:
          - global: true`
    : "";
  const sshEnv = sshPublicKey
    ? `
      - ${yamlSingleQuoted(`UCAN_STORE_SSH_AUTHORIZED_KEYS=${sshPublicKey}`)}`
    : "";

  return `version: "2.0"

services:
  ucan-store:
    image: ghcr.io/nomadkids/ucan-store-akash:latest
    expose:
      - port: 8080
        as: 80
        to:
          - global: true${sshExpose}
    env:
      - UCAN_STORE_PUBLIC_ORIGIN=
      - UCAN_STORE_DATA_DIR=/data/ucan-store
      - IPFS_PATH=/data/ipfs${sshEnv}

profiles:
  compute:
    ucan-store:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          - size: 10Gi
  placement:
    dcloud:
      pricing:
        ucan-store:
          denom: ${d}
          amount: 1000

deployment:
  ucan-store:
    dcloud:
      profile: ucan-store
      count: 1
`;
}

function renderNginxSmokeSdl(mode: NetworkMode): string {
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

export const DEFAULT_SDL_TEMPLATE_ID: SdlTemplateId = "ucan-store";

export const SDL_TEMPLATES: SdlTemplate[] = [
  {
    id: "ucan-store",
    name: "UCAN Store",
    description: "Real UCAN Store workload from the akash branch: web UI, upload API, IPFS/Kubo, and Caddy.",
    render: renderUcanStoreSdl,
  },
  {
    id: "nginx-smoke",
    name: "Nginx smoke test",
    description: "Tiny nginx deployment for checking wallet, bidding, lease creation, and provider access.",
    render: renderNginxSmokeSdl,
  },
];

export function isSdlTemplateId(value: unknown): value is SdlTemplateId {
  return typeof value === "string" && SDL_TEMPLATES.some((template) => template.id === value);
}

export function getSdlTemplate(mode: NetworkMode, templateId: SdlTemplateId = DEFAULT_SDL_TEMPLATE_ID): string {
  const template = SDL_TEMPLATES.find((candidate) => candidate.id === templateId) ?? SDL_TEMPLATES[0];
  return template.render(mode);
}

/** Default SDL. Placement pricing denom follows deployment escrow. */
export function getDefaultSdl(mode: NetworkMode): string {
  return getSdlTemplate(mode, DEFAULT_SDL_TEMPLATE_ID);
}

/** Mainnet default (backward compatible export). */
export const DEFAULT_SDL = getDefaultSdl("mainnet");
