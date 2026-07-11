import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accountExplorerUrl,
  getEndpoints,
  getTestnetFaucetUrls,
  sanitizePersistedRpcRest,
  txExplorerUrl,
  type NetworkMode,
} from "./config/networks";
import {
  DEFAULT_SDL_TEMPLATE_ID,
  SDL_TEMPLATES,
  alignSdlPricingDenomsToEscrow,
  getSdlTemplate,
  isSdlTemplateId,
  normalizeUcanStorePublicOrigin,
  type SdlTemplateId,
  type SdlTemplateParameter,
} from "./akash/defaultSdl";
import {
  closeDeploymentTx,
  createFullSdk,
  createQuerySdk,
  ensureClientCertificate,
  createDeploymentTx,
  fetchCurrentLeasesOverview,
  fetchLeaseAccessDetails,
  fetchLeaseStatus,
  getOfflineSignerPrimaryAddress,
  parseAndPreviewSdl,
  pollBids,
  createLeaseTx,
  queryBankSpendableAmount,
  sendManifest,
  type LeaseAccessDetails,
  type CurrentLeasesOverview,
  type DeployStep,
  type TxBroadcastSummary,
} from "./akash/deployService";
import { deploymentHasActiveLease, deploymentIsOpenOrReclaimable } from "./akash/leaseOverview";
import { collectLeaseSshCommands, isSdlSshPort } from "./akash/leaseSsh";
import { collectSdlExposedPorts, formatSdlExposedPortLabel } from "./akash/sdlPorts";
import { connectWallet, type WalletKind } from "./wallet/keplr";
import { probeRestGateway, probeTendermintRpc } from "./lib/endpointConnectivity";
import {
  fetchAktUsdPrice,
  formatUaktStringToAkt,
  formatUsd,
  uaktStringToAktNumber,
} from "./lib/aktMarket";
import { formatMicroAmount, isPositiveMicroAmountString } from "./lib/microAmount";
import { fetchTendermintBlockTime } from "./lib/tendermintBlock";
import "./App.css";

/** Akash sandbox-2 public faucet (AKT / uakt). */
const SANDBOX_AKASH_FAUCET_URL = "https://faucet.sandbox-2.aksh.pw/";
/** BME testnet (`testnet-oracle`) config and notes in `akash-network/net`. */
const TESTNET_BME_DOCS_URL = "https://github.com/akash-network/net/tree/main/testnet-oracle";
const APP_VERSION = import.meta.env.VITE_APP_VERSION;
const REPOSITORY_URL = import.meta.env.VITE_REPOSITORY_URL;

const STORAGE_KEY = "akash-deploy-pwa-session";

const EMPTY_WALLET_BALANCES = { uakt: null as string | null, deploymentEscrow: null as string | null };

type WalletBalanceSnapshot = { uakt: string; deploymentEscrow: string };

type Persisted = {
  network: NetworkMode;
  yaml: string;
  sdlTemplate?: SdlTemplateId | "custom";
  sdlTemplateValues?: Record<string, string>;
  ucanStorePublicOrigin?: string;
  dseq?: string;
  rest?: string;
  rpc?: string;
};

type LedState = "idle" | "ok" | "fail";
type LeaseView = "open" | "closed";
type DeploymentTxLink = TxBroadcastSummary & { label: string };
type SelectedSdlTemplate = SdlTemplateId | "custom";
type SdlTemplateValues = Record<string, string>;
type DomainVerification = {
  origin: string;
  status: "checking" | "ok" | "fail";
  message: string;
};
type OriginConfigureStatus = {
  origin: string;
  status: "configuring" | "ok" | "fail";
  message: string;
};

function shortenAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

function normalizeDecimalString(value: string | undefined | null): { intPart: string; fracPart: string } {
  const raw = (value ?? "").trim();
  if (!raw) return { intPart: "0", fracPart: "" };
  const unsigned = raw.startsWith("+") ? raw.slice(1) : raw;
  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".", 2);
  const intPart = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fracPart = fracRaw.replace(/0+$/, "");
  return { intPart, fracPart };
}

function compareDecimalStrings(a: string | undefined | null, b: string | undefined | null): number {
  const left = normalizeDecimalString(a);
  const right = normalizeDecimalString(b);
  if (left.intPart.length !== right.intPart.length) return left.intPart.length - right.intPart.length;
  if (left.intPart !== right.intPart) return left.intPart < right.intPart ? -1 : 1;
  const maxFracLen = Math.max(left.fracPart.length, right.fracPart.length);
  const leftFrac = left.fracPart.padEnd(maxFracLen, "0");
  const rightFrac = right.fracPart.padEnd(maxFracLen, "0");
  if (leftFrac === rightFrac) return 0;
  return leftFrac < rightFrac ? -1 : 1;
}

function readPersistedNetworkFields(): { network: NetworkMode; rest: string; rpc: string } {
  const p = loadPersisted();
  const net = (p?.network ?? "mainnet") as NetworkMode;
  const d = getEndpoints(net);
  const rawRest = p?.rest ?? d.rest;
  const rawRpc = p?.rpc ?? d.rpc;
  return { network: net, ...sanitizePersistedRpcRest(net, rawRpc, rawRest) };
}

function persistedTemplateValues(persisted: Persisted | null): SdlTemplateValues {
  if (persisted?.sdlTemplateValues) return persisted.sdlTemplateValues;
  if (persisted?.ucanStorePublicOrigin) {
    return { ucanStorePublicOrigin: persisted.ucanStorePublicOrigin };
  }
  return {};
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withTemplateDefaults(templateId: SelectedSdlTemplate, values: SdlTemplateValues): SdlTemplateValues {
  if (templateId !== "ucan-store" || values.ucanStoreConfigureToken?.trim()) return values;
  return { ...values, ucanStoreConfigureToken: randomToken() };
}

function loadPersisted(): Persisted | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    return p;
  } catch {
    return null;
  }
}

function savePersisted(p: Persisted) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

function deploymentCreatedAtKey(createdAt: string): string {
  return createdAt.trim();
}

function formatDeploymentCreatedAt(createdAt: string, blockTimeIso: string | undefined): string {
  const height = deploymentCreatedAtKey(createdAt);
  if (!height) return "Created time unavailable";
  const blockLabel = `block ${height}`;
  if (!blockTimeIso) return `Created at ${blockLabel}`;
  const date = new Date(blockTimeIso);
  if (Number.isNaN(date.getTime())) return `Created at ${blockLabel}`;
  return `Created ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${blockLabel})`;
}

function txHashShort(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : hash;
}

function formatGasSummary(tx: TxBroadcastSummary): string {
  if (tx.gasUsed && tx.gasWanted) return `gas ${tx.gasUsed}/${tx.gasWanted}`;
  if (tx.gasUsed) return `gas used ${tx.gasUsed}`;
  return "gas in explorer";
}

function recentAccountTxsRestUrl(restBase: string, owner: string): string {
  const url = new URL(`${restBase.trim().replace(/\/+$/, "")}/cosmos/tx/v1beta1/txs`);
  url.searchParams.append("events", `message.sender='${owner}'`);
  url.searchParams.set("order_by", "ORDER_BY_DESC");
  url.searchParams.set("pagination.limit", "50");
  return url.toString();
}

function blockTxsRestUrl(restBase: string, height: string): string | null {
  const h = height.trim();
  if (!/^\d+$/.test(h)) return null;
  const url = new URL(`${restBase.trim().replace(/\/+$/, "")}/cosmos/tx/v1beta1/txs`);
  url.searchParams.append("events", `tx.height=${h}`);
  url.searchParams.set("order_by", "ORDER_BY_DESC");
  url.searchParams.set("pagination.limit", "50");
  return url.toString();
}

function originHealthUrl(origin: string): string {
  return new URL("/health", origin).toString();
}

function originHostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

