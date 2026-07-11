import { getEndpoints, type NetworkMode } from "../config/networks.ts";

export type SdlTemplateId = "ucan-store" | "nginx-smoke";

export const UCAN_STORE_AKASH_IMAGE =
  "ghcr.io/nomadkids/ucan-store-akash@sha256:78e4b73722eb35d134af30632f84e14e347d5b0cb837921774701fbabb16a7b9";

export type SdlTemplateParameter = {
  id: string;
  label: string;
  inputType: "checkbox" | "text" | "url" | "textarea";
  role?: "publicOrigin" | "configureToken";
  placeholder?: string;
  defaultValue?: string;
  help: string;
  valueHelp?: (value: string) => string;
};

type SdlTemplate = {
  id: SdlTemplateId;
  name: string;
  description: string;
  parameters?: SdlTemplateParameter[];
  render: (mode: NetworkMode, options?: SdlTemplateOptions) => string;
};

export type SdlTemplateOptions = Record<string, string | undefined>;

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

export function normalizeUcanStorePublicOrigin(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (!url.hostname) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function ucanStorePublicOriginHost(value: string): string {
  const origin = normalizeUcanStorePublicOrigin(value);
  if (!origin) return "";
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function renderUcanStoreSdl(mode: NetworkMode, options: SdlTemplateOptions = {}): string {
  const d = getEndpoints(mode).deploymentEscrowMinimalDenom;
  const sshPublicKey = env("VITE_UCAN_STORE_SSH_PUBLIC_KEY");
  const sshPublicPort = env("VITE_UCAN_STORE_SSH_PUBLIC_PORT") || "2222";
  const publicOrigin = normalizeUcanStorePublicOrigin(options.ucanStorePublicOrigin ?? "");
  const publicOriginHost = ucanStorePublicOriginHost(publicOrigin);
  const configureToken = options.ucanStoreConfigureToken?.trim() ?? "";
  const selfManagedTls = !!publicOriginHost && options.ucanStoreSelfManagedTls !== "false";
  const httpContainerPort = selfManagedTls ? 80 : 8080;
  const acceptHosts = publicOriginHost
    ? `
        accept:
          - ${yamlSingleQuoted(publicOriginHost)}`
    : "";
  const sshExpose = sshPublicKey
    ? `
      - port: 22
        as: ${sshPublicPort}
        proto: tcp
        to:
          - global: true`
    : "";
  const selfManagedTlsExpose = selfManagedTls
    ? `
      - port: 443
        as: 443
        proto: tcp
        to:
          - global: true`
    : "";
  const sshEnv = sshPublicKey
    ? `
      - ${yamlSingleQuoted(`UCAN_STORE_SSH_AUTHORIZED_KEYS=${sshPublicKey}`)}`
    : "";
  const selfManagedTlsEnv = selfManagedTls
    ? `
      - ${yamlSingleQuoted(`UCAN_STORE_TLS_DOMAIN=${publicOriginHost}`)}`
    : "";
  const publicOriginEnv = publicOrigin && !configureToken
    ? yamlSingleQuoted(`UCAN_STORE_PUBLIC_ORIGIN=${publicOrigin}`)
    : "UCAN_STORE_PUBLIC_ORIGIN=";
  const configureEnv = configureToken
    ? `
      - ${yamlSingleQuoted(`UCAN_STORE_CONFIGURE_TOKEN=${configureToken}`)}`
    : "";

  return `version: "2.0"

services:
  ucan-store:
    image: ${UCAN_STORE_AKASH_IMAGE}
    expose:
      - port: ${httpContainerPort}
        as: 80${acceptHosts}
        to:
          - global: true${selfManagedTlsExpose}${sshExpose}
    env:
      - ${publicOriginEnv}
      - UCAN_STORE_DATA_DIR=/data/ucan-store
      - IPFS_PATH=/data/ipfs${selfManagedTlsEnv}${sshEnv}${configureEnv}

profiles:
  compute:
    ucan-store:
      resources:
        cpu:
          units: 1
        memory:
          size: 2Gi
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
    parameters: [
      {
        id: "ucanStorePublicOrigin",
        label: "Custom domain",
        inputType: "url",
        role: "publicOrigin",
        placeholder: "https://ucan.example.com",
        help: "Optional. Enter the final HTTPS origin before deploying. After the lease is ready, access details tell you which provider ingress target your DNS should point to.",
        valueHelp: (value) => {
          const origin = normalizeUcanStorePublicOrigin(value);
          const host = ucanStorePublicOriginHost(origin);
          return origin
            ? `Accepts host ${host}. After deployment, load access details, set the provider origin first, then point DNS for this host to the provider ingress hostname. Verify DNS/TLS before switching the runtime public origin to ${origin}.`
            : "";
        },
      },
      {
        id: "ucanStoreConfigureToken",
        label: "Configure token",
        inputType: "text",
        role: "configureToken",
        help: "Generated per browser session. The deployed service requires this bearer token before it accepts runtime origin changes.",
      },
      {
        id: "ucanStoreSelfManagedTls",
        label: "Self-managed TLS",
        inputType: "checkbox",
        defaultValue: "true",
        help: "Requests direct 80/443 exposure and asks Caddy to issue the custom-domain certificate. This only works when the selected provider really forwards those public ports to the container.",
      },
    ],
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

export function getSdlTemplate(
  mode: NetworkMode,
  templateId: SdlTemplateId = DEFAULT_SDL_TEMPLATE_ID,
  options: SdlTemplateOptions = {}
): string {
  const template = SDL_TEMPLATES.find((candidate) => candidate.id === templateId) ?? SDL_TEMPLATES[0];
  return template.render(mode, options);
}

/** Default SDL. Placement pricing denom follows deployment escrow. */
export function getDefaultSdl(mode: NetworkMode): string {
  return getSdlTemplate(mode, DEFAULT_SDL_TEMPLATE_ID);
}

/** Mainnet default (backward compatible export). */
export const DEFAULT_SDL = getDefaultSdl("mainnet");
