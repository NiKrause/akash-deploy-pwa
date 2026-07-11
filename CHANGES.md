# Changes

## 0.1.1 - 2026-07-11

- Parse Akash provider `forwarded_ports` / `forwardedPorts` from lease status responses.
- Show SSH commands from the provider-reported forwarded NodePort instead of assuming the SDL `as` port is directly reachable.
- Avoid treating unrelated external `2222` services as SSH unless the provider reports target port `22`.

## 0.1.0 - 2026-07-09

- Initial tagged PWA release for browser-based Akash deployment flows.
