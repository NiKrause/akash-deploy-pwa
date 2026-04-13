import { createChainNodeWebSDK } from "@akashnetwork/chain-sdk/web";
import type { DeliverTxResponse } from "@cosmjs/stargate";

type ChainNodeWebSDK = ReturnType<typeof createChainNodeWebSDK>;

export interface BmeStatusSnapshot {
  statusCode: number;
  statusLabel: string;
  collateralRatio: string;
  mintsAllowed: boolean;
  refundsAllowed: boolean;
}

function mintStatusLabel(status: number): string {
  switch (status) {
    case 1:
      return "healthy";
    case 2:
      return "warning";
    case 3:
      return "halt_cr";
    case 4:
      return "halt_oracle";
    default:
      return "unknown";
  }
}

/**
 * Ledger status on MsgMintACTResponse / MsgBurnACTResponse.
 * The node does not populate `status` on these messages (only `id`), so clients often see `0`.
 */
function ledgerStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return "queued";
    case 1:
      return "pending";
    case 2:
      return "executed";
    case 3:
      return "canceled";
    default:
      return "unknown";
  }
}

function formatLedgerId(id: {
  height?: { toString(): string } | string | number;
  sequence?: { toString(): string } | string | number;
  denom?: string;
  toDenom?: string;
} | null | undefined): string | null {
  if (!id) return null;
  const height = id.height != null ? String(id.height) : "";
  const sequence = id.sequence != null ? String(id.sequence) : "";
  const pair = [id.denom, id.toDenom].filter(Boolean).join(" -> ");
  const core = [height, sequence].filter(Boolean).join(":");
  if (!core && !pair) return null;
  return [core, pair].filter(Boolean).join(" ");
}

export async function queryBmeStatus(sdk: ChainNodeWebSDK): Promise<BmeStatusSnapshot> {
  const res = await sdk.akash.bme.v1.getStatus({});
  return {
    statusCode: Number(res.status ?? 0),
    statusLabel: mintStatusLabel(Number(res.status ?? 0)),
    collateralRatio: res.collateralRatio ?? "",
    mintsAllowed: Boolean(res.mintsAllowed),
    refundsAllowed: Boolean(res.refundsAllowed),
  };
}

/** Parsed BME chain params used for client-side mint preflight. */
export interface BmeParamsSnapshot {
  /** Minimum minted `uact` per ledger execution (from `params.min_mint`). */
  minMintUact: bigint;
}

export async function queryBmeParams(sdk: ChainNodeWebSDK): Promise<BmeParamsSnapshot> {
  const res = await sdk.akash.bme.v1.getParams({});
  const coins = res.params?.minMint ?? [];
  let minMintUact = 0n;
  for (const c of coins) {
    if (c.denom === "uact" && c.amount) {
      try {
        const v = BigInt(c.amount.trim());
        if (v > minMintUact) minMintUact = v;
      } catch {
        /* ignore malformed entry */
      }
    }
  }
  return { minMintUact };
}

/**
 * Rough minimum `uakt` to burn so that oracle-priced mint output reaches `minMintUact`.
 * Uses USD per coin: mint_micro ≈ burn_micro * (aktUsd / actUsd). ACT is targeted at $1.
 */
export function approxMinBurnUaktForMinMint(minMintUact: bigint, aktUsdPerCoin: number, actUsdPerCoin = 1): bigint {
  if (minMintUact <= 0n) return 0n;
  if (!Number.isFinite(aktUsdPerCoin) || aktUsdPerCoin <= 0) return 0n;
  if (!Number.isFinite(actUsdPerCoin) || actUsdPerCoin <= 0) return 0n;
  const ratio = aktUsdPerCoin / actUsdPerCoin;
  const need = Number(minMintUact) / ratio;
  if (!Number.isFinite(need) || need <= 0) return 0n;
  return BigInt(Math.ceil(need));
}

interface BmeBroadcastOptions {
  afterBroadcast?: (tx: DeliverTxResponse) => void;
  memo?: string;
}

export async function submitMintActTx(
  sdk: ChainNodeWebSDK,
  owner: string,
  amountUakt: string,
  options?: BmeBroadcastOptions
) {
  let broadcast: DeliverTxResponse | undefined;
  const response = await sdk.akash.bme.v1.mintACT(
    {
      owner,
      to: owner,
      coinsToBurn: { denom: "uakt", amount: amountUakt },
    },
    {
      memo: options?.memo,
      afterBroadcast(tx) {
        broadcast = tx;
        options?.afterBroadcast?.(tx);
      },
    }
  );
  return {
    broadcast,
    response,
    statusLabel: ledgerStatusLabel(Number(response.status ?? 0)),
    ledgerId: formatLedgerId(response.id),
  };
}

export async function submitBurnActTx(
  sdk: ChainNodeWebSDK,
  owner: string,
  amountUact: string,
  options?: BmeBroadcastOptions
) {
  let broadcast: DeliverTxResponse | undefined;
  const response = await sdk.akash.bme.v1.burnACT(
    {
      owner,
      to: owner,
      coinsToBurn: { denom: "uact", amount: amountUact },
    },
    {
      memo: options?.memo,
      afterBroadcast(tx) {
        broadcast = tx;
        options?.afterBroadcast?.(tx);
      },
    }
  );
  return {
    broadcast,
    response,
    statusLabel: ledgerStatusLabel(Number(response.status ?? 0)),
    ledgerId: formatLedgerId(response.id),
  };
}
