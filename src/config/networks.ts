export type NetworkMode = "sandbox" | "mainnet" | "testnet";

export interface AkashEndpoints {
  mode: NetworkMode;
  chainId: string;
  chainName: string;
  /** Cosmos RPC (tendermint) for signing / broadcast */
  rpc: string;
  /** gRPC-gateway (REST) base URL for queries */
  rest: string;
  /** Human-readable network id for SDL (`sandbox` | `mainnet` | `testnet`) */
  sdlNetworkId: "sandbox" | "mainnet" | "testnet";
  /** Keplr coin type (Akash uses 118) */
  coinType: number;
  stakeCurrency: { coinDenom: string; coinMinimalDenom: string; coinDecimals: number };
  /** Initial deployment escrow + SDL placement pricing (sandbox/mainnet currently expect `uact`). */
  deploymentEscrowMinimalDenom: string;
  deploymentEscrowCoinDenom: string;
  bip44: { coinType: number };
  bech32Config: { bech32PrefixAccAddr: string };
  /** Explorer home (chain overview). */
  explorerHomeUrl: string;
  /** Replace `${accountAddress}` with the `akash1…` address. */
  explorerAccountUrlTemplate: string;
  /** Replace `${txHash}` with the transaction hash. Empty when no known explorer tx route exists. */
  explorerTxUrlTemplate: string;
  /** Short label for the explorer link. */
  explorerLabel: string;
  /** Optional same-origin/CORS provider proxy for manifest upload and lease status. */
  providerProxyUrl: string;
}

/** Build account URL from template (`…${accountAddress}…`). */
export function accountExplorerUrl(template: string, address: string): string {
  return template.includes("${accountAddress}")
    ? template.split("${accountAddress}").join(encodeURIComponent(address))
    : template;
}

/** Build transaction URL from template (`…${txHash}…`). */
export function txExplorerUrl(template: string, txHash: string): string {
  return template.includes("${txHash}") ? template.split("${txHash}").join(encodeURIComponent(txHash)) : template;
}

/**
 * BME testnet (`testnet-oracle`) gas faucet URLs.
 * `akash-network/net` still lists `oraclefaucet.dev.akash.pub` in `faucet-url.txt`, but that host is often unreachable;
 * the app defaults to `faucet.dev.akash.pub` first. Override with `VITE_TESTNET_FAUCET_URL` or a comma-separated
 * `VITE_TESTNET_FAUCET_URLS` (replaces the whole list).
 */
