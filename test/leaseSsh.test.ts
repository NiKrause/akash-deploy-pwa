import assert from "node:assert/strict";
import test from "node:test";

import { collectLeaseSshCommands, isSdlSshPort } from "../src/akash/leaseSsh.ts";
import type { SdlExposedPort } from "../src/akash/sdlPorts.ts";

const expectedSsh: SdlExposedPort = {
  serviceName: "ucan-store",
  containerPort: 22,
  publicPort: 2222,
  proto: "tcp",
  global: true,
};

test("isSdlSshPort detects SSH exposes", () => {
  assert.equal(isSdlSshPort(expectedSsh), true);
  assert.equal(
    isSdlSshPort({
      serviceName: "ucan-store",
      containerPort: 8080,
      publicPort: 80,
      proto: "tcp",
      global: true,
    }),
    false
  );
});

test("collectLeaseSshCommands formats provider-reported forwarded SSH ports", () => {
  const commands = collectLeaseSshCommands(
    {
      ports: [
        {
          host: "provider.example",
          name: "ssh",
          proto: "tcp",
          port: 22,
          externalPort: 31778,
        },
      ],
      ips: [],
    },
    [expectedSsh]
  );

  assert.deepEqual(commands, [
    {
      host: "provider.example",
      port: 31778,
      command: "ssh -p 31778 root@provider.example",
      source: "port",
    },
  ]);
});

test("collectLeaseSshCommands ignores missing provider SSH forwarding", () => {
  const commands = collectLeaseSshCommands(
    {
      ports: [],
      ips: [],
    },
    [expectedSsh]
  );

  assert.deepEqual(commands, []);
});
