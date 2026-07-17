# Akash Deploy PWA

Akash Deploy PWA is a wallet-only browser application for deploying workloads to [Akash Network](https://akash.network/). It connects to Keplr or Leap, prepares and validates SDL, signs chain transactions, selects a provider bid, creates a lease, uploads the manifest, and displays live access details without requiring a local Akash CLI or mnemonic import.

The default template deploys [UCAN Store](https://github.com/NomadKids/ucan-store): a self-hosted UCAN-authorized upload service, PWA, and Kubo/IPFS gateway packaged as one Akash workload. A smaller nginx template remains available for deployment smoke tests.

## What it does

- Connects Keplr or Leap without receiving wallet private keys.
- Supports Akash mainnet plus advanced sandbox/testnet configuration.
- Shows wallet balances, deployment escrow, current deployments, and leases.
- Parses SDL and generates the provider manifest in the browser.
- Creates an Akash client certificate when required.
- Creates deployments, polls bids, selects a bid, creates a lease, and uploads the manifest.
- Signs provider JWTs for manifest upload and lease-status access.
- Supports a narrowly scoped optional Cloudflare Worker for provider CORS compatibility.
- Shows provider URLs, forwarded ports, SSH commands, DNS guidance, and deployment-close controls.
- Configures the UCAN Store runtime origin after provider discovery.
- Generates distinct runtime-configuration and delegation-administration tokens per browser session.
- Provides an editable curl helper for issuing a UCAN delegation to a browser DID.

## Quick start

```bash
npm ci
npm run dev
```

Open `http://localhost:5173` or another origin where the wallet extension is available.

1. Select mainnet or open Advanced network.
2. Connect Keplr or Leap.
3. Ensure the wallet has AKT for gas and deployment escrow.
4. Select the UCAN Store template and review its parameters.
5. Deploy and approve the wallet prompts.
6. Load access details when the lease becomes active.
7. Configure the provider origin first; switch to a custom origin only after DNS/TLS verification.

## UCAN Store template

The template pins an immutable UCAN Store container digest and deploys:

```text
Caddy public listener
  /                         UCAN Store PWA from local IPFS
  /api/*                    UCAN upload API
  /api/admin/delegations    protected delegation issuance
  /ipfs/*                   local Kubo gateway
  /health                   workload health
  /.well-known/*            DID and service discovery

Kubo/IPFS                   content storage and gateway
UCAN upload service         capability verification and upload metadata
Persistent service signer   deployment identity
```

### Template fields

- **Custom domain**: optional final public origin such as `https://ucan.example.com`.
- **Configure token**: controls only `POST /configure`, which changes the runtime public origin.
- **Delegation admin token**: controls the protected API that issues child UCAN delegations to browser DIDs.
- **Self-managed TLS**: requests public 80/443 exposure and lets workload Caddy obtain the custom-domain certificate when the provider supports that routing.

Both tokens are generated from browser cryptographic randomness and kept in session-scoped template state. They serve different security roles and must not be reused or published.

## Issue a browser delegation

After deploying UCAN Store:

1. Open the deployed UCAN Store UI.
2. Create and copy its browser DID.
3. Return to the UCAN Store template fields in this PWA.
4. Replace `REPLACE-WITH-BROWSER-DID` in the editable curl textarea.
5. Copy and run the command.
6. Import `delegation.proof` from the response into UCAN Store.

The helper produces this request shape:

```bash
curl -X POST 'https://YOUR-UCAN-STORE-HOST/api/admin/delegations' \
  -H 'Authorization: Bearer YOUR-DELEGATION-ADMIN-TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{
    "targetDid": "did:key:z6Mk...",
    "capabilities": ["space/blob/add", "upload/add", "upload/list"],
    "expirationSeconds": 86400
  }'
```

The curl command and token remain local to the browser UI. The PWA does not submit the delegation request itself.

## Deployment flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant PWA as Akash Deploy PWA
    participant Wallet as Keplr / Leap
    participant Chain as Akash chain
    participant Provider as Akash provider API
    participant Proxy as Optional CORS proxy

    User->>PWA: Connect wallet and review SDL
    PWA->>Wallet: Request client certificate if needed
    PWA->>Wallet: Sign deployment transaction
    Wallet->>Chain: Create deployment
    PWA->>Chain: Poll provider bids
    PWA->>Wallet: Sign lease transaction
    Wallet->>Chain: Create lease
    PWA->>Wallet: Sign provider JWT
    PWA->>Provider: Upload manifest
    alt Provider blocks browser CORS
        PWA->>Proxy: Forward allowed provider request
        Proxy->>Provider: Upload manifest / read status
    end
    PWA->>Provider: Read lease access details
    PWA-->>User: URLs, ports, SSH, DNS, and runtime setup
```

## Provider CORS proxy

Some provider gateways do not return browser-compatible CORS headers. Chain transactions may succeed while manifest upload or lease-status requests fail in the browser.

Deploy the included Cloudflare Worker under your control:

```bash
cd workers
npx wrangler deploy
```

Then configure:

```bash
VITE_PROVIDER_PROXY_URL=https://your-worker.example.workers.dev/
```

The target provider URL stays dynamic. The Worker restricts forwarding to the Akash provider paths required for manifest upload and status reads. Because the wallet-signed provider JWT passes through it, use only a Worker deployment you control.

## Configuration

Copy `.env.example` to `.env` for local overrides:

```bash
VITE_PROVIDER_PROXY_URL=https://your-worker.example.workers.dev/
VITE_MAINNET_REST=https://akash-rest.publicnode.com
VITE_MAINNET_RPC=https://akash-rpc.publicnode.com:443
```

Optional UCAN Store debug SSH can be compiled into the generated SDL with the documented public-key variables in `.env.example`. Never put an SSH private key in environment variables or SDL.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
npm run preview
```

The test suite covers SDL pricing validation, template rendering, provider HTTP/proxy safety, forwarded-port parsing, SSH commands, lease filtering, amount formatting, and Tendermint block timestamps.

## Security and operational notes

- Mainnet consumes real AKT; transaction gas is not refundable.
- Closing a deployment returns remaining escrow after settlement, not gas already spent.
- The PWA never requests or stores wallet mnemonics/private keys.
- Template secrets are visible in the editable SDL and must be treated as operator credentials.
- A delegation admin token can mint upload authority; rotate it by redeploying if exposed.
- Provider behavior, ingress routing, and custom-domain TLS vary across the network.
- The JavaScript bundle is large because it includes Akash SDK, certificate, wallet, and protobuf tooling.

## Release policy

Releases use semantic version tags. A minor release is appropriate when a new deploy template capability or operator workflow is added; patch releases cover compatible fixes.

See [CHANGES.md](./CHANGES.md) for release notes.

## Related projects and acknowledgements

- [UCAN Store](https://github.com/NomadKids/ucan-store)
- [Akash Network](https://akash.network/)
- [UCAN](https://ucan.xyz/)

UCAN Store is built from the UCAN and upload-service open-source lineage developed by the Storacha/web3.storage community. See the UCAN Store README for the full acknowledgement and compatibility context.

## License

MIT. See [LICENSE](./LICENSE).

The license applies to the source code and associated documentation unless otherwise stated. Third-party dependencies and incorporated components remain subject to their respective licenses.