export function getTestnetFaucetUrls(): string[] {
  const multi = env("VITE_TESTNET_FAUCET_URLS", "");
  if (multi.trim()) {
    return multi
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const primary = env("VITE_TESTNET_FAUCET_URL", "https://faucet.dev.akash.pub/");
  const alt = env("VITE_TESTNET_FAUCET_ALT_URL", "https://oraclefaucet.dev.akash.pub/");
  const out: string[] = [];
  for (const u of [primary, alt]) {
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function env(name: string, fallback: string): string {
  const v = import.meta.env[name];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function deploymentEscrowFromEnv(): { minimalDenom: string; coinDenom: string } {
  const minimalDenom = env("VITE_DEPLOYMENT_ESCROW_DENOM", "uact");
  const coinDenom = env("VITE_DEPLOYMENT_ESCROW_COIN_DENOM", minimalDenom === "uakt" ? "AKT" : "ACT");
  return { minimalDenom, coinDenom };
}

function providerProxyUrlFromEnv(): string {
  return env("VITE_PROVIDER_PROXY_URL", "").trim().replace(/\/+$/, "");
}

/**
 * Defaults align with `@akashnetwork/chain-sdk` sandbox examples,
 * [Cosmos chain-registry](https://github.com/cosmos/chain-registry/tree/master/akash) mainnet APIs,
 * and [akash-network/net `testnet-oracle`](https://github.com/akash-network/net/tree/main/testnet-oracle) for the BME testnet (override via `.env`).
 * Note: gRPC-gateway for sandbox is `api.sandbox-2.aksh.pw`, not `rest.*` (that host does not resolve).
 */
export function getEndpoints(mode: NetworkMode): AkashEndpoints {
  const depEsc = deploymentEscrowFromEnv();
  const providerProxyUrl = providerProxyUrlFromEnv();
  if (mode === "sandbox") {
    return {
      mode,
      chainId: env("VITE_SANDBOX_CHAIN_ID", "sandbox-2"),
      chainName: env("VITE_SANDBOX_CHAIN_NAME", "Akash Sandbox"),
      rpc: env("VITE_SANDBOX_RPC", "https://rpc.sandbox-2.aksh.pw:443"),
      rest: env("VITE_SANDBOX_REST", "https://api.sandbox-2.aksh.pw:443"),
      sdlNetworkId: "sandbox",
      coinType: 118,
      stakeCurrency: {
        coinDenom: "AKT",
        coinMinimalDenom: "uakt",
        coinDecimals: 6,
      },
      deploymentEscrowMinimalDenom: depEsc.minimalDenom,
      deploymentEscrowCoinDenom: depEsc.coinDenom,
      bip44: { coinType: 118 },
      bech32Config: { bech32PrefixAccAddr: "akash" },
      explorerHomeUrl: env("VITE_SANDBOX_EXPLORER_HOME", "https://explorer.sandbox-2.aksh.pw/akash"),
      explorerAccountUrlTemplate: env(
        "VITE_SANDBOX_EXPLORER_ACCOUNT",
        "https://explorer.sandbox-2.aksh.pw/akash/account/${accountAddress}"
      ),
      explorerTxUrlTemplate: env("VITE_SANDBOX_EXPLORER_TX", "https://explorer.sandbox-2.aksh.pw/akash/tx/${txHash}"),
      explorerLabel: env("VITE_SANDBOX_EXPLORER_LABEL", "Sandbox explorer"),
      providerProxyUrl,
    };
  }
  if (mode === "testnet") {
    return {
      mode,
      /**
       * Public BME-capable testnet from `akash-network/net` (`testnet-oracle`).
       * Legacy `testnet-8` hosts `testnet{api,rpc}.akashnet.net` return Kubernetes 403 for anonymous REST/RPC.
       */
      chainId: env("VITE_TESTNET_CHAIN_ID", "testnet-oracle"),
      chainName: env("VITE_TESTNET_CHAIN_NAME", "Akash Testnet (Oracle / BME)"),
      rpc: env("VITE_TESTNET_RPC", "https://testnetoraclerpc.akashnet.net:443"),
      rest: env("VITE_TESTNET_REST", "https://testnetoracleapi.akashnet.net"),
      sdlNetworkId: "testnet",
      coinType: 118,
      stakeCurrency: {
        coinDenom: "AKT",
        coinMinimalDenom: "uakt",
        coinDecimals: 6,
      },
      deploymentEscrowMinimalDenom: depEsc.minimalDenom,
      deploymentEscrowCoinDenom: depEsc.coinDenom,
      bip44: { coinType: 118 },
      bech32Config: { bech32PrefixAccAddr: "akash" },
      explorerHomeUrl: env(
        "VITE_TESTNET_EXPLORER_HOME",
        "https://github.com/akash-network/net/tree/main/testnet-oracle"
      ),
      explorerAccountUrlTemplate: env("VITE_TESTNET_EXPLORER_ACCOUNT", ""),
      explorerTxUrlTemplate: env("VITE_TESTNET_EXPLORER_TX", ""),
      explorerLabel: env("VITE_TESTNET_EXPLORER_LABEL", "Testnet config (GitHub)"),
      providerProxyUrl,
    };
  }
  return {
    mode,
    chainId: env("VITE_MAINNET_CHAIN_ID", "akashnet-2"),
    chainName: env("VITE_MAINNET_CHAIN_NAME", "Akash"),
    rpc: env("VITE_MAINNET_RPC", "https://akash-rpc.publicnode.com:443"),
    rest: env("VITE_MAINNET_REST", "https://akash-rest.publicnode.com"),
    sdlNetworkId: "mainnet",
    coinType: 118,
    stakeCurrency: {
      coinDenom: "AKT",
      coinMinimalDenom: "uakt",
      coinDecimals: 6,
    },
    deploymentEscrowMinimalDenom: depEsc.minimalDenom,
    deploymentEscrowCoinDenom: depEsc.coinDenom,
    bip44: { coinType: 118 },
    bech32Config: { bech32PrefixAccAddr: "akash" },
    explorerHomeUrl: env("VITE_MAINNET_EXPLORER_HOME", "https://www.mintscan.io/akash"),
    explorerAccountUrlTemplate: env(
      "VITE_MAINNET_EXPLORER_ACCOUNT",
      "https://www.mintscan.io/akash/accounts/${accountAddress}"
    ),
    explorerTxUrlTemplate: env("VITE_MAINNET_EXPLORER_TX", "https://www.mintscan.io/akash/tx/${txHash}"),
    explorerLabel: env("VITE_MAINNET_EXPLORER_LABEL", "Mintscan"),
    providerProxyUrl,
  };
}

/** Legacy hostname that no longer resolves; replace when reading old session data. */
const LEGACY_SANDBOX_REST_SNIPPET = "rest.sandbox-2.aksh.pw";

/** Legacy `testnet-8` LCD/RPC on akashnet.net (Kubernetes ingress returned 403 for anonymous clients). */
const LEGACY_TESTNET8_REST_SNIPPETS = ["testnetapi.akashnet.net"];
const LEGACY_TESTNET8_RPC_SNIPPETS = ["testnetrpc.akashnet.net"];

/** Mainnet PublicNode defaults — must not be reused for sandbox/testnet or bank balances mirror mainnet. */
const MAINNET_PUBLICNODE_REST_SNIPPET = "akash-rest.publicnode.com";
const MAINNET_PUBLICNODE_RPC_SNIPPET = "akash-rpc.publicnode.com";

/** Normalize persisted RPC/REST (e.g. old sandbox REST host) so Keplr chain suggest can reach the node. */
export function sanitizePersistedRpcRest(mode: NetworkMode, rpc: string, rest: string): { rpc: string; rest: string } {
  const defaults = getEndpoints(mode);
  if (mode === "sandbox" && rest.includes(LEGACY_SANDBOX_REST_SNIPPET)) {
    return { rpc: rpc || defaults.rpc, rest: defaults.rest };
  }
  if (
    mode === "testnet" &&
    (LEGACY_TESTNET8_REST_SNIPPETS.some((h) => rest.includes(h)) ||
      LEGACY_TESTNET8_RPC_SNIPPETS.some((h) => rpc.includes(h)))
  ) {
    return { rpc: defaults.rpc, rest: defaults.rest };
  }
  if (
    (mode === "testnet" || mode === "sandbox") &&
    (rest.includes(MAINNET_PUBLICNODE_REST_SNIPPET) || rpc.includes(MAINNET_PUBLICNODE_RPC_SNIPPET))
  ) {
    return { rpc: defaults.rpc, rest: defaults.rest };
  }
  return { rpc: rpc || defaults.rpc, rest: rest || defaults.rest };
}
