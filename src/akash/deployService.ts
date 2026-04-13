import Long from "long";
import { toBase64 } from "@cosmjs/encoding";
import type { OfflineAminoSigner } from "@cosmjs/amino";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import {
  certificateManager,
  createChainNodeWebSDK,
  generateManifest,
  generateManifestVersion,
  JwtTokenManager,
  manifestToSortedJSON,
  validateSDL,
  yaml,
} from "@akashnetwork/chain-sdk/web";
import type { Manifest, SDLInput } from "@akashnetwork/chain-sdk/web";
import type { AkashEndpoints } from "../config/networks";
import { createBrowserStargateClient } from "./stargateTxClient";
import { getWalletExtension, type WalletKind } from "../wallet/keplr";

type ChainNodeWebSDK = ReturnType<typeof createChainNodeWebSDK>;
type CreateLeaseReq = Parameters<ChainNodeWebSDK["akash"]["market"]["v1beta5"]["createLease"]>[0];
type BidIdArg = NonNullable<CreateLeaseReq["bidId"]>;
type MarketId = BidIdArg;
type MarketBidRecord = { bid?: { id?: MarketId; price?: { amount?: string | undefined } | undefined } | undefined };
type MarketLeaseRecord = { lease?: { id?: MarketId } | undefined };
type DeploymentRecord = {
  deployment?: {
    id?: { dseq?: string | undefined } | undefined;
    state?: string | undefined;
    created_at?: string | undefined;
  } | undefined;
  groups?: { state?: string | undefined }[] | undefined;
  escrow_account?: {
    state?: {
      state?: string | undefined;
      transferred?: { denom?: string | undefined; amount?: string | undefined }[] | undefined;
      funds?: { denom?: string | undefined; amount?: string | undefined }[] | undefined;
    } | undefined;
  } | undefined;
};

export type LeaseOverviewEntry = {
  dseq: string;
  state: string;
  provider: string;
  priceAmount: string;
  paymentState: string;
  paymentBalance: string;
  unsettledAmount: string;
  withdrawnAmount: string;
  reason: string;
};

export type DeploymentOverviewEntry = {
  dseq: string;
  deploymentState: string;
  groupState: string;
  createdAt: string;
  escrowState: string;
  lockedEscrowAmount: string;
  transferredAmount: string;
  leases: LeaseOverviewEntry[];
};

export type CurrentLeasesOverview = {
  deployments: DeploymentOverviewEntry[];
  totalDeploymentCount: number;
  totalLeaseCount: number;
  activeLeaseCount: number;
  lockedEscrowAmount: string;
  reclaimableEscrowAmount: string;
  transferredEscrowAmount: string;
};

export type LeaseAccessIp = {
  ip: string;
  protocol: string;
  port: number;
  externalPort: number;
};

export type LeaseAccessPort = {
  host: string;
  name: string;
  proto: string;
  port: number;
  externalPort: number;
};

export type LeaseAccessService = {
  name: string;
  available: number;
  total: number;
  uris: string[];
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  ports: LeaseAccessPort[];
  ips: LeaseAccessIp[];
};

export type LeaseAccessDetails = {
  dseq: string;
  provider: string;
  providerHostUri: string;
  statusUrl: string;
  services: LeaseAccessService[];
  raw: unknown;
};

/** Keplr/Leap “current account” — can differ from React state if the user switches accounts in the extension. */
export async function getOfflineSignerPrimaryAddress(signer: OfflineSigner): Promise<string> {
  const accs = await signer.getAccounts();
  const a = accs[0]?.address;
  if (!a) throw new Error("Wallet returned no accounts");
  return a;
}

/**
 * Spendable bank amount for `denom`. Many gateways (including Akash sandbox REST) do not implement
 * `SpendableBalanceByDenom` and return “Not Implemented”; those same nodes usually serve `SpendableBalances`.
 */
export async function queryBankSpendableAmount(
  sdk: ChainNodeWebSDK,
  owner: string,
  denom: string
): Promise<string> {
  try {
    const res = await sdk.cosmos.bank.v1beta1.getSpendableBalanceByDenom({ address: owner, denom });
    const amt = res.balance?.amount?.trim();
    if (amt != null && amt !== "") return amt;
  } catch {
    /* SpendableBalanceByDenom missing on gateway */
  }

  try {
    const all = await sdk.cosmos.bank.v1beta1.getSpendableBalances({
      address: owner,
      pagination: page(200),
    });
    const hit = all.balances?.find((c) => c.denom === denom);
    const listed = hit?.amount?.trim();
    if (listed != null && listed !== "") return listed;
  } catch {
    /* fall through to bank balance */
  }

  const res = await sdk.cosmos.bank.v1beta1.getBalance({ address: owner, denom });
  return res.balance?.amount?.trim() ?? "0";
}

