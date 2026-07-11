import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SDL_TEMPLATE_ID,
  SDL_TEMPLATES,
  UCAN_STORE_AKASH_IMAGE,
  getDefaultSdl,
  getSdlTemplate,
  normalizeUcanStorePublicOrigin,
  ucanStorePublicOriginHost,
} from "../src/akash/defaultSdl.ts";
import { getEndpoints } from "../src/config/networks.ts";

test("UCAN Store is the default SDL template", () => {
  assert.equal(DEFAULT_SDL_TEMPLATE_ID, "ucan-store");
  assert.match(UCAN_STORE_AKASH_IMAGE, /^ghcr\.io\/nomadkids\/ucan-store-akash@sha256:[a-f0-9]{64}$/);
  assert.match(getDefaultSdl("mainnet"), new RegExp(UCAN_STORE_AKASH_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("UCAN Store SSH exposure is opt-in", () => {
  const sdl = getDefaultSdl("mainnet");
  assert.doesNotMatch(sdl, /UCAN_STORE_SSH_AUTHORIZED_KEYS/);
  assert.doesNotMatch(sdl, /port: 22/);
});

test("UCAN Store template reserves enough memory for Kubo and the app", () => {
  const sdl = getDefaultSdl("mainnet");
  assert.match(sdl, /memory:\n\s+size: 2Gi/);
});

test("UCAN Store declares UI parameters for flexible SDL generation", () => {
  const template = SDL_TEMPLATES.find((candidate) => candidate.id === "ucan-store");
  assert.equal(template?.parameters?.[0]?.id, "ucanStorePublicOrigin");
  assert.equal(template?.parameters?.[0]?.inputType, "url");
  assert.equal(template?.parameters?.[0]?.role, "publicOrigin");
  assert.equal(template?.parameters?.[1]?.id, "ucanStoreConfigureToken");
  assert.equal(template?.parameters?.[1]?.inputType, "text");
  assert.equal(template?.parameters?.[1]?.role, "configureToken");
});

test("UCAN Store template can set a custom public origin and accepted host", () => {
  const sdl = getSdlTemplate("mainnet", "ucan-store", {
    ucanStorePublicOrigin: "ucan.example.com/some/path",
  });

  assert.match(sdl, /- 'UCAN_STORE_PUBLIC_ORIGIN=https:\/\/ucan\.example\.com'/);
  assert.match(sdl, /accept:\n\s+- 'ucan\.example\.com'/);
  assert.doesNotMatch(sdl, /some\/path/);
});

test("UCAN Store template keeps custom origin runtime-configurable when a configure token is present", () => {
  const sdl = getSdlTemplate("mainnet", "ucan-store", {
    ucanStorePublicOrigin: "ucan.example.com/some/path",
    ucanStoreConfigureToken: "configure-secret",
  });

  assert.match(sdl, /- UCAN_STORE_PUBLIC_ORIGIN=/);
  assert.doesNotMatch(sdl, /UCAN_STORE_PUBLIC_ORIGIN=https:\/\/ucan\.example\.com/);
  assert.match(sdl, /- 'UCAN_STORE_CONFIGURE_TOKEN=configure-secret'/);
  assert.match(sdl, /accept:\n\s+- 'ucan\.example\.com'/);
});

test("UCAN Store public origin helpers normalize domains to origins", () => {
  assert.equal(normalizeUcanStorePublicOrigin("ucan.example.com/path"), "https://ucan.example.com");
  assert.equal(normalizeUcanStorePublicOrigin("http://localhost:8080/api"), "http://localhost:8080");
  assert.equal(normalizeUcanStorePublicOrigin("ftp://example.com"), "");
  assert.equal(ucanStorePublicOriginHost("https://ucan.example.com/api"), "ucan.example.com");
});

test("all SDL templates align pricing denom to the selected network escrow denom", () => {
  const escrowDenom = getEndpoints("mainnet").deploymentEscrowMinimalDenom;
  for (const template of SDL_TEMPLATES) {
    const sdl = getSdlTemplate("mainnet", template.id);
    assert.match(sdl, new RegExp(`denom: ${escrowDenom}\\b`), template.id);
  }
});

test("nginx smoke template remains available", () => {
  const sdl = getSdlTemplate("mainnet", "nginx-smoke");
  assert.match(sdl, /image: nginx:1\.27-alpine/);
});
