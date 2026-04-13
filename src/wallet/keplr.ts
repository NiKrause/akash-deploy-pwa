import type { OfflineSigner } from "@cosmjs/proto-signing";
import { getEndpoints, type AkashEndpoints } from "../config/networks";

type StdSignatureLike = {
  signature: string;
};

type AminoSignResponseLike = {
  signature: StdSignatureLike;
};

type InjectedCosmosWallet = {
  enable: (chainId: string) => Promise<void>;
  getOfflineSigner: (chainId: string) => OfflineSigner & {
    signAmino?: (signerAddress: string, signDoc: unknown) => Promise<unknown>;
  };
  signArbitrary?: (chainId: string, signerAddress: string, data: string | Uint8Array) => Promise<StdSignatureLike>;
  signAmino?: (
    chainId: string,
    signerAddress: string,
    signDoc: unknown,
    signOptions?: unknown
  ) => Promise<AminoSignResponseLike>;
  experimentalSuggestChain?: (chainInfo: unknown) => Promise<void>;
};

declare global {
  interface Window {
    keplr?: InjectedCosmosWallet;
    leap?: InjectedCosmosWallet;
  }
}

export type WalletKind = "keplr" | "leap";

export function getWalletExtension(kind: WalletKind): InjectedCosmosWallet | undefined {
  return kind === "leap" ? window.leap : window.keplr;
}

function stakeCurrency(endpoints: AkashEndpoints) {
  const s = endpoints.stakeCurrency;
  return { ...s, coinGeckoId: "akash-network" as const };
}

/** Keplr rejects incomplete Bech32Config; Akash uses the `akash` HRP everywhere. */
function akashBech32Config(accPrefix: string) {
  const p = accPrefix;
  return {
    bech32PrefixAccAddr: p,
    bech32PrefixAccPub: `${p}pub`,
    bech32PrefixValAddr: `${p}valoper`,
    bech32PrefixValPub: `${p}valoperpub`,
    bech32PrefixConsAddr: `${p}valcons`,
    bech32PrefixConsPub: `${p}valconspub`,
  };
}

export function buildChainInfo(endpoints: AkashEndpoints) {
  const stake = stakeCurrency(endpoints);
  /** Keplr/Leap verify RPC+REST during suggest; use defaults for this mode (not broken UI overrides). */
  const registry = getEndpoints(endpoints.mode);
  const gasPriceStep = { low: 0.01, average: 0.025, high: 0.04 };

  const esc = endpoints.deploymentEscrowMinimalDenom;
  const escHuman = endpoints.deploymentEscrowCoinDenom;
  const escDecimals = endpoints.stakeCurrency.coinDecimals;
  const escrowCoin =
    esc !== stake.coinMinimalDenom
      ? { coinDenom: escHuman, coinMinimalDenom: esc, coinDecimals: escDecimals }
      : null;

  return {
    chainId: endpoints.chainId,
    chainName: endpoints.chainName,
    rpc: registry.rpc,
    rest: registry.rest,
    bip44: endpoints.bip44,
    bech32Config: akashBech32Config(endpoints.bech32Config.bech32PrefixAccAddr),
    stakeCurrency: stake,
    currencies: escrowCoin ? [stake, escrowCoin] : [stake],
    feeCurrencies: [{ ...stake, coinGeckoId: "akash-network", gasPriceStep }],
    features: [],
  };
}

export async function connectWallet(
  endpoints: AkashEndpoints,
  preferred: WalletKind = "keplr"
): Promise<{ address: string; signer: OfflineSigner; kind: WalletKind }> {
  const chainInfo = buildChainInfo(endpoints);
  const useLeap = preferred === "leap" && !!window.leap;
  const ext = getWalletExtension(useLeap ? "leap" : "keplr");
  if (!ext) {
    throw new Error(
      useLeap
        ? "Leap wallet not found. Install the Leap extension or choose Keplr."
        : "Keplr wallet not found. Install Keplr or try Leap."
    );
  }
  const suggest = ext.experimentalSuggestChain?.bind(ext);
  if (suggest) {
    try {
      await suggest(chainInfo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/reject|denied|cancel|closed/i.test(msg)) {
        throw new Error(msg);
      }
      if (/already|duplicate|registered|same chain|exists/i.test(msg)) {
        console.warn("experimentalSuggestChain (chain may already exist):", msg);
      } else {
        throw new Error(
          `Keplr could not register ${endpoints.chainName} (${endpoints.chainId}). ${msg}`
        );
      }
    }
  }
  try {
    await ext.enable(endpoints.chainId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Keplr could not enable ${endpoints.chainId}. If this is sandbox, approve “Add chain” when Keplr prompts. ${msg}`
    );
  }
  const signer = ext.getOfflineSigner(endpoints.chainId);
  const accounts = await signer.getAccounts();
  if (!accounts.length) throw new Error("Wallet returned no accounts");
  return {
    address: accounts[0].address,
    signer,
    kind: useLeap ? "leap" : "keplr",
  };
}