export type DeployStep =
  | "idle"
  | "checking_cert"
  | "creating_cert"
  | "creating_deployment"
  | "waiting_bids"
  | "creating_lease"
  | "sending_manifest"
  | "done"
  | "error";

function networkIdFromEndpoints(endpoints: AkashEndpoints) {
  return endpoints.sdlNetworkId;
}

function page(limit: number, offset = 0) {
  return {
    key: new Uint8Array(),
    offset: Long.fromNumber(offset),
    limit: Long.fromNumber(limit),
    countTotal: false,
    reverse: false,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function readUint(value: unknown): number {
  const raw = readString(value);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((entry): entry is string => !!entry?.trim()).map((entry) => entry.trim());
}

function readRecordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function decimalWholePart(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return "0";
  const normalized = raw.startsWith("+") ? raw.slice(1) : raw;
  const [whole = "0"] = normalized.split(".", 1);
  const clean = whole.replace(/^0+(?=\d)/, "");
  return clean || "0";
}

function addIntegerStrings(values: string[]): string {
  return values.reduce((sum, value) => (BigInt(sum) + BigInt(decimalWholePart(value))).toString(), "0");
}

function findDecCoinAmount(
  balances: { denom?: string | undefined; amount?: string | undefined }[] | undefined,
  denom: string
): string {
  const hit = balances?.find((entry) => entry.denom === denom)?.amount;
  return decimalWholePart(hit);
}

function parseMarketId(value: unknown): MarketId | undefined {
  if (!isRecord(value)) return undefined;
  const owner = readString(value.owner)?.trim();
  const dseq = readString(value.dseq)?.trim();
  const provider = readString(value.provider)?.trim();
  if (!owner || !dseq || !provider) return undefined;
  return {
    owner,
    dseq: Long.fromString(dseq),
    gseq: readUint(value.gseq),
    oseq: readUint(value.oseq),
    provider,
    bseq: readUint(value.bseq),
  };
}

function parseMarketBidRecord(value: unknown): MarketBidRecord | undefined {
  if (!isRecord(value) || !isRecord(value.bid)) return undefined;
  const id = parseMarketId(value.bid.id);
  if (!id) return undefined;
  const price = isRecord(value.bid.price) ? { amount: readString(value.bid.price.amount) } : undefined;
  return { bid: { id, price } };
}

function parseMarketLeaseRecord(value: unknown): MarketLeaseRecord | undefined {
  if (!isRecord(value) || !isRecord(value.lease)) return undefined;
  const id = parseMarketId(value.lease.id);
  if (!id) return undefined;
  return { lease: { id } };
}

function parseDeploymentRecord(value: unknown): DeploymentRecord | undefined {
  if (!isRecord(value) || !isRecord(value.deployment)) return undefined;
  const dseq = readString(value.deployment.id && isRecord(value.deployment.id) ? value.deployment.id.dseq : undefined);
  if (!dseq) return undefined;
  const groups = Array.isArray(value.groups)
    ? value.groups
        .filter(isRecord)
        .map((group) => ({ state: readString(group.state) }))
    : undefined;
  const escrowAccount = isRecord(value.escrow_account)
    ? {
        state: isRecord(value.escrow_account.state)
          ? {
              state: readString(value.escrow_account.state.state),
              transferred: Array.isArray(value.escrow_account.state.transferred)
                ? value.escrow_account.state.transferred
                    .filter(isRecord)
                    .map((entry) => ({ denom: readString(entry.denom), amount: readString(entry.amount) }))
                : undefined,
              funds: Array.isArray(value.escrow_account.state.funds)
                ? value.escrow_account.state.funds
                    .filter(isRecord)
                    .map((entry) => ({ denom: readString(entry.denom), amount: readString(entry.amount) }))
                : undefined,
            }
          : undefined,
      }
    : undefined;
  return {
    deployment: {
      id: { dseq },
      state: readString(value.deployment.state),
      created_at: readString(value.deployment.created_at),
    },
    groups,
    escrow_account: escrowAccount,
  };
}

function parseLeaseAccessIp(value: unknown): LeaseAccessIp | null {
  if (!isRecord(value)) return null;
  const ip = readString(readRecordValue(value, "ip"))?.trim();
  if (!ip) return null;
  return {
    ip,
    protocol: readString(readRecordValue(value, "protocol", "proto"))?.trim() ?? "",
    port: readUint(readRecordValue(value, "port")),
    externalPort: readUint(readRecordValue(value, "externalPort", "external_port")),
  };
}

function parseLeaseAccessPort(value: unknown): LeaseAccessPort | null {
  if (!isRecord(value)) return null;
  const host = readString(readRecordValue(value, "host"))?.trim();
  const name = readString(readRecordValue(value, "name"))?.trim() ?? "";
  if (!host && !name) return null;
  return {
    host: host ?? "",
    name,
    proto: readString(readRecordValue(value, "proto", "protocol"))?.trim() ?? "",
    port: readUint(readRecordValue(value, "port")),
    externalPort: readUint(readRecordValue(value, "externalPort", "external_port")),
  };
}

function parseLeaseAccessService(value: unknown): LeaseAccessService | null {
  if (!isRecord(value)) return null;
  const rawStatus = readRecordValue(value, "status");
  const status = isRecord(rawStatus) ? rawStatus : undefined;
  const name = readString(readRecordValue(value, "name"))?.trim();
  const uris = status && isRecord(status) ? readStringArray(readRecordValue(status, "uris")) : [];
  const rawPorts = readRecordValue(value, "ports");
  const ports = Array.isArray(rawPorts)
    ? rawPorts.map(parseLeaseAccessPort).filter((entry): entry is LeaseAccessPort => !!entry)
    : [];
  const rawIps = readRecordValue(value, "ips");
  const ips = Array.isArray(rawIps)
    ? rawIps.map(parseLeaseAccessIp).filter((entry): entry is LeaseAccessIp => !!entry)
    : [];
  if (!name && uris.length === 0 && ports.length === 0 && ips.length === 0) return null;
  return {
    name: name ?? "service",
    available: status ? readUint(readRecordValue(status, "available")) : 0,
    total: status ? readUint(readRecordValue(status, "total")) : 0,
    uris,
    replicas: status ? readUint(readRecordValue(status, "replicas")) : 0,
    readyReplicas: status ? readUint(readRecordValue(status, "readyReplicas", "ready_replicas")) : 0,
    availableReplicas: status ? readUint(readRecordValue(status, "availableReplicas", "available_replicas")) : 0,
    ports,
    ips,
  };
}

function restBaseUrl(endpoints: AkashEndpoints): string {
  return endpoints.rest.replace(/\/+$/, "");
}

function isMalformedBase64Error(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /base64/i.test(msg);
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJwtPart(value: unknown): string {
  return toBase64Url(toBase64(new TextEncoder().encode(JSON.stringify(value))));
}

function hasSignAmino(signer: OfflineSigner): signer is OfflineAminoSigner {
  return typeof (signer as OfflineAminoSigner).signAmino === "function";
}

function extractSignatureBase64(result: unknown): string {
  if (!isRecord(result)) throw new Error("Wallet returned an unexpected signature response");
  if (typeof result.signature === "string") return result.signature;
  if (isRecord(result.signature) && typeof result.signature.signature === "string") {
    return result.signature.signature;
  }
  throw new Error("Wallet returned an unexpected amino signature shape");
}

async function generateProviderJwt(
  signer: OfflineSigner,
  endpoints: AkashEndpoints,
  owner: string,
  leases: { access: "full" },
  walletKind: WalletKind | null
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJwtPart({ alg: "ES256KADR36", typ: "JWT" });
  const payload = encodeJwtPart({
    iss: owner,
    exp: now + 3600,
    nbf: now,
    iat: now,
    version: "v1",
    leases,
  });
  const signingInput = `${header}.${payload}`;

  const ext = walletKind ? getWalletExtension(walletKind) : undefined;
  if (ext) {
    await ext.enable(endpoints.chainId);
    if (typeof ext.signArbitrary === "function") {
      const signature = extractSignatureBase64(await ext.signArbitrary(endpoints.chainId, owner, signingInput));
      return `${signingInput}.${toBase64Url(signature)}`;
    }
    if (typeof ext.signAmino === "function") {
      const signature = extractSignatureBase64(
        await ext.signAmino(endpoints.chainId, owner, {
          chain_id: "",
          account_number: "0",
          sequence: "0",
          fee: {
            gas: "0",
            amount: [],
          },
          msgs: [
            {
              type: "sign/MsgSignData",
              value: {
                signer: owner,
                data: toBase64(new TextEncoder().encode(signingInput)),
              },
            },
          ],
          memo: "",
        })
      );
      return `${signingInput}.${toBase64Url(signature)}`;
    }
  }

  if (!hasSignAmino(signer)) {
    const jwt = new JwtTokenManager(signer as unknown as OfflineAminoSigner);
    return jwt.generateToken({
      iss: owner,
      exp: now + 3600,
      iat: now,
      version: "v1",
      leases,
    });
  }

  const signResult = await signer.signAmino(owner, {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: {
      gas: "0",
      amount: [],
    },
    msgs: [
      {
        type: "sign/MsgSignData",
        value: {
          signer: owner,
          data: toBase64(new TextEncoder().encode(signingInput)),
        },
      },
    ],
    memo: "",
  });
  const signature = extractSignatureBase64(signResult);
  return `${signingInput}.${toBase64Url(signature)}`;
}

async function fetchMarketListJson(
  endpoints: AkashEndpoints,
  path: string,
  params: Record<string, string>
): Promise<unknown> {
  const url = new URL(`${restBaseUrl(endpoints)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Market query failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function listBidsViaRest(endpoints: AkashEndpoints, owner: string, dseq: string): Promise<MarketBidRecord[]> {
  const json = await fetchMarketListJson(endpoints, "/akash/market/v1beta5/bids/list", {
    "filters.owner": owner,
    "filters.dseq": dseq,
    "filters.state": "open",
    "pagination.limit": "50",
  });
  if (!isRecord(json) || !Array.isArray(json.bids)) return [];
  return json.bids.map(parseMarketBidRecord).filter((b): b is MarketBidRecord => !!b?.bid?.id);
}

async function listLeasesViaRest(endpoints: AkashEndpoints, owner: string, dseq: string): Promise<MarketLeaseRecord[]> {
  const json = await fetchMarketListJson(endpoints, "/akash/market/v1beta5/leases/list", {
    "filters.owner": owner,
    "filters.dseq": dseq,
    "filters.state": "active",
    "pagination.limit": "5",
  });
  if (!isRecord(json) || !Array.isArray(json.leases)) return [];
  return json.leases.map(parseMarketLeaseRecord).filter((l): l is MarketLeaseRecord => !!l?.lease?.id);
}

async function listDeploymentsViaRest(endpoints: AkashEndpoints, owner: string): Promise<DeploymentRecord[]> {
  const json = await fetchMarketListJson(endpoints, "/akash/deployment/v1beta4/deployments/list", {
    "filters.owner": owner,
    "pagination.limit": "100",
  });
  if (!isRecord(json) || !Array.isArray(json.deployments)) return [];
  return json.deployments.map(parseDeploymentRecord).filter((d): d is DeploymentRecord => !!d?.deployment?.id?.dseq);
}

type LeaseListRecord = {
  lease?: {
    id?: { dseq?: string | undefined; provider?: string | undefined } | undefined;
    state?: string | undefined;
    price?: { amount?: string | undefined } | undefined;
    reason?: string | undefined;
  } | undefined;
  escrow_payment?: {
    state?: {
      state?: string | undefined;
      balance?: { amount?: string | undefined } | undefined;
      unsettled?: { amount?: string | undefined } | undefined;
      withdrawn?: { amount?: string | undefined } | undefined;
    } | undefined;
  } | undefined;
};

function parseLeaseListRecord(value: unknown): LeaseListRecord | undefined {
  if (!isRecord(value) || !isRecord(value.lease)) return undefined;
  const id = isRecord(value.lease.id) ? value.lease.id : undefined;
  const dseq = readString(id?.dseq);
  if (!dseq) return undefined;
  return {
    lease: {
      id: {
        dseq,
        provider: readString(id?.provider),
      },
      state: readString(value.lease.state),
      price: isRecord(value.lease.price) ? { amount: readString(value.lease.price.amount) } : undefined,
      reason: readString(value.lease.reason),
    },
    escrow_payment: isRecord(value.escrow_payment)
      ? {
          state: isRecord(value.escrow_payment.state)
            ? {
                state: readString(value.escrow_payment.state.state),
                balance: isRecord(value.escrow_payment.state.balance)
                  ? { amount: readString(value.escrow_payment.state.balance.amount) }
                  : undefined,
                unsettled: isRecord(value.escrow_payment.state.unsettled)
                  ? { amount: readString(value.escrow_payment.state.unsettled.amount) }
                  : undefined,
                withdrawn: isRecord(value.escrow_payment.state.withdrawn)
                  ? { amount: readString(value.escrow_payment.state.withdrawn.amount) }
                  : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

async function listAllLeasesViaRest(endpoints: AkashEndpoints, owner: string): Promise<LeaseListRecord[]> {
  const json = await fetchMarketListJson(endpoints, "/akash/market/v1beta5/leases/list", {
    "filters.owner": owner,
    "pagination.limit": "100",
  });
  if (!isRecord(json) || !Array.isArray(json.leases)) return [];
  return json.leases.map(parseLeaseListRecord).filter((lease): lease is LeaseListRecord => !!lease?.lease?.id?.dseq);
}

export async function fetchCurrentLeasesOverview(
  endpoints: AkashEndpoints,
  owner: string
): Promise<CurrentLeasesOverview> {
  const [deploymentsRaw, leasesRaw] = await Promise.all([listDeploymentsViaRest(endpoints, owner), listAllLeasesViaRest(endpoints, owner)]);
  const leasesByDseq = new Map<string, LeaseOverviewEntry[]>();
  for (const entry of leasesRaw) {
    const dseq = entry.lease?.id?.dseq;
    if (!dseq) continue;
    const lease: LeaseOverviewEntry = {
      dseq,
      state: entry.lease?.state ?? "unknown",
      provider: entry.lease?.id?.provider ?? "",
      priceAmount: entry.lease?.price?.amount ?? "0",
      paymentState: entry.escrow_payment?.state?.state ?? "unknown",
      paymentBalance: decimalWholePart(entry.escrow_payment?.state?.balance?.amount),
      unsettledAmount: decimalWholePart(entry.escrow_payment?.state?.unsettled?.amount),
      withdrawnAmount: decimalWholePart(entry.escrow_payment?.state?.withdrawn?.amount),
      reason: entry.lease?.reason ?? "",
    };
    const bucket = leasesByDseq.get(dseq) ?? [];
    bucket.push(lease);
    leasesByDseq.set(dseq, bucket);
  }

  const deployments = deploymentsRaw
    .map((entry): DeploymentOverviewEntry => {
      const dseq = entry.deployment?.id?.dseq ?? "";
      return {
        dseq,
        deploymentState: entry.deployment?.state ?? "unknown",
        groupState: entry.groups?.[0]?.state ?? "unknown",
        createdAt: entry.deployment?.created_at ?? "",
        escrowState: entry.escrow_account?.state?.state ?? "unknown",
        lockedEscrowAmount: findDecCoinAmount(entry.escrow_account?.state?.funds, endpoints.deploymentEscrowMinimalDenom),
        transferredAmount: findDecCoinAmount(
          entry.escrow_account?.state?.transferred,
          endpoints.deploymentEscrowMinimalDenom
        ),
        leases: leasesByDseq.get(dseq) ?? [],
      };
    })
    .sort((a, b) => Number(b.dseq) - Number(a.dseq));

  const allLeases = deployments.flatMap((deployment) => deployment.leases);
  const lockedEscrowAmount = addIntegerStrings(deployments.map((deployment) => deployment.lockedEscrowAmount));
  const reclaimableEscrowAmount = addIntegerStrings(
    deployments
      .filter((deployment) => !deployment.leases.some((lease) => lease.state === "active"))
      .map((deployment) => deployment.lockedEscrowAmount)
  );
  const transferredEscrowAmount = addIntegerStrings(deployments.map((deployment) => deployment.transferredAmount));

  return {
    deployments,
    totalDeploymentCount: deployments.length,
    totalLeaseCount: allLeases.length,
    activeLeaseCount: allLeases.filter((lease) => lease.state === "active").length,
    lockedEscrowAmount,
    reclaimableEscrowAmount,
    transferredEscrowAmount,
  };
}

export function createQuerySdk(endpoints: AkashEndpoints): ChainNodeWebSDK {
  return createChainNodeWebSDK({
    query: { baseUrl: endpoints.rest },
  });
}

export function createFullSdk(endpoints: AkashEndpoints, signer: OfflineSigner): ChainNodeWebSDK {
  const tx = createBrowserStargateClient({ rpc: endpoints.rpc, signer });
  return createChainNodeWebSDK({
    query: { baseUrl: endpoints.rest },
    tx: { signer: tx },
  });
}

export function parseAndPreviewSdl(yamlText: string, endpoints: AkashEndpoints) {
  const nid = networkIdFromEndpoints(endpoints);
  const sdl = yaml.raw(yamlText) as SDLInput;
  const schemaErrors = validateSDL(sdl, nid);
  if (schemaErrors?.length) {
    return { ok: false as const, errors: schemaErrors };
  }
  const result = generateManifest(sdl, nid);
  if (!result.ok) {
    return { ok: false as const, errors: result.value };
  }
  return { ok: true as const, value: result.value };
}

async function hasValidCertificate(sdk: ChainNodeWebSDK, owner: string): Promise<boolean> {
  const res = await sdk.akash.cert.v1.getCertificates({
    filter: { owner, serial: "", state: "" },
    pagination: page(10),
  });
  return (res.certificates?.length ?? 0) > 0;
}

export async function ensureClientCertificate(
  sdk: ChainNodeWebSDK,
  owner: string,
  onStep: (s: DeployStep) => void
): Promise<void> {
  onStep("checking_cert");
  if (await hasValidCertificate(sdk, owner)) return;
  onStep("creating_cert");
  const pem = await certificateManager.generatePEM(owner);
  const enc = new TextEncoder();
  await sdk.akash.cert.v1.createCertificate({
    owner,
    cert: enc.encode(pem.cert),
    pubkey: enc.encode(pem.publicKey),
  });
}

/** If deployment params cannot be read, use a safe default (typical min for `uact` / `uakt` on sandbox/mainnet). */
const FALLBACK_MIN_DEPOSIT_MICRO = "500000";

/** Every `ResourceUnit.price.denom` in the manifest must match the deployment deposit denom. */
function collectPricingDenomsFromGroupSpecs(
  groupSpecs: { resources?: { price?: { denom?: string | undefined } | undefined }[] | undefined }[]
): string[] {
  const found = new Set<string>();
  for (const gs of groupSpecs) {
    for (const ru of gs.resources ?? []) {
      const d = ru.price?.denom?.trim();
      if (d) found.add(d);
    }
  }
  return [...found];
}

function assertSdlPricingMatchesDeposit(
  groupSpecs: Parameters<typeof collectPricingDenomsFromGroupSpecs>[0],
  depDenom: string
): void {
  const denoms = collectPricingDenomsFromGroupSpecs(groupSpecs);
  if (!denoms.length) return;
  const wrong = denoms.filter((d) => d !== depDenom);
  if (!wrong.length) return;
  const uniq = [...new Set(wrong)].join('", "');
  throw new Error(
    `SDL pricing uses bank denom(s) "${uniq}" but this app escrows deployment funds in "${depDenom}". They must be the same on-chain — set every profiles → placement → pricing → denom in your SDL to "${depDenom}", then deploy again.`
  );
}

async function readMinDeploymentDepositMicro(sdk: ChainNodeWebSDK, depDenom: string): Promise<string> {
  try {
    const res = await sdk.akash.deployment.v1beta4.getParams({});
    const mins = res.params?.minDeposits ?? [];
    const hit = mins.find((c) => c.denom === depDenom);
    const amt = hit?.amount?.trim();
    if (amt && BigInt(amt) > 0n) return amt;
  } catch {
    /* fall through */
  }
  return FALLBACK_MIN_DEPOSIT_MICRO;
}

async function assertDeploymentEscrowBalance(
  sdk: ChainNodeWebSDK,
  owner: string,
  endpoints: AkashEndpoints,
  depDenom: string,
  depAmount: string
): Promise<void> {
  const totalBal = await sdk.cosmos.bank.v1beta1.getBalance({ address: owner, denom: depDenom });
  const total = BigInt(totalBal.balance?.amount ?? "0");
  const spendableStr = await queryBankSpendableAmount(sdk, owner, depDenom);
  const have = BigInt(spendableStr);
  const need = BigInt(depAmount);
  if (have >= need) return;

  let lockHint = "";
  if (total > have && total > 0n) {
    lockHint = ` You hold ${total} ${depDenom} in bank but only ${have} is spendable (vesting/lock).`;
  }

  const tail =
    endpoints.mode === "sandbox"
      ? ` Fund ${endpoints.deploymentEscrowCoinDenom} (${depDenom}) for deployment escrow and AKT (uakt) for gas on sandbox-2 (e.g. sandbox faucet).`
      : ` Fund ${endpoints.deploymentEscrowCoinDenom} (${depDenom}) for deployment escrow and AKT (uakt) for gas/fees.`;
  throw new Error(
    `Insufficient spendable ${depDenom} for deployment escrow on ${endpoints.chainId} (account ${owner}): need at least ${depAmount}, have ${spendableStr}.${lockHint}${tail}`
  );
}

export async function createDeploymentTx(
  sdk: ChainNodeWebSDK,
  owner: string,
  yamlText: string,
  endpoints: AkashEndpoints,
  onStep: (s: DeployStep) => void
): Promise<{ dseq: string; groups: Manifest }> {
  onStep("creating_deployment");
  const preview = parseAndPreviewSdl(yamlText, endpoints);
  if (!preview.ok) {
    throw new Error(`Invalid SDL: ${JSON.stringify(preview.errors)}`);
  }
  const { groups, groupSpecs } = preview.value;

  const latest = await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const height = latest.block?.header?.height;
  if (height === undefined || height === null) throw new Error("Could not read latest block height");
  const dseq = Long.fromString(String(height));

  const hash = await generateManifestVersion(groups);

  const depDenom = endpoints.deploymentEscrowMinimalDenom;
  const depAmount = await readMinDeploymentDepositMicro(sdk, depDenom);

  await assertDeploymentEscrowBalance(sdk, owner, endpoints, depDenom, depAmount);
  assertSdlPricingMatchesDeposit(groupSpecs, depDenom);

  try {
    await sdk.akash.deployment.v1beta4.createDeployment({
      id: { owner, dseq },
      groups: groupSpecs,
      hash,
      deposit: {
        amount: { denom: depDenom, amount: depAmount },
        sources: [1],
      },
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (/deposit invalid/i.test(raw)) {
      const denoms = collectPricingDenomsFromGroupSpecs(groupSpecs);
      const parsed = denoms.length ? denoms.join(", ") : "(none)";
      const restBase = restBaseUrl(endpoints);
      const paramsUrl = `${restBase}/akash/deployment/v1beta4/params`;
      const bankUrl = `${restBase}/cosmos/bank/v1beta1/balances/${encodeURIComponent(owner)}?pagination.limit=200`;
      throw new Error(
        `${raw}\n\n` +
          `Deposit invalid on ${endpoints.chainId}: create-deployment used ${depAmount} ${depDenom}; parsed SDL pricing denoms: ${parsed}.\n` +
          `Confirm min deposits: ${paramsUrl}\n` +
          `Confirm balances (escrow + fee denoms): ${bankUrl}\n` +
          `Then Refresh balances and retry. If pricing denoms differ from ${depDenom}, fix the SDL first.`
      );
    }
    throw e;
  }

  return { dseq: dseq.toString(), groups };
}

export async function closeDeploymentTx(
  sdk: ChainNodeWebSDK,
  owner: string,
  dseq: string
): Promise<void> {
  await sdk.akash.deployment.v1beta4.closeDeployment({
    id: {
      owner,
      dseq: Long.fromString(dseq),
    },
  });
}

export async function pollBids(
  sdk: ChainNodeWebSDK,
  endpoints: AkashEndpoints,
  owner: string,
  dseq: string,
  opts?: { attempts?: number; delayMs?: number }
): Promise<MarketBidRecord[]> {
  const attempts = opts?.attempts ?? 24;
  const delayMs = opts?.delayMs ?? 5000;
  const dl = Long.fromString(dseq);
  for (let i = 0; i < attempts; i++) {
    let bids: MarketBidRecord[] = [];
    try {
      const res = await sdk.akash.market.v1beta5.getBids({
        filters: {
          owner,
          dseq: dl,
          gseq: 0,
          oseq: 0,
          provider: "",
          state: "open",
          bseq: 0,
        },
        pagination: page(50),
      });
      bids = (res.bids?.filter((b) => b.bid) ?? []) as MarketBidRecord[];
    } catch (error) {
      if (!isMalformedBase64Error(error)) throw error;
      bids = await listBidsViaRest(endpoints, owner, dseq);
    }
    if (bids.length > 0) return bids;
    await sleep(delayMs);
  }
  throw new Error("Timed out waiting for provider bids. Try raising the price in your SDL or retry later.");
}

export async function createLeaseTx(
  sdk: ChainNodeWebSDK,
  bid: MarketBidRecord,
  onStep: (s: DeployStep) => void
): Promise<MarketId> {
  onStep("creating_lease");
  const b = bid.bid;
  if (!b?.id) throw new Error("Invalid bid");
  await sdk.akash.market.v1beta5.createLease({ bidId: b.id as BidIdArg });
  return b.id;
}

export function providerHttpBase(hostUri: string): string {
  const t = hostUri.trim();
  if (t.startsWith("http://") || t.startsWith("https://")) return t.replace(/\/+$/, "");
  return `https://${t.replace(/\/+$/, "")}`;
}

export async function sendManifest(
  params: {
    owner: string;
    dseq: string;
    bidId: BidIdArg;
    groups: Manifest;
    signer: OfflineSigner;
    endpoints: AkashEndpoints;
    walletKind: WalletKind | null;
  },
  sdk: ChainNodeWebSDK,
  onStep: (s: DeployStep) => void
) {
  onStep("sending_manifest");
  const providerAddr = params.bidId.provider;
  if (!providerAddr) throw new Error("Missing provider on bid");

  const pinfo = await sdk.akash.provider.v1beta4.getProvider({ owner: providerAddr });
  const hostUri = pinfo.provider?.hostUri;
  if (!hostUri) throw new Error("Provider has no host URI");

  const base = providerHttpBase(hostUri);
  const token = await generateProviderJwt(params.signer, params.endpoints, params.owner, { access: "full" }, params.walletKind);

  const body = manifestToSortedJSON(params.groups);
  const url = `${base}/deployment/${params.dseq}/manifest`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Manifest upload failed (${res.status}): ${t}`);
  }
}

async function findActiveLease(
  sdk: ChainNodeWebSDK,
  endpoints: AkashEndpoints,
  owner: string,
  dseq: string
): Promise<MarketLeaseRecord["lease"] | undefined> {
  try {
    const leases = await sdk.akash.market.v1beta5.getLeases({
      filters: {
        owner,
        dseq: Long.fromString(dseq),
        gseq: 0,
        oseq: 0,
        provider: "",
        state: "active",
        bseq: 0,
      },
      pagination: page(5),
    });
    return leases.leases?.[0]?.lease as MarketLeaseRecord["lease"];
  } catch (error) {
    if (!isMalformedBase64Error(error)) throw error;
    return (await listLeasesViaRest(endpoints, owner, dseq))[0]?.lease;
  }
}

async function fetchProviderLeaseStatusJson(
  sdk: ChainNodeWebSDK,
  endpoints: AkashEndpoints,
  owner: string,
  dseq: string,
  signer: OfflineSigner,
  walletKind: WalletKind | null
): Promise<
  | { kind: "missing" }
  | { kind: "http_error"; statusCode: number; raw: string }
  | { kind: "json"; providerAddr: string; providerHostUri: string; statusUrl: string; json: unknown }
> {
  const lease = await findActiveLease(sdk, endpoints, owner, dseq);
  if (!lease?.id) return { kind: "missing" };
  const providerAddr = lease.id.provider;
  const pinfo = await sdk.akash.provider.v1beta4.getProvider({ owner: providerAddr });
  const hostUri = pinfo.provider?.hostUri;
  if (!hostUri) throw new Error("Provider has no host URI");
  const base = providerHttpBase(hostUri);
  const token = await generateProviderJwt(signer, endpoints, owner, { access: "full" }, walletKind);
  const gseq = lease.id.gseq ?? 1;
  const oseq = lease.id.oseq ?? 1;
  const statusUrl = `${base}/lease/${dseq}/${gseq}/${oseq}/status`;
  const res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return { kind: "http_error", statusCode: res.status, raw: await res.text() };
  }
  return {
    kind: "json",
    providerAddr,
    providerHostUri: hostUri,
    statusUrl,
    json: await res.json(),
  };
}

function parseLeaseAccessDetails(
  dseq: string,
  provider: string,
  providerHostUri: string,
  statusUrl: string,
  value: unknown
): LeaseAccessDetails {
  const servicesRaw = isRecord(value) && Array.isArray(readRecordValue(value, "services"))
    ? readRecordValue(value, "services")
    : [];
  const services = Array.isArray(servicesRaw)
    ? servicesRaw.map(parseLeaseAccessService).filter((entry): entry is LeaseAccessService => !!entry)
    : [];
  return {
    dseq,
    provider,
    providerHostUri,
    statusUrl,
    services,
    raw: value,
  };
}

export async function fetchLeaseAccessDetails(
  sdk: ChainNodeWebSDK,
  endpoints: AkashEndpoints,
  owner: string,
  dseq: string,
  signer: OfflineSigner,
  walletKind: WalletKind | null
): Promise<LeaseAccessDetails> {
  const result = await fetchProviderLeaseStatusJson(sdk, endpoints, owner, dseq, signer, walletKind);
  if (result.kind === "missing") {
    throw new Error("No active lease found yet.");
  }
  if (result.kind === "http_error") {
    throw new Error(`Status HTTP ${result.statusCode}: ${result.raw}`);
  }
  return parseLeaseAccessDetails(
    dseq,
    result.providerAddr,
    result.providerHostUri,
    result.statusUrl,
    result.json
  );
}

export async function fetchLeaseStatus(
  sdk: ChainNodeWebSDK,
  endpoints: AkashEndpoints,
  owner: string,
  dseq: string,
  signer: OfflineSigner,
  walletKind: WalletKind | null
) {
  const result = await fetchProviderLeaseStatusJson(sdk, endpoints, owner, dseq, signer, walletKind);
  if (result.kind === "missing") {
    return { text: "No active lease found yet." };
  }
  if (result.kind === "http_error") {
    return { text: `Status HTTP ${result.statusCode}`, raw: result.raw };
  }
  return { json: result.json };
}