export default function App() {
  const persistedNetRef = useRef<ReturnType<typeof readPersistedNetworkFields> | null>(null);
  if (persistedNetRef.current === null) {
    persistedNetRef.current = readPersistedNetworkFields();
  }
  const [network, setNetwork] = useState<NetworkMode>(persistedNetRef.current.network);
  const [restInput, setRestInput] = useState(persistedNetRef.current.rest);
  const [rpcInput, setRpcInput] = useState(persistedNetRef.current.rpc);
  const [restLed, setRestLed] = useState<LedState>("idle");
  const [rpcLed, setRpcLed] = useState<LedState>("idle");
  const [probeMeta, setProbeMeta] = useState<{ rest?: string; rpc?: string }>({});
  const [probing, setProbing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const initialSelectedSdlTemplate = useMemo<SelectedSdlTemplate>(() => {
    const persisted = loadPersisted();
    if (persisted?.sdlTemplate === "custom") return "custom";
    return isSdlTemplateId(persisted?.sdlTemplate) ? persisted.sdlTemplate : DEFAULT_SDL_TEMPLATE_ID;
  }, []);
  const [selectedSdlTemplate, setSelectedSdlTemplate] =
    useState<SelectedSdlTemplate>(initialSelectedSdlTemplate);
  const [sdlTemplateValues, setSdlTemplateValues] = useState<SdlTemplateValues>(() =>
    withTemplateDefaults(initialSelectedSdlTemplate, persistedTemplateValues(loadPersisted()))
  );

  const endpoints = useMemo(() => {
    const base = getEndpoints(network);
    return {
      ...base,
      rest: restInput.trim() || base.rest,
      rpc: rpcInput.trim() || base.rpc,
    };
  }, [network, restInput, rpcInput]);
  const [yamlText, setYamlText] = useState(() => {
    const persisted = loadPersisted()?.yaml;
    const net = persistedNetRef.current!.network;
    const raw =
      persisted ??
      getSdlTemplate(
        net,
        initialSelectedSdlTemplate === "custom" ? DEFAULT_SDL_TEMPLATE_ID : initialSelectedSdlTemplate,
        withTemplateDefaults(initialSelectedSdlTemplate, persistedTemplateValues(loadPersisted()))
      );
    const esc = getEndpoints(net).deploymentEscrowMinimalDenom;
    return alignSdlPricingDenomsToEscrow(raw, esc);
  });
  const [address, setAddress] = useState<string | null>(null);
  const [walletKind, setWalletKind] = useState<WalletKind | null>(null);
  const [signer, setSigner] = useState<Awaited<ReturnType<typeof connectWallet>>["signer"] | null>(null);
  const [walletBalances, setWalletBalances] = useState(EMPTY_WALLET_BALANCES);
  const [currentLeases, setCurrentLeases] = useState<CurrentLeasesOverview | null>(null);
  const [currentLeasesError, setCurrentLeasesError] = useState<string | null>(null);
  const [leaseView, setLeaseView] = useState<LeaseView>("open");
  const [blockTimeByHeight, setBlockTimeByHeight] = useState<Record<string, string>>({});
  const [txLinksByDseq, setTxLinksByDseq] = useState<Record<string, DeploymentTxLink[]>>({});
  const [closingDeploymentDseq, setClosingDeploymentDseq] = useState<string | null>(null);
  const [leaseActionError, setLeaseActionError] = useState<string | null>(null);
  const [loadingLeaseAccessDseq, setLoadingLeaseAccessDseq] = useState<string | null>(null);
  const [leaseAccessByDseq, setLeaseAccessByDseq] = useState<Record<string, LeaseAccessDetails>>({});
  const [leaseAccessErrorByDseq, setLeaseAccessErrorByDseq] = useState<Record<string, string>>({});
  const [domainVerificationByDseq, setDomainVerificationByDseq] = useState<Record<string, DomainVerification>>({});
  const [originConfigureByDseq, setOriginConfigureByDseq] = useState<Record<string, OriginConfigureStatus>>({});
  /** Mainnet AKT spot in USD (CoinGecko), applied to the `uakt` balance line. */
  const [aktUsdPrice, setAktUsdPrice] = useState<number | null>(null);
  const [step, setStep] = useState<DeployStep>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dseq, setDseq] = useState<string | null>(() => loadPersisted()?.dseq ?? null);
  const [leaseInfo, setLeaseInfo] = useState<unknown>(null);

  const preview = useMemo(() => parseAndPreviewSdl(yamlText), [yamlText]);
  const sdlExposedPorts = useMemo(() => collectSdlExposedPorts(yamlText), [yamlText]);

  const balanceUaktDisplay = useMemo(() => formatUaktStringToAkt(walletBalances.uakt), [walletBalances.uakt]);
  const balanceUsdApprox = useMemo(() => {
    if (aktUsdPrice == null || walletBalances.uakt == null) return null;
    const akt = uaktStringToAktNumber(walletBalances.uakt);
    if (akt == null) return null;
    return formatUsd(akt * aktUsdPrice);
  }, [walletBalances.uakt, aktUsdPrice]);
  const escrowDisplay = useMemo(
    () => formatMicroAmount(walletBalances.deploymentEscrow),
    [walletBalances.deploymentEscrow]
  );
  const lockedEscrowDisplay = useMemo(
    () => formatMicroAmount(currentLeases?.lockedEscrowAmount ?? null),
    [currentLeases]
  );
  const reclaimableEscrowDisplay = useMemo(
    () => formatMicroAmount(currentLeases?.reclaimableEscrowAmount ?? null),
    [currentLeases]
  );
  const transferredEscrowDisplay = useMemo(
    () => formatMicroAmount(currentLeases?.transferredEscrowAmount ?? null),
    [currentLeases]
  );
  const openLeaseDeployments = useMemo(
    () => currentLeases?.deployments.filter(deploymentIsOpenOrReclaimable) ?? [],
    [currentLeases]
  );
  const closedLeaseDeployments = useMemo(
    () => currentLeases?.deployments.filter((deployment) => !deploymentIsOpenOrReclaimable(deployment)) ?? [],
    [currentLeases]
  );
  const visibleLeaseDeployments = leaseView === "open" ? openLeaseDeployments : closedLeaseDeployments;

  useEffect(() => {
    if (!address) {
      setAktUsdPrice(null);
      return;
    }
    let cancelled = false;
    void fetchAktUsdPrice().then((p) => {
      if (!cancelled) setAktUsdPrice(p);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    const heights = Array.from(
      new Set(
        visibleLeaseDeployments
          .map((deployment) => deploymentCreatedAtKey(deployment.createdAt))
          .filter((height) => /^\d+$/.test(height))
      )
    ).filter((height) => !Object.prototype.hasOwnProperty.call(blockTimeByHeight, height));

    if (heights.length === 0) return;

    let cancelled = false;
    void Promise.all(
      heights.map(async (height) => {
        try {
          return [height, (await fetchTendermintBlockTime(endpoints.rpc, height)) ?? ""] as const;
        } catch {
          return [height, ""] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setBlockTimeByHeight((existing) => {
        const next = { ...existing };
        for (const [height, time] of entries) {
          next[height] = time;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [blockTimeByHeight, endpoints.rpc, visibleLeaseDeployments]);

  useEffect(() => {
    savePersisted({
      network,
      yaml: yamlText,
      sdlTemplate: selectedSdlTemplate,
      sdlTemplateValues,
      dseq: dseq ?? undefined,
      rest: restInput,
      rpc: rpcInput,
    });
  }, [network, yamlText, selectedSdlTemplate, sdlTemplateValues, dseq, restInput, rpcInput]);

  const runEndpointTests = useCallback(async () => {
    setProbing(true);
    setProbeMeta({});
    setRestLed("idle");
    setRpcLed("idle");
    const base = getEndpoints(network);
    const rest = restInput.trim() || base.rest;
    const rpc = rpcInput.trim() || base.rpc;
    try {
      const [rRest, rRpc] = await Promise.all([probeRestGateway(rest), probeTendermintRpc(rpc)]);
      setRestLed(rRest.ok ? "ok" : "fail");
      setRpcLed(rRpc.ok ? "ok" : "fail");
      setProbeMeta({
        rest: rRest.ok ? undefined : rRest.error ?? rRest.status?.toString(),
        rpc: rRpc.ok ? undefined : rRpc.error ?? rRpc.status?.toString(),
      });
    } finally {
      setProbing(false);
    }
  }, [network, restInput, rpcInput]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  const addDeploymentTxLink = useCallback((dseqValue: string, label: string, tx: TxBroadcastSummary | null) => {
    if (!tx) return;
    setTxLinksByDseq((prev) => {
      const existing = prev[dseqValue] ?? [];
      if (existing.some((entry) => entry.transactionHash === tx.transactionHash && entry.label === label)) return prev;
      return { ...prev, [dseqValue]: [...existing, { ...tx, label }] };
    });
  }, []);

  const pushTxLog = useCallback(
    (label: string, tx: TxBroadcastSummary | null) => {
      if (!tx) return;
      pushLog(`${label} tx ${txHashShort(tx.transactionHash)} (${formatGasSummary(tx)})`);
    },
    [pushLog]
  );

  const loadWalletBalancesForAddress = useCallback(
    async (addr: string): Promise<WalletBalanceSnapshot> => {
      const q = createQuerySdk(endpoints);
      const esc = endpoints.deploymentEscrowMinimalDenom;
      const [uaktAmt, escAmt, usd, leasesOverview] = await Promise.all([
        queryBankSpendableAmount(q, addr, "uakt"),
        queryBankSpendableAmount(q, addr, esc),
        fetchAktUsdPrice(),
        fetchCurrentLeasesOverview(endpoints, addr).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setCurrentLeasesError(msg);
          return null;
        }),
      ]);
      setWalletBalances({ uakt: uaktAmt, deploymentEscrow: escAmt });
      setAktUsdPrice(usd);
      setCurrentLeases(leasesOverview);
      if (leasesOverview) setCurrentLeasesError(null);
      return { uakt: uaktAmt, deploymentEscrow: escAmt };
    },
    [endpoints]
  );

  const refreshBalance = useCallback(async () => {
    let addr = address;
    if (signer) {
      try {
        const live = await getOfflineSignerPrimaryAddress(signer);
        if (live !== address) setAddress(live);
        addr = live;
      } catch {
        /* keep addr = address */
      }
    }
    if (!addr) {
      setWalletBalances(EMPTY_WALLET_BALANCES);
      setCurrentLeases(null);
      setCurrentLeasesError(null);
      return;
    }
    await loadWalletBalancesForAddress(addr);
  }, [address, signer, loadWalletBalancesForAddress]);

  useEffect(() => {
    if (!address && !signer) {
      setWalletBalances(EMPTY_WALLET_BALANCES);
      return;
    }
    void refreshBalance();
  }, [address, signer, endpoints, refreshBalance]);

  useEffect(() => {
    const onKeyStoreChange = () => {
      void refreshBalance();
    };
    window.addEventListener("keplr_keystorechange", onKeyStoreChange);
    return () => window.removeEventListener("keplr_keystorechange", onKeyStoreChange);
  }, [refreshBalance]);

  useEffect(() => {
    setClosingDeploymentDseq(null);
    setLoadingLeaseAccessDseq(null);
    setLeaseActionError(null);
    setLeaseAccessByDseq({});
    setLeaseAccessErrorByDseq({});
    setTxLinksByDseq({});
  }, [address, endpoints.chainId]);

  const onConnect = async (kind: WalletKind) => {
    setError(null);
    try {
      const w = await connectWallet(endpoints, kind);
      setAddress(w.address);
      setSigner(w.signer);
      setWalletKind(w.kind);
      pushLog(`Connected ${w.kind}: ${w.address}`);
      await loadWalletBalancesForAddress(w.address);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      pushLog(`Wallet error: ${msg}`);
    }
  };

  const onDeploy = async () => {
    if (!signer || !address) {
      setError("Connect a wallet first.");
      return;
    }
    if (!preview.ok) {
      setError("Fix SDL errors before deploying.");
      return;
    }
    setError(null);
    setLeaseInfo(null);
    setLog([]);
    setStep("idle");

    const onStep = (s: DeployStep) => {
      setStep(s);
      pushLog(`Step: ${s}`);
    };

    try {
      const owner = await getOfflineSignerPrimaryAddress(signer);
      if (owner !== address) {
        setAddress(owner);
        pushLog(`Active wallet account: ${owner}`);
      }
      const snap = await loadWalletBalancesForAddress(owner);
      pushLog(
        endpoints.deploymentEscrowMinimalDenom === "uakt"
          ? `Preflight for ${owner}: ${snap.uakt} uakt`
          : `Preflight for ${owner}: ${snap.uakt} uakt (gas); ${snap.deploymentEscrow} ${endpoints.deploymentEscrowMinimalDenom} (${endpoints.deploymentEscrowCoinDenom} escrow)`
      );
      const sdk = createFullSdk(endpoints, signer);
      const certTx = await ensureClientCertificate(sdk, owner, onStep);
      pushTxLog("Certificate", certTx);
      const dep = await createDeploymentTx(sdk, owner, yamlText, endpoints, onStep);
      setDseq(dep.dseq);
      addDeploymentTxLink(dep.dseq, "Create deployment", dep.tx);
      pushTxLog(`Create deployment ${dep.dseq}`, dep.tx);
      onStep("waiting_bids");
      const bids = await pollBids(sdk, endpoints, owner, dep.dseq);
      bids.sort((a, b) => {
        return compareDecimalStrings(a.bid?.price?.amount, b.bid?.price?.amount);
      });
      const chosen = bids[0];
      const leaseTx = await createLeaseTx(sdk, chosen, onStep);
      addDeploymentTxLink(dep.dseq, "Create lease", leaseTx.tx);
      pushTxLog(`Create lease ${dep.dseq}`, leaseTx.tx);
      await sendManifest(
        {
          owner,
          dseq: dep.dseq,
          bidId: leaseTx.bidId,
          groups: dep.groups,
          signer,
          endpoints,
          walletKind,
        },
        sdk,
        onStep
      );
      onStep("done");
      const status = await fetchLeaseStatus(sdk, endpoints, owner, dep.dseq, signer, walletKind);
      setLeaseInfo("json" in status ? status.json : status);
      await loadWalletBalancesForAddress(owner);
      pushLog("Deployment flow finished.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStep("error");
      pushLog(`Error: ${msg}`);
    }
  };

  const onCloseDeployment = useCallback(
    async (dseqToClose: string) => {
      if (!signer || !address) {
        setLeaseActionError("Connect a wallet first.");
        return;
      }
      setLeaseActionError(null);
      setClosingDeploymentDseq(dseqToClose);
      try {
        const owner = await getOfflineSignerPrimaryAddress(signer);
        if (owner !== address) setAddress(owner);
        const sdk = createFullSdk(endpoints, signer);
        pushLog(`Closing deployment ${dseqToClose}...`);
        const tx = await closeDeploymentTx(sdk, owner, dseqToClose);
        addDeploymentTxLink(dseqToClose, "Close deployment", tx);
        pushTxLog(`Close deployment ${dseqToClose}`, tx);
        pushLog(`Closed deployment ${dseqToClose}. Refreshing wallet and lease overview...`);
        await loadWalletBalancesForAddress(owner);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLeaseActionError(msg);
        pushLog(`Close deployment failed for ${dseqToClose}: ${msg}`);
      } finally {
        setClosingDeploymentDseq(null);
      }
    },
    [addDeploymentTxLink, address, endpoints, loadWalletBalancesForAddress, pushLog, pushTxLog, signer]
  );

  const onLoadLeaseAccess = useCallback(
    async (dseqToLoad: string) => {
      if (!signer || !address) {
        setLeaseAccessErrorByDseq((prev) => ({ ...prev, [dseqToLoad]: "Connect a wallet first." }));
        return;
      }
      setLeaseAccessErrorByDseq((prev) => {
        const next = { ...prev };
        delete next[dseqToLoad];
        return next;
      });
      setLoadingLeaseAccessDseq(dseqToLoad);
      try {
        const owner = await getOfflineSignerPrimaryAddress(signer);
        if (owner !== address) setAddress(owner);
        const sdk = createQuerySdk(endpoints);
        pushLog(`Loading provider access details for deployment ${dseqToLoad}...`);
        const details = await fetchLeaseAccessDetails(sdk, endpoints, owner, dseqToLoad, signer, walletKind);
        setLeaseAccessByDseq((prev) => ({ ...prev, [dseqToLoad]: details }));
        pushLog(`Loaded provider access details for deployment ${dseqToLoad}.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLeaseAccessErrorByDseq((prev) => ({ ...prev, [dseqToLoad]: msg }));
        pushLog(`Lease access details failed for ${dseqToLoad}: ${msg}`);
      } finally {
        setLoadingLeaseAccessDseq((current) => (current === dseqToLoad ? null : current));
      }
    },
    [address, endpoints, pushLog, signer, walletKind]
  );

  const selectSdlTemplate = useCallback(
    (templateId: SdlTemplateId) => {
      const nextValues = withTemplateDefaults(templateId, sdlTemplateValues);
      setSdlTemplateValues(nextValues);
      setSelectedSdlTemplate(templateId);
      setYamlText(getSdlTemplate(network, templateId, nextValues));
    },
    [network, sdlTemplateValues]
  );

  const editYamlText = useCallback((nextYaml: string) => {
    setSelectedSdlTemplate("custom");
    setYamlText(nextYaml);
  }, []);

  const updateSdlTemplateParameter = useCallback(
    (parameterId: string, nextValue: string) => {
      setSdlTemplateValues((prev) => {
        const next = { ...prev, [parameterId]: nextValue };
        if (isSdlTemplateId(selectedSdlTemplate)) {
          setYamlText(getSdlTemplate(network, selectedSdlTemplate, next));
        }
        return next;
      });
    },
    [network, selectedSdlTemplate]
  );

  const selectNetwork = useCallback(
    (nextNetwork: NetworkMode) => {
      setNetwork(nextNetwork);
      const defaults = getEndpoints(nextNetwork);
      const nextTemplate = selectedSdlTemplate === "custom" ? DEFAULT_SDL_TEMPLATE_ID : selectedSdlTemplate;
      setRestInput(defaults.rest);
      setRpcInput(defaults.rpc);
      setRestLed("idle");
      setRpcLed("idle");
      setProbeMeta({});
      setAddress(null);
      setSigner(null);
      setWalletKind(null);
      setWalletBalances(EMPTY_WALLET_BALANCES);
      setCurrentLeases(null);
      setCurrentLeasesError(null);
      setSelectedSdlTemplate(nextTemplate);
      const nextValues = withTemplateDefaults(nextTemplate, sdlTemplateValues);
      setSdlTemplateValues(nextValues);
      setYamlText(getSdlTemplate(nextNetwork, nextTemplate, nextValues));
    },
    [selectedSdlTemplate, sdlTemplateValues]
  );

  const hasLeaseSection = address !== null && currentLeases !== null;
  const walletSectionNumber = 1;
  const leasesSectionNumber = 2;
  const sdlSectionNumber = hasLeaseSection ? 3 : 2;
  const deploySectionNumber = hasLeaseSection ? 4 : 3;
  const activeSdlTemplate =
    selectedSdlTemplate === "custom"
      ? null
      : SDL_TEMPLATES.find((template) => template.id === selectedSdlTemplate) ?? null;
  const publicOriginParameter = activeSdlTemplate?.parameters?.find((parameter) => parameter.role === "publicOrigin");
  const configureTokenParameter = activeSdlTemplate?.parameters?.find((parameter) => parameter.role === "configureToken");
  const configuredPublicOrigin = publicOriginParameter
    ? normalizeUcanStorePublicOrigin(sdlTemplateValues[publicOriginParameter.id] ?? "")
    : "";
  const configureToken = configureTokenParameter ? (sdlTemplateValues[configureTokenParameter.id] ?? "").trim() : "";

  const configureServiceOrigin = useCallback(
    async (dseqToConfigure: string, requestOrigin: string, publicOrigin: string) => {
      const configureUrl = new URL("/configure", requestOrigin).toString();
      setOriginConfigureByDseq((prev) => ({
        ...prev,
        [dseqToConfigure]: {
          origin: publicOrigin,
          status: "configuring",
          message: `Configuring ${publicOrigin} via ${configureUrl}...`,
        },
      }));

      try {
        if (!configureToken) throw new Error("Missing configure token.");
        const response = await fetch(configureUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configureToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ publicOrigin }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        setOriginConfigureByDseq((prev) => ({
          ...prev,
          [dseqToConfigure]: {
            origin: publicOrigin,
            status: "ok",
            message: `Configured public origin ${publicOrigin}.`,
          },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setOriginConfigureByDseq((prev) => ({
          ...prev,
          [dseqToConfigure]: {
            origin: publicOrigin,
            status: "fail",
            message: `Configure failed: ${msg}`,
          },
        }));
      }
    },
    [configureToken]
  );

  const verifyPublicOrigin = useCallback(async (dseqToVerify: string, origin: string) => {
    const healthUrl = originHealthUrl(origin);
    setDomainVerificationByDseq((prev) => ({
      ...prev,
      [dseqToVerify]: {
        origin,
        status: "checking",
        message: `Checking ${healthUrl}...`,
      },
    }));

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setDomainVerificationByDseq((prev) => ({
        ...prev,
        [dseqToVerify]: {
          origin,
          status: "ok",
          message: `Confirmed: this browser reached ${healthUrl}.`,
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDomainVerificationByDseq((prev) => ({
        ...prev,
        [dseqToVerify]: {
          origin,
          status: "fail",
          message: `Could not reach ${healthUrl}: ${msg}`,
        },
      }));
    }
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="header-title">
            <h1>Akash Deploy</h1>
            <span className="app-version">v{APP_VERSION}</span>
          </div>
          <div className="header-links">
            {network === "sandbox" ? (
              <nav className="header-faucets" aria-label="Akash sandbox faucet">
                <span className="header-faucets-label">Sandbox faucet</span>
                <a
                  href={SANDBOX_AKASH_FAUCET_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="header-faucet-link"
                >
                  Akash sandbox
                </a>
              </nav>
            ) : network === "testnet" ? (
              <nav className="header-faucets" aria-label="Akash BME testnet links">
                <span className="header-faucets-label">Testnet links</span>
                {getTestnetFaucetUrls().map((href, i) => (
                  <Fragment key={href}>
                    {i > 0 ? <span className="explorer-sep"> · </span> : null}
                    <a href={href} target="_blank" rel="noopener noreferrer" className="header-faucet-link">
                      {i === 0 ? "Faucet" : "Alternate"}
                    </a>
                  </Fragment>
                ))}
                <span className="explorer-sep"> · </span>
                <a href={TESTNET_BME_DOCS_URL} target="_blank" rel="noopener noreferrer" className="header-faucet-link">
                  BME docs
                </a>
              </nav>
            ) : null}
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              aria-label="Open GitHub repository"
              title="Open GitHub repository"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  fill="currentColor"
                  d="M12 2C6.48 2 2 6.58 2 12.26c0 4.53 2.87 8.38 6.84 9.74.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.88-2.78.62-3.37-1.21-3.37-1.21-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 7.02c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.95.68 1.92 0 1.38-.01 2.5-.01 2.85 0 .27.18.59.69.49A10.08 10.08 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"
                />
              </svg>
            </a>
          </div>
        </div>
        <p className="subtitle">
          Wallet-only tenant deploy: preview your SDL, sign transactions in Keplr or Leap, then wait for bids, accept a
          lease, and upload the manifest to the provider.
        </p>
      </header>

      <section className="advanced-network">
        <button
          type="button"
          className="secondary advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          Advanced network
        </button>
        <span className="muted small advanced-network-summary">
          {endpoints.chainName} · <code>{endpoints.chainId}</code>
        </span>
      </section>

      {advancedOpen ? (
      <section className="card">
        <h2>Advanced Network</h2>
        <div className="row">
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "sandbox"}
              onChange={() => selectNetwork("sandbox")}
            />{" "}
            Sandbox (recommended for testing)
          </label>
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "mainnet"}
              onChange={() => selectNetwork("mainnet")}
            />{" "}
            Mainnet
          </label>
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "testnet"}
              onChange={() => selectNetwork("testnet")}
            />{" "}
            Testnet (BME / testnet-oracle)
          </label>
        </div>
        <p className="muted small chain-id-line">
          chainId <code>{endpoints.chainId}</code> · gas <code>uakt</code> (AKT) · deploy/SDL escrow{" "}
          <code>{endpoints.deploymentEscrowMinimalDenom}</code> ({endpoints.deploymentEscrowCoinDenom})
        </p>

        <div className="endpoint-field">
          <label className="endpoint-label">
            <span className="led-wrap" title={probeMeta.rest ?? (restLed === "ok" ? "REST reachable" : "REST not tested")}>
              <span className={`led led-${restLed}`} aria-hidden />
            </span>
            REST (gRPC-gateway)
          </label>
          <input
            type="url"
            className="endpoint-input"
            value={restInput}
            onChange={(e) => {
              setRestInput(e.target.value);
              setRestLed("idle");
              setProbeMeta((m) => ({ ...m, rest: undefined }));
            }}
            placeholder={getEndpoints(network).rest}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {probeMeta.rest ? <p className="probe-error small">{probeMeta.rest}</p> : null}

        <div className="endpoint-field">
          <label className="endpoint-label">
            <span className="led-wrap" title={probeMeta.rpc ?? (rpcLed === "ok" ? "RPC reachable" : "RPC not tested")}>
              <span className={`led led-${rpcLed}`} aria-hidden />
            </span>
            RPC (Tendermint)
          </label>
          <input
            type="url"
            className="endpoint-input"
            value={rpcInput}
            onChange={(e) => {
              setRpcInput(e.target.value);
              setRpcLed("idle");
              setProbeMeta((m) => ({ ...m, rpc: undefined }));
            }}
            placeholder={getEndpoints(network).rpc}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {probeMeta.rpc ? <p className="probe-error small">{probeMeta.rpc}</p> : null}

        <div className="row endpoint-actions">
          <button type="button" className="secondary" disabled={probing} onClick={() => void runEndpointTests()}>
            {probing ? "Testing…" : "Test connections"}
          </button>
          <span className="muted small">
            REST checks <code>GET …/cosmos/base/tendermint/v1beta1/node_info</code>; RPC checks <code>GET …/status</code>.
          </span>
        </div>
      </section>
      ) : null}

      <section className="card">
        <h2>{walletSectionNumber}. Wallet</h2>
        {!address ? (
          <div className="row">
            <button type="button" onClick={() => void onConnect("keplr")}>
              Connect Keplr
            </button>
            <button type="button" className="secondary" onClick={() => void onConnect("leap")}>
              Connect Leap
            </button>
          </div>
        ) : (
          <div>
            <p className="wallet-address-row">
              <strong>{walletKind}</strong>:{" "}
              <a
                className="explorer-address"
                href={accountExplorerUrl(endpoints.explorerAccountUrlTemplate, address)}
                target="_blank"
                rel="noopener noreferrer"
                title="Open account in chain explorer"
              >
                {address}
              </a>
            </p>
            <p className="muted small wallet-explorer-links">
              <a href={endpoints.explorerHomeUrl} target="_blank" rel="noopener noreferrer">
                {endpoints.explorerLabel}
              </a>
              <span className="explorer-sep"> · </span>
              <a
                href={accountExplorerUrl(endpoints.explorerAccountUrlTemplate, address)}
                target="_blank"
                rel="noopener noreferrer"
              >
                This account
              </a>
            </p>
            <div className="wallet-balance">
              {endpoints.deploymentEscrowMinimalDenom !== "uakt" ? (
                <div className="escrow-hero">
                  <div className="escrow-hero-copy">
                    <span className="escrow-hero-eyebrow">Spendable {endpoints.deploymentEscrowCoinDenom} escrow</span>
                    <strong className="escrow-hero-amount">
                      {escrowDisplay ?? "…"} {endpoints.deploymentEscrowCoinDenom}
                    </strong>
                    <span className="escrow-hero-raw">
                      <code>{walletBalances.deploymentEscrow ?? "…"}</code> {endpoints.deploymentEscrowMinimalDenom}
                    </span>
                  </div>
                  <button type="button" className="secondary tiny" onClick={() => void refreshBalance()}>
                    Refresh
                  </button>
                </div>
              ) : null}
              <p className="muted balance-main balance-main-gas">
                <span className="balance-akt-label">AKT (gas):</span>{" "}
                <strong title="Akash uses AKT; on-chain amount is in micro-units (uakt).">
                  {balanceUaktDisplay ?? "…"} AKT
                </strong>
                {balanceUsdApprox ? (
                  <span className="balance-usd" title="Indicative spot value (CoinGecko mainnet AKT / USD).">
                    ≈ {balanceUsdApprox} USD
                  </span>
                ) : null}
                {endpoints.deploymentEscrowMinimalDenom === "uakt" ? (
                  <button type="button" className="secondary tiny" onClick={() => void refreshBalance()}>
                    Refresh
                  </button>
                ) : null}
              </p>
              <p className="muted small balance-raw">
                Spendable AKT gas: <code>{walletBalances.uakt ?? "…"}</code> uakt
                {aktUsdPrice != null ? (
                  <>
                    {" "}
                    · AKT/USD spot: <code>${aktUsdPrice.toFixed(4)}</code> (CoinGecko)
                  </>
                ) : null}
              </p>
              {currentLeases ? (
                <div className="wallet-balance-summary">
                  <span>
                    Tracked deployments: <strong>{currentLeases.totalDeploymentCount}</strong>
                  </span>
                  <span>
                    Active/open shown: <strong>{openLeaseDeployments.length}</strong>
                  </span>
                  <span>
                    Active leases: <strong>{currentLeases.activeLeaseCount}</strong>
                  </span>
                  <span>
                    Locked {endpoints.deploymentEscrowCoinDenom}:{" "}
                    <strong>{lockedEscrowDisplay ?? "…"} {endpoints.deploymentEscrowCoinDenom}</strong>
                  </span>
                  <span>
                    Likely reclaimable now:{" "}
                    <strong>{reclaimableEscrowDisplay ?? "…"} {endpoints.deploymentEscrowCoinDenom}</strong>
                  </span>
                  <span>
                    Already paid out: <strong>{transferredEscrowDisplay ?? "…"} {endpoints.deploymentEscrowCoinDenom}</strong>
                  </span>
                </div>
              ) : null}
              {currentLeasesError ? <p className="error small">{currentLeasesError}</p> : null}
              {endpoints.deploymentEscrowMinimalDenom !== "uakt" ? (
                <p className="muted small wallet-akt-hint">
                  {endpoints.deploymentEscrowCoinDenom} is locked per deployment until that deployment is closed. AKT pays
                  transaction gas and does not come back after failed or successful signing attempts.
                </p>
              ) : null}
              {endpoints.mode === "sandbox" ? (
                <p className="muted small wallet-akt-hint">
                  Gas uses <strong>AKT</strong> (<code>uakt</code>). Deployment escrow on this network uses{" "}
                  <strong>{endpoints.deploymentEscrowCoinDenom}</strong> (<code>{endpoints.deploymentEscrowMinimalDenom}</code>
                  ).{" "}
                  <a href={SANDBOX_AKASH_FAUCET_URL} target="_blank" rel="noopener noreferrer">
                    Sandbox faucet
                  </a>
                  .
                </p>
              ) : null}
              {endpoints.mode === "testnet" ? (
                <p className="muted small wallet-akt-hint">
                  Gas is test <code>uakt</code> on <code>{endpoints.chainId}</code> (same <code>akash1…</code> string as
                  mainnet, different ledger). Request funds from the{" "}
                  {getTestnetFaucetUrls().map((href, i) => (
                    <Fragment key={href}>
                      {i > 0 ? " or " : null}
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {i === 0 ? "faucet" : "alternate"}
                      </a>
                    </Fragment>
                  ))}{" "}
                  in the header (defaults prefer <code>faucet.dev.akash.pub</code>; the host in{" "}
                  <code>net/…/faucet-url.txt</code> is often down). See also{" "}
                  <a href={TESTNET_BME_DOCS_URL} target="_blank" rel="noopener noreferrer">
                    BME testnet docs
                  </a>
                  .
                </p>
              ) : null}
            </div>
          </div>
        )}
        {!address && error ? <p className="error">{error}</p> : null}
      </section>

      {address && currentLeases ? (
        <section className="card">
          <h2>{leasesSectionNumber}. Current Leases</h2>
          <p className="muted small">
            Deployments hold escrow in {endpoints.deploymentEscrowMinimalDenom}. Closing unused deployments should return
            that ACT to your spendable balance; AKT gas is not refundable.
          </p>
          {leaseActionError ? <p className="error small">{leaseActionError}</p> : null}
          {currentLeases.deployments.length > 0 ? (
            <div className="lease-view-tabs" role="tablist" aria-label="Lease deployment filter">
              <button
                type="button"
                role="tab"
                aria-selected={leaseView === "open"}
                className={`secondary tiny lease-view-tab ${leaseView === "open" ? "lease-view-tab-active" : ""}`}
                onClick={() => setLeaseView("open")}
              >
                Active / open ({openLeaseDeployments.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={leaseView === "closed"}
                className={`secondary tiny lease-view-tab ${leaseView === "closed" ? "lease-view-tab-active" : ""}`}
                onClick={() => setLeaseView("closed")}
              >
                Inactive / closed ({closedLeaseDeployments.length})
              </button>
            </div>
          ) : null}
          <div className="leases-grid">
            {currentLeases.deployments.length === 0 ? (
              <p className="muted small">No deployments found for this account on {endpoints.chainId}.</p>
            ) : visibleLeaseDeployments.length === 0 ? (
              <p className="muted small">
                {leaseView === "open"
                  ? "No active, open, or reclaimable deployments found. Closed deployments are hidden in the inactive tab."
                  : "No fully closed deployments are hidden for this account."}
              </p>
            ) : (
              visibleLeaseDeployments.map((deployment) => {
                const hasActiveLease = deploymentHasActiveLease(deployment);
                const isClosing = closingDeploymentDseq === deployment.dseq;
                const isLoadingAccess = loadingLeaseAccessDseq === deployment.dseq;
                const accessDetails = leaseAccessByDseq[deployment.dseq];
                const accessError = leaseAccessErrorByDseq[deployment.dseq];
                const createdAtHeight = deploymentCreatedAtKey(deployment.createdAt);
                const createdBlockTxsUrl = blockTxsRestUrl(endpoints.rest, createdAtHeight);
                const accountTxsUrl = address ? accountExplorerUrl(endpoints.explorerAccountUrlTemplate, address) : "";
                const rawAccountTxsUrl = address ? recentAccountTxsRestUrl(endpoints.rest, address) : "";
                const exactTxLinks = txLinksByDseq[deployment.dseq] ?? [];
                const lockedEscrowPositive = isPositiveMicroAmountString(deployment.lockedEscrowAmount);
                const deploymentClosed = deployment.deploymentState === "closed";
                const escrowClosed = deployment.escrowState === "closed";
                const archiveNoLeaseNothingToReclaim =
                  deployment.leases.length === 0 && deploymentClosed && escrowClosed && !lockedEscrowPositive;
                const canOfferCloseDeployment = !deploymentClosed;
                return (
                  <article key={deployment.dseq} className="lease-card">
                    <div className="lease-card-head">
                      <strong>dseq {deployment.dseq}</strong>
                      <span className={`lease-pill lease-pill-${hasActiveLease ? "active" : "idle"}`}>
                        {hasActiveLease ? "Active lease" : "No active lease"}
                      </span>
                    </div>
                    <p className="muted small lease-meta">
                      Deployment {deployment.deploymentState} · group {deployment.groupState} · escrow {deployment.escrowState}
                    </p>
                    <p className="muted small lease-meta">
                      {formatDeploymentCreatedAt(deployment.createdAt, blockTimeByHeight[createdAtHeight])}
                    </p>
                    <div className="lease-explorer-links">
                      {accountTxsUrl ? (
                        <a href={accountTxsUrl} target="_blank" rel="noopener noreferrer">
                          {endpoints.explorerLabel} account txs
                        </a>
                      ) : null}
                      {createdBlockTxsUrl ? (
                        <a href={createdBlockTxsUrl} target="_blank" rel="noopener noreferrer">
                          Raw block txs
                        </a>
                      ) : null}
                      {rawAccountTxsUrl ? (
                        <a href={rawAccountTxsUrl} target="_blank" rel="noopener noreferrer">
                          Raw recent txs
                        </a>
                      ) : null}
                      {exactTxLinks.map((tx) => {
                        const txUrl = endpoints.explorerTxUrlTemplate
                          ? txExplorerUrl(endpoints.explorerTxUrlTemplate, tx.transactionHash)
                          : "";
                        const text = `${tx.label}: ${txHashShort(tx.transactionHash)} (${formatGasSummary(tx)})`;
                        return txUrl ? (
                          <a key={`${tx.label}-${tx.transactionHash}`} href={txUrl} target="_blank" rel="noopener noreferrer">
                            {text}
                          </a>
                        ) : (
                          <code key={`${tx.label}-${tx.transactionHash}`}>{text}</code>
                        );
                      })}
                    </div>
                    <p className="muted small lease-meta">
                      Locked {endpoints.deploymentEscrowCoinDenom}:{" "}
                      <strong>
                        {formatMicroAmount(deployment.lockedEscrowAmount) ?? "0"} {endpoints.deploymentEscrowCoinDenom}
                      </strong>
                      {" · "}
                      Paid out:{" "}
                      <strong>
                        {formatMicroAmount(deployment.transferredAmount) ?? "0"} {endpoints.deploymentEscrowCoinDenom}
                      </strong>
                    </p>
                    {deployment.leases.length > 0 ? (
                      <div className="lease-lines">
                        {deployment.leases.map((lease) => (
                          <div key={`${lease.dseq}-${lease.provider}-${lease.state}`} className="lease-line">
                            <div>
                              <strong>{lease.state}</strong> with <code>{shortenAddress(lease.provider)}</code>
                            </div>
                            <div className="muted small">
                              Rate {lease.priceAmount} {endpoints.deploymentEscrowMinimalDenom} · payment {lease.paymentState}
                            </div>
                            {lease.reason && lease.reason !== "lease_closed_invalid" ? (
                              <div className="muted small">Reason: {lease.reason}</div>
                            ) : null}
                          </div>
                        ))}
                        {hasActiveLease ? (
                          <div className="lease-access">
                            <div className="lease-actions">
                              <button
                                type="button"
                                className="secondary tiny"
                                onClick={() => void onLoadLeaseAccess(deployment.dseq)}
                                disabled={loadingLeaseAccessDseq !== null}
                              >
                                {isLoadingAccess
                                  ? "Loading..."
                                  : accessDetails
                                    ? "Refresh access details"
                                    : "Load access details"}
                              </button>
                              <span className="muted small">Signs a provider JWT to read live service status.</span>
                            </div>
                            {canOfferCloseDeployment ? (
                              <div className="lease-actions">
                                <button
                                  type="button"
                                  className="secondary danger tiny"
                                  onClick={() => void onCloseDeployment(deployment.dseq)}
                                  disabled={closingDeploymentDseq !== null}
                                >
                                  {isClosing ? "Closing..." : "Close deployment"}
                                </button>
                                <span className="muted small">
                                  Stops this active lease and returns remaining deployment escrow after settlement.
                                  Requires AKT gas.
                                </span>
                              </div>
                            ) : null}
                            {accessError ? <p className="error small">{accessError}</p> : null}
                            {accessDetails ? (
                              accessDetails.services.length > 0 ? (
                                <div className="lease-service-grid">
                                  {accessDetails.services.map((service) => {
                                    const expectedPorts = sdlExposedPorts.filter(
                                      (port) => port.serviceName === service.name
                                    );
                                    const expectedSshPorts = expectedPorts.filter(isSdlSshPort);
                                    const sshCommands = collectLeaseSshCommands(service, expectedPorts);
                                    const hasExpectedNonHttpPort = expectedPorts.some(
                                      (port) => port.publicPort !== 80 && port.containerPort !== 8080
                                    );
                                    const publicOriginHost = originHostname(configuredPublicOrigin);
                                    const dnsTarget = service.uris[0] ?? "";
                                    const providerOrigin = normalizeUcanStorePublicOrigin(dnsTarget);
                                    const domainVerification = domainVerificationByDseq[deployment.dseq];
                                    const originConfigure = originConfigureByDseq[deployment.dseq];
                                    const customDomainVerified =
                                      domainVerification?.origin === configuredPublicOrigin &&
                                      domainVerification.status === "ok";
                                    const isConfiguringOrigin = originConfigure?.status === "configuring";
                                    const showRuntimeOriginSetup = !!providerOrigin && !!configureToken;
                                    const showDomainSetup = !!configuredPublicOrigin && !!publicOriginHost && !!dnsTarget;

                                    return (
                                      <div key={`${deployment.dseq}-${service.name}`} className="lease-service-card">
                                        <div className="lease-service-title">
                                          <strong>{service.name}</strong>
                                          <span className="muted small">
                                            Ready {service.readyReplicas || service.availableReplicas || service.available}/
                                            {service.replicas || service.total || 0}
                                          </span>
                                        </div>
                                        {service.uris.length > 0 ? (
                                          <div className="lease-service-block">
                                            <div className="muted small">URLs</div>
                                            {service.uris.map((uri) =>
                                              /^https?:\/\//i.test(uri) ? (
                                                <a
                                                  key={uri}
                                                  href={uri}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="lease-link"
                                                >
                                                  {uri}
                                                </a>
                                              ) : (
                                                <code key={uri}>{uri}</code>
                                              )
                                            )}
                                          </div>
                                        ) : null}
                                        {showRuntimeOriginSetup || showDomainSetup ? (
                                          <div className="lease-service-block domain-setup-block">
                                            <div className="muted small">Runtime origin setup</div>
                                            {providerOrigin ? (
                                              <div className="lease-actions domain-setup-actions">
                                                <button
                                                  type="button"
                                                  className="secondary tiny"
                                                  onClick={() =>
                                                    void configureServiceOrigin(
                                                      deployment.dseq,
                                                      providerOrigin,
                                                      providerOrigin
                                                    )
                                                  }
                                                  disabled={isConfiguringOrigin}
                                                >
                                                  {isConfiguringOrigin && originConfigure?.origin === providerOrigin
                                                    ? "Configuring..."
                                                    : "Use provider origin"}
                                                </button>
                                                <span className="muted mini">
                                                  Sets the manifest to {providerOrigin} while DNS or TLS is still pending.
                                                </span>
                                              </div>
                                            ) : null}
                                            {showDomainSetup ? (
                                              <code>
                                                {publicOriginHost} CNAME {dnsTarget}
                                              </code>
                                            ) : null}
                                            <div className="lease-actions domain-setup-actions">
                                              {showDomainSetup ? (
                                                <button
                                                  type="button"
                                                  className="secondary tiny"
                                                  onClick={() =>
                                                    void verifyPublicOrigin(deployment.dseq, configuredPublicOrigin)
                                                  }
                                                  disabled={domainVerification?.status === "checking"}
                                                >
                                                  {domainVerification?.status === "checking" ? "Checking..." : "Verify DNS"}
                                                </button>
                                              ) : null}
                                              {showDomainSetup ? (
                                                <button
                                                  type="button"
                                                  className="secondary tiny"
                                                  onClick={() =>
                                                    void configureServiceOrigin(
                                                      deployment.dseq,
                                                      configuredPublicOrigin,
                                                      configuredPublicOrigin
                                                    )
                                                  }
                                                  disabled={!customDomainVerified || isConfiguringOrigin}
                                                >
                                                  {isConfiguringOrigin && originConfigure?.origin === configuredPublicOrigin
                                                    ? "Configuring..."
                                                    : "Use custom origin"}
                                                </button>
                                              ) : null}
                                              <span
                                                className={`mini ${
                                                  domainVerification?.status === "ok"
                                                    ? "domain-status-ok"
                                                    : domainVerification?.status === "fail"
                                                      ? "domain-status-fail"
                                                      : "muted"
                                                }`}
                                              >
                                                {showDomainSetup && domainVerification?.origin === configuredPublicOrigin
                                                  ? domainVerification.message
                                                  : showDomainSetup
                                                    ? "After DNS points here, verify from this browser before using the custom origin."
                                                    : "Add a custom domain in the SDL template before deployment to enable the second step."}
                                              </span>
                                            </div>
                                            {originConfigure ? (
                                              <span
                                                className={`mini ${
                                                  originConfigure.status === "ok"
                                                    ? "domain-status-ok"
                                                    : originConfigure.status === "fail"
                                                      ? "domain-status-fail"
                                                      : "muted"
                                                }`}
                                              >
                                                {originConfigure.message}
                                              </span>
                                            ) : null}
                                          </div>
                                        ) : null}
                                        {service.ports.length > 0 ? (
                                          <div className="lease-service-block">
                                            <div className="muted small">Forwarded ports</div>
                                            {service.ports.map((port) => (
                                              <code key={`${service.name}-${port.host}-${port.externalPort}-${port.port}`}>
                                                {port.host || "host"}:{port.externalPort} {"->"} {port.port}/
                                                {port.proto || "tcp"}
                                                {port.name ? ` (${port.name})` : ""}
                                              </code>
                                            ))}
                                          </div>
                                        ) : null}
                                        {sshCommands.length > 0 ? (
                                          <div className="lease-service-block">
                                            <div className="muted small">SSH</div>
                                            {sshCommands.map((ssh) => (
                                              <code key={`${service.name}-ssh-${ssh.host}-${ssh.port}`}>
                                                {ssh.command}
                                              </code>
                                            ))}
                                          </div>
                                        ) : null}
                                        {expectedPorts.length > 0 ? (
                                          <div className="lease-service-block">
                                            <div className="muted small">Expected ports from SDL</div>
                                            {expectedPorts.map((port) => (
                                              <code
                                                key={`${service.name}-expected-${port.publicPort}-${port.containerPort}-${port.proto}`}
                                              >
                                                {formatSdlExposedPortLabel(port)}: provider/as {port.publicPort} {"->"}{" "}
                                                container {port.containerPort}/{port.proto}
                                                {port.global ? " · global" : ""}
                                              </code>
                                            ))}
                                            {expectedSshPorts.length > 0 && sshCommands.length === 0 ? (
                                              <span className="muted small">
                                                SSH was requested in the SDL, but this provider status has not reported
                                                a forwarded SSH endpoint.
                                              </span>
                                            ) : service.ports.length === 0 && hasExpectedNonHttpPort ? (
                                              <span className="muted small">
                                                Provider status has not reported forwarded non-HTTP ports yet.
                                              </span>
                                            ) : null}
                                          </div>
                                        ) : null}
                                        {service.ips.length > 0 ? (
                                          <div className="lease-service-block">
                                            <div className="muted small">IP addresses</div>
                                            {service.ips.map((ip) => (
                                              <code key={`${service.name}-${ip.ip}-${ip.externalPort}-${ip.port}`}>
                                                {ip.ip}:{ip.externalPort || ip.port}
                                                {ip.port && ip.externalPort && ip.externalPort !== ip.port
                                                  ? ` -> ${ip.port}`
                                                  : ""}
                                                /{ip.protocol || "tcp"}
                                              </code>
                                            ))}
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="muted small lease-empty">
                                  Provider returned no URL, port, or IP details yet for this active lease.
                                </p>
                              )
                            ) : null}
                          </div>
                        ) : canOfferCloseDeployment ? (
                          <div className="lease-empty">
                            <p className="muted small">
                              {lockedEscrowPositive ? (
                                <>
                                  Every listed lease is closed, but deployment escrow is still <strong>open</strong> with
                                  a non-zero balance shown above. Closing the deployment should return the remaining unused
                                  escrow to your wallet (AKT gas is not refundable).
                                </>
                              ) : (
                                <>
                                  Every listed lease is closed while this deployment order is still{" "}
                                  <strong>active</strong> on chain. Close the deployment when you are finished so any
                                  remaining deployment escrow is settled back to you.
                                </>
                              )}
                            </p>
                            <div className="lease-actions">
                              <button
                                type="button"
                                className="secondary tiny"
                                onClick={() => void onCloseDeployment(deployment.dseq)}
                                disabled={closingDeploymentDseq !== null}
                              >
                                {isClosing ? "Closing..." : "Close deployment"}
                              </button>
                              <span className="muted small">Requires a small AKT gas fee.</span>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="lease-empty">
                        {archiveNoLeaseNothingToReclaim ? (
                          <p className="muted small">
                            No lease appears for this deployment. The deployment order and its deployment escrow account
                            are already <strong>closed</strong> on chain with no locked escrow shown here, so there is
                            nothing left to reclaim from this card.
                          </p>
                        ) : (
                          <>
                            <p className="muted small">
                              {lockedEscrowPositive ? (
                                <>
                                  No lease yet. Deployment escrow still holds funds; closing the deployment should return
                                  unused escrow to your wallet (AKT gas is not refundable).
                                </>
                              ) : canOfferCloseDeployment ? (
                                <>
                                  No lease yet. This deployment order is still <strong>active</strong> on chain. Close it
                                  when you are finished (for example, after bidding ends) so the deployment is removed and
                                  any remaining deployment escrow is returned.
                                </>
                              ) : (
                                <>
                                  No lease appears for this dseq while the deployment is already <strong>closed</strong>.
                                  If balances look wrong, refresh; repeating close is not expected to change settled escrow.
                                </>
                              )}
                            </p>
                            {canOfferCloseDeployment ? (
                              <div className="lease-actions">
                                <button
                                  type="button"
                                  className="secondary tiny"
                                  onClick={() => void onCloseDeployment(deployment.dseq)}
                                  disabled={closingDeploymentDseq !== null}
                                >
                                  {isClosing ? "Closing..." : "Close deployment"}
                                </button>
                                <span className="muted small">Requires a small AKT gas fee.</span>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2>{sdlSectionNumber}. Stack Definition (SDL)</h2>
        <div className="sdl-template-row">
          <label className="sdl-template-label" htmlFor="sdl-template">
            Template
          </label>
          <select
            id="sdl-template"
            className="sdl-template-select"
            value={selectedSdlTemplate}
            onChange={(e) => {
              const value = e.target.value;
              if (isSdlTemplateId(value)) selectSdlTemplate(value);
            }}
          >
            {selectedSdlTemplate === "custom" ? <option value="custom">Custom SDL</option> : null}
            {SDL_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <span className="muted small sdl-template-description">
            {activeSdlTemplate?.description ?? "Edited SDL. Pick a template to replace the editor content."}
          </span>
        </div>
        {activeSdlTemplate?.parameters?.length ? (
          <div className="sdl-template-options">
            {activeSdlTemplate.parameters.map((parameter: SdlTemplateParameter) => {
              const value = sdlTemplateValues[parameter.id] ?? parameter.defaultValue ?? "";
              const help = parameter.valueHelp?.(value) || parameter.help;
              const inputId = `sdl-template-parameter-${activeSdlTemplate.id}-${parameter.id}`;
              const checkboxChecked = value ? value === "true" : parameter.defaultValue === "true";
              return (
                <Fragment key={parameter.id}>
                  <label className="sdl-template-label" htmlFor={inputId}>
                    {parameter.label}
                  </label>
                  {parameter.inputType === "checkbox" ? (
                    <input
                      id={inputId}
                      className="sdl-template-checkbox"
                      type="checkbox"
                      checked={checkboxChecked}
                      onChange={(e) => updateSdlTemplateParameter(parameter.id, e.target.checked ? "true" : "false")}
                    />
                  ) : parameter.inputType === "textarea" ? (
                    <textarea
                      id={inputId}
                      className="endpoint-input sdl-domain-input"
                      value={value}
                      onChange={(e) => updateSdlTemplateParameter(parameter.id, e.target.value)}
                      placeholder={parameter.placeholder}
                      rows={3}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      id={inputId}
                      className="endpoint-input sdl-domain-input"
                      type={parameter.inputType}
                      value={value}
                      onChange={(e) => updateSdlTemplateParameter(parameter.id, e.target.value)}
                      placeholder={parameter.placeholder}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                  <p className="muted mini sdl-domain-hint">{help}</p>
                </Fragment>
              );
            })}
          </div>
        ) : null}
        <p className="muted small sdl-escrow-hint">
          Default SDL pricing and the create-deployment deposit use{" "}
          <strong>{endpoints.deploymentEscrowCoinDenom}</strong> (<code>{endpoints.deploymentEscrowMinimalDenom}</code>
          ). Gas remains <strong>AKT</strong> (<code>uakt</code>).
        </p>
        <textarea value={yamlText} onChange={(e) => editYamlText(e.target.value)} rows={18} className="sdl" />
        {preview.ok ? (
          <div className="preview ok">
            <h3>What will be deployed</h3>
            <ul>
              {preview.value.groupSpecs.map((g, i) => (
                <li key={i}>
                  Group {i + 1}: {g.name} — resources from SDL (CPU/RAM/storage as specified).
                </li>
              ))}
            </ul>
            <p className="small muted">
              Manifest groups: {preview.value.groups.length}. This preview is derived from{" "}
              <code>generateManifest</code>.
            </p>
          </div>
        ) : (
          <div className="preview err">
            <h3>SDL issues</h3>
            <pre>{JSON.stringify(preview.errors, null, 2)}</pre>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{deploySectionNumber}. Deploy</h2>
        <p className="what-next">
          <strong>What happens next:</strong> (1) Ensure an on-chain client certificate. (2) Create deployment and escrow
          deposit in <code>{endpoints.deploymentEscrowMinimalDenom}</code> ({endpoints.deploymentEscrowCoinDenom}). (3)
          Providers submit bids
          — we pick the cheapest. (4) Create lease. (5) PUT manifest to the provider with a JWT. (6) Poll lease status.
        </p>
        <button type="button" className="deploy" disabled={!address || !preview.ok} onClick={() => void onDeploy()}>
          Deploy
        </button>
        {error && address ? <p className="error">{error}</p> : null}
        <p className="muted small">Current step: {step}</p>
        {dseq ? <p className="dseq">dseq: {dseq}</p> : null}
      </section>

      <section className="card">
        <h2>Activity log</h2>
        <ol className="log">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>

      {leaseInfo ? (
        <section className="card">
          <h2>Lease / status</h2>
          <pre className="json">{JSON.stringify(leaseInfo, null, 2)}</pre>
        </section>
      ) : null}

      <footer className="footer muted small">
        Fund <strong>AKT</strong> (<code>uakt</code>) for gas and{" "}
        <strong>{endpoints.deploymentEscrowCoinDenom}</strong> (<code>{endpoints.deploymentEscrowMinimalDenom}</code>)
        for deployment escrow on Akash. No card required.
      </footer>
    </div>
  );
}
