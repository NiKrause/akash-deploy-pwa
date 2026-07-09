import assert from "node:assert/strict";
import test from "node:test";

import { parseLeaseAccessDetails } from "../src/akash/leaseAccessParser.ts";

test("parseLeaseAccessDetails accepts provider status services keyed by service name", () => {
  const details = parseLeaseAccessDetails("27643179", "akash1provider", "https://provider.example:8443", "status-url", {
    services: {
      web: {
        name: "web",
        available: 0,
        total: 1,
        uris: ["46324tfaltdg5de8mhifbe7900.ingress.quanglong.org"],
        observed_generation: 1,
        replicas: 1,
        updated_replicas: 1,
        ready_replicas: 0,
        available_replicas: 0,
      },
    },
    forwarded_ports: null,
    ips: null,
  });

  assert.equal(details.services.length, 1);
  assert.deepEqual(details.services[0], {
    name: "web",
    available: 0,
    total: 1,
    uris: ["46324tfaltdg5de8mhifbe7900.ingress.quanglong.org"],
    replicas: 1,
    readyReplicas: 0,
    availableReplicas: 0,
    ports: [],
    ips: [],
  });
});

test("parseLeaseAccessDetails preserves service key when provider omits service name", () => {
  const details = parseLeaseAccessDetails("27643179", "akash1provider", "https://provider.example:8443", "status-url", {
    services: {
      web: {
        total: 1,
        uris: ["example.ingress.quanglong.org"],
      },
    },
  });

  assert.equal(details.services[0]?.name, "web");
});
