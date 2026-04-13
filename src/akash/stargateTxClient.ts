import type { AccountData, EncodeObject, OfflineSigner } from "@cosmjs/proto-signing";
import { Registry } from "@cosmjs/proto-signing";
import {
  calculateFee,
  GasPrice,
  type HttpEndpoint,
  SigningStargateClient,
  type SigningStargateClientOptions,
  type StdFee,
  type DeliverTxResponse,
  type SignerData,
} from "@cosmjs/stargate";
import { getMessageType } from "akash-sdk-internal-chunk";

const DEFAULT_GAS_PRICE = "0.025uakt";
const DEFAULT_GAS_MULTIPLIER = 1.3;

export interface BrowserStargateClientOptions {
  rpc: string;
  signer: OfflineSigner;
  defaultGasPrice?: string;
  gasMultiplier?: number;
  stargateOptions?: Omit<SigningStargateClientOptions, "registry">;
  getAccount?(signer: OfflineSigner): Promise<AccountData>;
}

async function defaultGetAccount(signer: OfflineSigner): Promise<AccountData> {
  const accounts = await signer.getAccounts();
  if (accounts.length === 0) throw new Error("Signer has no accounts");
  return accounts[0];
}

/**
 * TxClient compatible with `createChainNodeWebSDK({ tx: { signer } })` using Keplr/CosmJS.
 */
export function createBrowserStargateClient(options: BrowserStargateClientOptions) {
  const builtInTypes: [string, import("@cosmjs/proto-signing").GeneratedType][] = [];
  const registry = new Registry(builtInTypes);
  const gasPrice = GasPrice.fromString(options.defaultGasPrice ?? DEFAULT_GAS_PRICE);
  const gasMultiplier = options.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER;
  const getAccount = options.getAccount ?? defaultGetAccount;

  let stargatePromise: Promise<SigningStargateClient> | undefined;

  const getStargate = () =>
    stargatePromise ??
    (stargatePromise = SigningStargateClient.connectWithSigner(
      options.rpc as unknown as HttpEndpoint,
      options.signer,
      {
        ...options.stargateOptions,
        registry,
      }
    ));

  function ensureMessageTypesRegistered(messages: EncodeObject[]) {
    for (const message of messages) {
      if (registry.lookupType(message.typeUrl)) continue;
      const type = getMessageType(message.typeUrl);
      if (!type) {
        throw new Error(`Cannot find message type ${message.typeUrl} in registry.`);
      }
      registry.register(message.typeUrl, type);
    }
    return messages;
  }

  async function estimateFeeInternal(messages: EncodeObject[], memo?: string): Promise<StdFee> {
    ensureMessageTypesRegistered(messages);
    const account = await getAccount(options.signer);
    const sg = await getStargate();
    const gas = await sg.simulate(account.address, messages, memo);
    const minGas = Math.floor(gasMultiplier * gas);
    return calculateFee(minGas, gasPrice);
  }

  async function signInternal(
    messages: EncodeObject[],
    fee: StdFee,
    memo: string,
    explicitSignerData?: SignerData,
    timeoutHeight?: bigint
  ) {
    ensureMessageTypesRegistered(messages);
    const account = await getAccount(options.signer);
    const sg = await getStargate();
    return sg.sign(account.address, messages, fee, memo, explicitSignerData, timeoutHeight);
  }

  async function broadcastInternal(
    txRaw: Awaited<ReturnType<SigningStargateClient["sign"]>>
  ): Promise<DeliverTxResponse> {
    const txTypeUrl = "/cosmos.tx.v1beta1.TxRaw";
    const TxRawType = registry.lookupType(txTypeUrl) ?? getMessageType(txTypeUrl);
    if (!TxRawType) throw new Error("TxRaw type not registered");
    const sg = await getStargate();
    return sg.broadcastTx(
      TxRawType.encode(txRaw as never).finish(),
      options.stargateOptions?.broadcastTimeoutMs,
      options.stargateOptions?.broadcastPollIntervalMs
    );
  }

  return {
    async signAndBroadcast(
      messages: EncodeObject[],
      signOpts?: {
        fee?: Partial<StdFee>;
        memo?: string;
        timeoutHeight?: bigint;
        afterSign?: (tx: unknown) => void;
        afterBroadcast?: (tx: DeliverTxResponse) => void;
      }
    ): Promise<DeliverTxResponse> {
      let fee: StdFee;
      const provided = signOpts?.fee;
      if (!provided?.amount?.length || !provided.gas) {
        const estimated = await estimateFeeInternal(messages, signOpts?.memo);
        fee = provided ? { ...estimated, ...provided } : estimated;
      } else {
        fee = provided as StdFee;
      }
      const txRaw = await signInternal(messages, fee, signOpts?.memo ?? "", undefined, signOpts?.timeoutHeight);
      signOpts?.afterSign?.(txRaw);
      const result = await broadcastInternal(txRaw);
      signOpts?.afterBroadcast?.(result);
      return result;
    },
  };
}
