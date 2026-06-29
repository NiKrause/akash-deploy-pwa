import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accountExplorerUrl,
  getEndpoints,
  getTestnetFaucetUrls,
  sanitizePersistedRpcRest,
  type NetworkMode,
} from "./config/networks";
import { alignSdlPricingDenomsToEscrow, getDefaultSdl } from "./akash/defaultSdl";
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
} from "./akash/deployService";
import { connectWallet, type WalletKind } from "./wallet/keplr";
import { probeRestGateway, probeTendermintRpc } from "./lib/endpointConnectivity";
import {
  fetchAktUsdPrice,
  formatUaktStringToAkt,
  formatUsd,
  uaktStringToAktNumber,
} from "./lib/aktMarket";
import "./App.css";

/** Akash sandbox-2 public faucet (AKT / uakt). */
const SANDBOX_AKASH_FAUCET_URL = "https://faucet.sandbox-2.aksh.pw/";
/** BME testnet (`testnet-oracle`) config and notes in `akash-network/net`. */
const TESTNET_BME_DOCS_URL = "https://github.com/akash-network/net/tree/main/testnet-oracle";

const STORAGE_KEY = "akash-deploy-pwa-session";

const EMPTY_WALLET_BALANCES = { uakt: null as string | null, deploymentEscrow: null as string | null };

type WalletBalanceSnapshot = { uakt: string; deploymentEscrow: string };

type Persisted = {
  network: NetworkMode;
  yaml: string;
  dseq?: string;
  rest?: string;
  rpc?: string;
};

type LedState = "idle" | "ok" | "fail";

function formatMicroAmount(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  const s = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const whole = n / 1_000_000n;
  const rem = n % 1_000_000n;
  const frac = rem.toString().padStart(6, "0").replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return frac ? `${wholeText}.${frac}` : wholeText;
}

