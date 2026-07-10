import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SDL_TEMPLATE_ID,
  SDL_TEMPLATES,
  UCAN_STORE_AKASH_IMAGE,
  getDefaultSdl,
  getSdlTemplate,
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
