import { yaml } from "@akashnetwork/chain-sdk/web";

export type SdlExposedPort = {
  serviceName: string;
  containerPort: number;
  publicPort: number;
  proto: string;
  global: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function readUint(value: unknown): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function collectSdlExposedPorts(yamlText: string): SdlExposedPort[] {
  let parsed: unknown;
  try {
    parsed = yaml.raw(yamlText);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !isRecord(parsed.services)) return [];

  const ports: SdlExposedPort[] = [];
  for (const [serviceName, service] of Object.entries(parsed.services)) {
    if (!isRecord(service)) continue;

    for (const expose of readArray(service.expose)) {
      if (!isRecord(expose)) continue;
      const containerPort = readUint(expose.port);
      if (containerPort === null) continue;

      const publicPort = readUint(expose.as) ?? containerPort;
      const proto = (readString(expose.proto) ?? readString(expose.protocol) ?? "tcp").trim().toLowerCase() || "tcp";
      const global = readArray(expose.to).some((target) => isRecord(target) && target.global === true);

      ports.push({ serviceName, containerPort, publicPort, proto, global });
    }
  }

  return ports;
}

export function formatSdlExposedPortLabel(port: SdlExposedPort): string {
  if (port.publicPort === 443 || port.containerPort === 443) return "HTTPS";
  if (port.publicPort === 80 || port.containerPort === 80 || port.containerPort === 8080) return "HTTP";
  if (port.publicPort === 22 || port.publicPort === 2222 || port.containerPort === 22) return "SSH";
  return `${port.proto.toUpperCase()} port`;
}