/** `lockedEscrowAmount` from the indexer is an integer string in the deployment-escrow minimal denom (see `findDecCoinAmount` in deployService). */
function isPositiveMicroAmountString(raw: string): boolean {
  const s = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(s)) return false;
  return BigInt(s) > 0n;
}

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
  const net = (p?.network ?? "sandbox") as NetworkMode;
  const d = getEndpoints(net);
  const rawRest = p?.rest ?? d.rest;
  const rawRpc = p?.rpc ?? d.rpc;
  return { network: net, ...sanitizePersistedRpcRest(net, rawRpc, rawRest) };
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
    const raw = persisted ?? getDefaultSdl(net);
    const esc = getEndpoints(net).deploymentEscrowMinimalDenom;
    return alignSdlPricingDenomsToEscrow(raw, esc);
  });
  const [address, setAddress] = useState<string | null>(null);
  const [walletKind, setWalletKind] = useState<WalletKind | null>(null);
  const [signer, setSigner] = useState<Awaited<ReturnType<typeof connectWallet>>["signer"] | null>(null);
  const [walletBalances, setWalletBalances] = useState(EMPTY_WALLET_BALANCES);
  const [currentLeases, setCurrentLeases] = useState<CurrentLeasesOverview | null>(null);
  const [currentLeasesError, setCurrentLeasesError] = useState<string | null>(null);
  const [closingDeploymentDseq, setClosingDeploymentDseq] = useState<string | null>(null);
  const [leaseActionError, setLeaseActionError] = useState<string | null>(null);
  const [loadingLeaseAccessDseq, setLoadingLeaseAccessDseq] = useState<string | null>(null);
  const [leaseAccessByDseq, setLeaseAccessByDseq] = useState<Record<string, LeaseAccessDetails>>({});
  const [leaseAccessErrorByDseq, setLeaseAccessErrorByDseq] = useState<Record<string, string>>({});
  /** Mainnet AKT spot in USD (CoinGecko), applied to the `uakt` balance line. */
  const [aktUsdPrice, setAktUsdPrice] = useState<number | null>(null);
  const [step, setStep] = useState<DeployStep>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dseq, setDseq] = useState<string | null>(() => loadPersisted()?.dseq ?? null);
  const [leaseInfo, setLeaseInfo] = useState<unknown>(null);

  const preview = useMemo(() => parseAndPreviewSdl(yamlText), [yamlText]);

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
    savePersisted({
      network,
      yaml: yamlText,
      dseq: dseq ?? undefined,
      rest: restInput,
      rpc: rpcInput,
    });
  }, [network, yamlText, dseq, restInput, rpcInput]);

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
      await ensureClientCertificate(sdk, owner, onStep);
      const dep = await createDeploymentTx(sdk, owner, yamlText, endpoints, onStep);
      setDseq(dep.dseq);
      onStep("waiting_bids");
      const bids = await pollBids(sdk, endpoints, owner, dep.dseq);
      bids.sort((a, b) => {
        return compareDecimalStrings(a.bid?.price?.amount, b.bid?.price?.amount);
      });
      const chosen = bids[0];
      const bidId = await createLeaseTx(sdk, chosen, onStep);
      await sendManifest(
        {
          owner,
          dseq: dep.dseq,
          bidId,
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
        await closeDeploymentTx(sdk, owner, dseqToClose);
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
    [address, endpoints, loadWalletBalancesForAddress, pushLog, signer]
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>Akash Deploy</h1>
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
        </div>
        <p className="subtitle">
          Wallet-only tenant deploy: preview your SDL, sign transactions in Keplr or Leap, then wait for bids, accept a
          lease, and upload the manifest to the provider.
        </p>
      </header>

      <section className="card">
        <h2>1. Network</h2>
        <div className="row">
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "sandbox"}
              onChange={() => {
                setNetwork("sandbox");
                const d = getEndpoints("sandbox");
                setRestInput(d.rest);
                setRpcInput(d.rpc);
                setRestLed("idle");
                setRpcLed("idle");
                setProbeMeta({});
                setAddress(null);
                setSigner(null);
                setWalletKind(null);
                setWalletBalances(EMPTY_WALLET_BALANCES);
                setCurrentLeases(null);
                setCurrentLeasesError(null);
                setYamlText(getDefaultSdl("sandbox"));
              }}
            />{" "}
            Sandbox (recommended for testing)
          </label>
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "mainnet"}
              onChange={() => {
                setNetwork("mainnet");
                const d = getEndpoints("mainnet");
                setRestInput(d.rest);
                setRpcInput(d.rpc);
                setRestLed("idle");
                setRpcLed("idle");
                setProbeMeta({});
                setAddress(null);
                setSigner(null);
                setWalletKind(null);
                setWalletBalances(EMPTY_WALLET_BALANCES);
                setCurrentLeases(null);
                setCurrentLeasesError(null);
                setYamlText(getDefaultSdl("mainnet"));
              }}
            />{" "}
            Mainnet
          </label>
          <label>
            <input
              type="radio"
              name="net"
              checked={network === "testnet"}
              onChange={() => {
                setNetwork("testnet");
                const d = getEndpoints("testnet");
                setRestInput(d.rest);
                setRpcInput(d.rpc);
                setRestLed("idle");
                setRpcLed("idle");
                setProbeMeta({});
                setAddress(null);
                setSigner(null);
                setWalletKind(null);
                setWalletBalances(EMPTY_WALLET_BALANCES);
                setCurrentLeases(null);
                setCurrentLeasesError(null);
                setYamlText(getDefaultSdl("testnet"));
              }}
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

      <section className="card">
        <h2>2. Wallet</h2>
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
                    Open deployments: <strong>{currentLeases.totalDeploymentCount}</strong>
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
          <h2>3. Current Leases</h2>
          <p className="muted small">
            Deployments hold escrow in {endpoints.deploymentEscrowMinimalDenom}. Closing unused deployments should return
            that ACT to your spendable balance; AKT gas is not refundable.
          </p>
          {leaseActionError ? <p className="error small">{leaseActionError}</p> : null}
          <div className="leases-grid">
            {currentLeases.deployments.length === 0 ? (
              <p className="muted small">No deployments found for this account on {endpoints.chainId}.</p>
            ) : (
              currentLeases.deployments.map((deployment) => {
                const hasActiveLease = deployment.leases.some((lease) => lease.state === "active");
                const isClosing = closingDeploymentDseq === deployment.dseq;
                const isLoadingAccess = loadingLeaseAccessDseq === deployment.dseq;
                const accessDetails = leaseAccessByDseq[deployment.dseq];
                const accessError = leaseAccessErrorByDseq[deployment.dseq];
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
                            {accessError ? <p className="error small">{accessError}</p> : null}
                            {accessDetails ? (
                              accessDetails.services.length > 0 ? (
                                <div className="lease-service-grid">
                                  {accessDetails.services.map((service) => (
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
                                      {service.ports.length > 0 ? (
                                        <div className="lease-service-block">
                                          <div className="muted small">Forwarded ports</div>
                                          {service.ports.map((port) => (
                                            <code key={`${service.name}-${port.host}-${port.externalPort}-${port.port}`}>
                                              {port.host || "host"}:{port.externalPort} {"->"} {port.port}/{port.proto || "tcp"}
                                              {port.name ? ` (${port.name})` : ""}
                                            </code>
                                          ))}
                                        </div>
                                      ) : null}
                                      {service.ips.length > 0 ? (
                                        <div className="lease-service-block">
                                          <div className="muted small">IP addresses</div>
                                          {service.ips.map((ip) => (
                                            <code key={`${service.name}-${ip.ip}-${ip.externalPort}-${ip.port}`}>
                                              {ip.ip}:{ip.externalPort || ip.port}
                                              {ip.port && ip.externalPort && ip.externalPort !== ip.port ? ` -> ${ip.port}` : ""}
                                              /{ip.protocol || "tcp"}
                                            </code>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
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
        <h2>{address && currentLeases ? "4. Stack Definition (SDL)" : "3. Stack Definition (SDL)"}</h2>
        <p className="muted small sdl-escrow-hint">
          Default SDL pricing and the create-deployment deposit use{" "}
          <strong>{endpoints.deploymentEscrowCoinDenom}</strong> (<code>{endpoints.deploymentEscrowMinimalDenom}</code>
          ). Gas remains <strong>AKT</strong> (<code>uakt</code>).
        </p>
        <textarea value={yamlText} onChange={(e) => setYamlText(e.target.value)} rows={18} className="sdl" />
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
        <h2>{address && currentLeases ? "5. Deploy" : "4. Deploy"}</h2>
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
