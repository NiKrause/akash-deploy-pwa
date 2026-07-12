# Changes

## 0.2.0 - 2026-07-12

- Make UCAN Store the default first-class deployment template.
- Pin the delegation-capable UCAN Store image by immutable GHCR digest.
- Add separate session-generated tokens for runtime-origin configuration and UCAN delegation administration.
- Add an accessible information tooltip and editable/copyable curl helper for issuing a delegation to a browser DID.
- Add UCAN Store custom-domain guidance, provider-origin configuration, DNS verification, and optional self-managed TLS.
- Show current leases, provider access details, forwarded ports, and optional SSH commands.
- Expand documentation for the wallet, provider, UCAN delegation, token, CORS proxy, and operational security flows.

## 0.1.1 - 2026-07-11

- Parse Akash provider `forwarded_ports` / `forwardedPorts` from lease status responses.
- Show SSH commands from the provider-reported forwarded NodePort instead of assuming the SDL `as` port is directly reachable.
- Avoid treating unrelated external `2222` services as SSH unless the provider reports target port `22`.

## 0.1.0 - 2026-07-09

- Initial tagged PWA release for browser-based Akash deployment flows.
