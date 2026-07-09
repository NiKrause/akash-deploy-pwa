/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SANDBOX_CHAIN_ID: string;
  readonly VITE_SANDBOX_RPC: string;
  readonly VITE_SANDBOX_REST: string;
  readonly VITE_MAINNET_CHAIN_ID: string;
  readonly VITE_MAINNET_RPC: string;
  readonly VITE_MAINNET_REST: string;
  /** BME testnet gas faucet (default in app if unset). */
  readonly VITE_TESTNET_FAUCET_URL?: string;
  /** Second faucet link (default oracle host from `net` if unset). */
  readonly VITE_TESTNET_FAUCET_ALT_URL?: string;
  /** Comma-separated faucet URLs; when set, overrides primary + alternate. */
  readonly VITE_TESTNET_FAUCET_URLS?: string;
  /** Optional public SSH key for debug access to the UCAN Store SDL template. */
  readonly VITE_UCAN_STORE_SSH_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
