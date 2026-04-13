# Akash Deploy (PWA)

Minimal React PWA for **wallet-only** Akash tenant deployments: preview an SDL, connect **Keplr** or **Leap**, then walk through certificate creation, deployment, bids, lease, and manifest upload using `@akashnetwork/chain-sdk/web`.

## Quick start

```bash
npm install
npm run dev
```

The repo includes [`.npmrc`](.npmrc) with `legacy-peer-deps=true` because **`vite-plugin-pwa@1.x` does not yet declare `vite@^8` in `peerDependencies`**, while this app uses **Vite 8** (required by `@vitejs/plugin-react@6`). The PWA plugin runs fine on Vite 8; npm’s resolver needs this until [vite-plugin-pwa adds Vite 8 to peers](https://github.com/vite-pwa/vite-plugin-pwa/issues/923). By contrast, projects on **Vite 5** (such as `bolt-orbitdb-blog` with `vite@^5.4` + `vite-plugin-pwa@^1.0.3`) install without that workaround.

Open the app over **HTTPS** or `localhost` so the wallet extension can inject (`window.keplr` / `window.leap`).

## Sandbox end-to-end test

1. Install [Keplr](https://www.keplr.app/) (or Leap). Switch network to **Akash Sandbox** after the app suggests the chain (Keplr: approve the chain suggestion).
2. Fund the wallet with sandbox **uakt** from the official sandbox faucet (see [Akash docs — SDK quick start](https://akash.network/docs/api-documentation/sdk/quick-start/) for the current faucet URL).
3. In the app, leave **Sandbox** selected, connect the wallet, optionally edit the SDL, then **Deploy**.
4. Approve transactions in the wallet when prompted (certificate, deployment, lease). Manifest upload uses a **JWT** signed via the wallet’s amino signer.

## Mainnet

Choose **Mainnet** in the UI (this clears the connected wallet so you reconnect against mainnet RPC/REST). You need real **AKT** for gas and deployment escrow. Override RPC/REST via env vars (see `.env.example`).

## BME testnet (`testnet-oracle`)

Select **Testnet (BME / testnet-oracle)** for the public BME-capable network from [`akash-network/net` `testnet-oracle`](https://github.com/akash-network/net/tree/main/testnet-oracle). Gas is test **`uakt`**.

The repo’s [`faucet-url.txt`](https://github.com/akash-network/net/blob/main/testnet-oracle/faucet-url.txt) still points at **`https://oraclefaucet.dev.akash.pub/`**, which is often unreachable. This app defaults the primary faucet link to **`https://faucet.dev.akash.pub/`** and keeps the oracle host as an **Alternate** link. Override with `VITE_TESTNET_FAUCET_URL`, `VITE_TESTNET_FAUCET_ALT_URL`, or a comma-separated `VITE_TESTNET_FAUCET_URLS` (see `.env.example`).

## Configuration

Copy `.env.example` to `.env` and adjust endpoints if public nodes change or you use your own gRPC-gateway / RPC with CORS enabled for browsers.

## Caveats

- **CORS**: The browser must reach REST and RPC endpoints that allow browser origins. If a node blocks CORS, use another public endpoint or a small same-origin proxy you control.
- **Provider HTTPS**: Manifest `PUT` targets the provider `hostUri` from chain queries; TLS to provider APIs may fail if the certificate cannot be validated in the browser.
- **Bundle size**: The Akash SDK + `jsrsasign` (certificate generation) produces a large JS bundle; the service worker precache limit is raised in `vite.config.ts`.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — Production build (PWA service worker generated)
- `npm run preview` — Serve `dist/`
