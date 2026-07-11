import type { LeaseAccessIp, LeaseAccessPort, LeaseAccessService } from "./leaseAccessParser";
import type { SdlExposedPort } from "./sdlPorts";

export type LeaseSshCommand = {
  host: string;
  port: number;
  command: string;
  source: "port" | "ip";
};

export function isSdlSshPort(port: SdlExposedPort): boolean {
  return port.containerPort === 22 || port.publicPort === 22 || port.publicPort === 2222;
}

function hasUsableEndpoint(host: string, port: number): boolean {
  return !!host.trim() && port > 0;
}

function matchesExpectedSshPort(
  providerPort: Pick<LeaseAccessPort | LeaseAccessIp, "port" | "externalPort">,
  expectedSshPorts: SdlExposedPort[]
): boolean {
  return expectedSshPorts.some((expected) => {
    if (providerPort.port > 0) {
      return providerPort.port === expected.containerPort;
    }

    return providerPort.externalPort === expected.publicPort || providerPort.externalPort === expected.containerPort;
  });
}

function sshCommand(host: string, port: number, source: LeaseSshCommand["source"]): LeaseSshCommand {
  return {
    host,
    port,
    command: `ssh -p ${port} root@${host}`,
    source,
  };
}

export function collectLeaseSshCommands(
  service: Pick<LeaseAccessService, "ports" | "ips">,
  expectedPorts: SdlExposedPort[]
): LeaseSshCommand[] {
  const expectedSshPorts = expectedPorts.filter(isSdlSshPort);
  if (expectedSshPorts.length === 0) return [];

  const commands: LeaseSshCommand[] = [];

  for (const port of service.ports) {
    const externalPort = port.externalPort || port.port;
    if (!hasUsableEndpoint(port.host, externalPort)) continue;
    if (!matchesExpectedSshPort(port, expectedSshPorts)) continue;
    commands.push(sshCommand(port.host, externalPort, "port"));
  }

  for (const ip of service.ips) {
    const externalPort = ip.externalPort || ip.port;
    if (!hasUsableEndpoint(ip.ip, externalPort)) continue;
    if (!matchesExpectedSshPort(ip, expectedSshPorts)) continue;
    commands.push(sshCommand(ip.ip, externalPort, "ip"));
  }

  return commands;
}
