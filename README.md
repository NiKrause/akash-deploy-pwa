# Akash Deploy (PWA)

Minimal React PWA for **wallet-only** Akash tenant deployments: preview an SDL, connect **Keplr** or **Leap**, then walk through certificate creation, deployment, bids, lease, and manifest upload using `@akashnetwork/chain-sdk/web`.

## Quick start

```bash
npm install
npm run dev
```

Open the app over **HTTPS** or `localhost` so the wallet extension can inject (`window.keplr` / `window.leap`).

## Sandbox end-to-end test

1. Install [Keplr](https://www.keplr.app/) (or Leap). Switch network to **Akash Sandbox** after the app suggests the chain (Keplr: approve the chain suggestion).
2. Fund the wallet with sandbox **uakt** from the official sandbox faucet (see [Akash docs — SDK quick start](https://akash.network/docs/api-documentation/sdk/quick-start/) for the current faucet URL).
3. In the app, open **Advanced network**, choose **Sandbox**, connect the wallet, optionally edit the SDL, then **Deploy**.
4. Approve transactions in the wallet when prompted (certificate, deployment, lease). Manifest upload uses a **JWT** signed via the wallet’s amino signer.

## Mainnet

Mainnet is the default network. You need real **AKT** for gas and deployment escrow. Override RPC/REST via env vars or the **Advanced network** panel (see `.env.example`).

## BME testnet (`testnet-oracle`)

Select **Testnet (BME / testnet-oracle)** for the public BME-capable network from [`akash-network/net` `testnet-oracle`](https://github.com/akash-network/net/tree/main/testnet-oracle). Gas is test **`uakt`**.

The repo’s [`faucet-url.txt`](https://github.com/akash-network/net/blob/main/testnet-oracle/faucet-url.txt) still points at **`https://oraclefaucet.dev.akash.pub/`**, which is often unreachable. This app defaults the primary faucet link to **`https://faucet.dev.akash.pub/`** and keeps the oracle host as an **Alternate** link. Override with `VITE_TESTNET_FAUCET_URL`, `VITE_TESTNET_FAUCET_ALT_URL`, or a comma-separated `VITE_TESTNET_FAUCET_URLS` (see `.env.example`).

## Configuration

Copy `.env.example` to `.env` and adjust endpoints if public nodes change or you use your own gRPC-gateway / RPC with CORS enabled for browsers.

### Provider CORS proxy

Some Akash providers do not return browser CORS headers on their provider API, so the deployment and lease transactions can succeed but manifest upload or live lease status can still fail in the browser.

Deploy [`workers/provider-proxy.js`](workers/provider-proxy.js) to a Cloudflare Worker or compatible runtime you control:

```bash
cd workers
wrangler deploy
```

Then set:

```bash
VITE_PROVIDER_PROXY_URL=https://your-worker.example.workers.dev/
```

The target provider URL remains variable: the app sends it as a `url` query parameter and the Worker only forwards Akash provider API calls for manifest upload and lease status. The wallet-signed provider JWT passes through the Worker, so use your own trusted deployment.

## Deployment flow

The PWA is fully browser-driven. Chain transactions are signed in the wallet, while the Cloudflare Worker is only a temporary CORS bridge for provider API calls until providers reliably expose browser-compatible CORS headers.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant PWA as Akash Deploy PWA
    participant Wallet as Keplr / Leap
    participant REST as Akash REST / RPC
    participant Chain as Akash chain
    participant Provider as Akash provider API
    participant Worker as Cloudflare Worker provider proxy

    User->>PWA: Select network and edit SDL
    PWA->>REST: Probe REST node_info and RPC status
    REST-->>PWA: Connectivity result
    User->>PWA: Connect wallet
    PWA->>Wallet: Suggest/select Akash chain
    Wallet-->>PWA: Offline signer and account address
    PWA->>REST: Query spendable gas, deployment escrow, deployments, leases
    REST-->>PWA: Balances and lease overview
    User->>PWA: Deploy
    PWA->>PWA: Parse SDL and generate manifest/groups
    PWA->>REST: Check existing client certificate
    alt No valid certificate
        PWA->>Wallet: Sign create-certificate tx
        Wallet->>Chain: Broadcast certificate tx
        Chain-->>PWA: Certificate tx result
    end
    PWA->>REST: Get latest block height for dseq
    REST-->>PWA: Latest height
    PWA->>REST: Query minimum deployment deposit
    REST-->>PWA: Deposit denom/amount
    PWA->>PWA: Validate SDL pricing denom matches deployment escrow denom
    PWA->>Wallet: Sign create-deployment tx
    Wallet->>Chain: Broadcast deployment tx
    Chain-->>PWA: Deployment created with escrow
    loop Poll bids
        PWA->>REST: List open bids for dseq
        REST-->>PWA: Provider bids
    end
    PWA->>PWA: Select cheapest bid
    PWA->>Wallet: Sign create-lease tx
    Wallet->>Chain: Broadcast lease tx
    Chain-->>PWA: Lease created
    PWA->>Wallet: Sign provider JWT
    Wallet-->>PWA: Provider JWT
    PWA->>Provider: PUT /deployment/{dseq}/manifest
    alt Provider allows browser CORS
        Provider-->>PWA: Manifest accepted
    else Browser blocks provider CORS
        PWA->>Worker: PUT /?url=https://provider.../deployment/{dseq}/manifest
        Worker->>Worker: Validate target host and allowed Akash provider path
        Worker->>Provider: Forward manifest with provider JWT
        Provider-->>Worker: Manifest accepted
        Worker-->>PWA: CORS-enabled response
    end
    loop Load/refresh access details
        PWA->>Wallet: Sign provider JWT
        Wallet-->>PWA: Provider JWT
        PWA->>Provider: GET /lease/{dseq}/{gseq}/{oseq}/status
        alt Provider status blocked by CORS
            PWA->>Worker: GET /?url=https://provider.../lease/{dseq}/{gseq}/{oseq}/status
            Worker->>Provider: Forward status request
            Provider-->>Worker: Service status
            Worker-->>PWA: CORS-enabled service status
        else Provider status reachable
            Provider-->>PWA: Service status
        end
        PWA->>PWA: Render ingress URLs, ports, replicas
    end
```

## Caveats

- **CORS**: The browser must reach REST/RPC endpoints and provider APIs that allow browser origins. If provider manifest/status calls are blocked, use the optional provider proxy above.
- **Provider HTTPS**: Manifest `PUT` targets the provider `hostUri` from chain queries; TLS to provider APIs may fail if the certificate cannot be validated in the browser.
- **Bundle size**: The Akash SDK + `jsrsasign` (certificate generation) produces a large JS bundle; the service worker precache limit is raised in `vite.config.ts`.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — Production build (PWA service worker generated)
- `npm run preview` — Serve `dist/`
