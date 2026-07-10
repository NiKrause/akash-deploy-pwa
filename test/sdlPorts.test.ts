import assert from "node:assert/strict";
import test from "node:test";

import { collectSdlExposedPorts, formatSdlExposedPortLabel } from "../src/akash/sdlPorts.ts";

test("collectSdlExposedPorts reads global service exposes from SDL", () => {
  const ports = collectSdlExposedPorts(`version: "2.0"
services:
  ucan-store:
    image: ghcr.io/nomadkids/ucan-store-akash:latest
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
      - port: 443
        as: 443
        proto: tcp
        to:
          - global: true
      - port: 22
        as: 2222
        to:
          - global: true
`);

  assert.deepEqual(ports, [
    { serviceName: "ucan-store", containerPort: 8080, publicPort: 80, proto: "tcp", global: true },
    { serviceName: "ucan-store", containerPort: 443, publicPort: 443, proto: "tcp", global: true },
    { serviceName: "ucan-store", containerPort: 22, publicPort: 2222, proto: "tcp", global: true },
  ]);
  assert.deepEqual(ports.map(formatSdlExposedPortLabel), ["HTTP", "HTTPS", "SSH"]);
});

test("collectSdlExposedPorts returns an empty list for invalid SDL", () => {
  assert.deepEqual(collectSdlExposedPorts("not: [valid"), []);
});
