import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SDL_TEMPLATE_ID,
  SDL_TEMPLATES,
  getDefaultSdl,
  getSdlTemplate,
} from "../src/akash/defaultSdl.ts";
import { getEndpoints } from "../src/config/networks.ts";

test("UCAN Store is the default SDL template", () => {
  assert.equal(DEFAULT_SDL_TEMPLATE_ID, "ucan-store");
  assert.match(getDefaultSdl("mainnet"), /ghcr\.io\/nomadkids\/ucan-store-akash:latest/);
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
