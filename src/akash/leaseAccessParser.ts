export type LeaseAccessIp = {
  ip: string;
  protocol: string;
  port: number;
  externalPort: number;
};

export type LeaseAccessPort = {
  host: string;
  name: string;
  proto: string;
  port: number;
  externalPort: number;
};

export type LeaseAccessService = {
  name: string;
  available: number;
  total: number;
  uris: string[];
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  ports: LeaseAccessPort[];
  ips: LeaseAccessIp[];
};

export type LeaseAccessDetails = {
  dseq: string;
  provider: string;
  providerHostUri: string;
  statusUrl: string;
  services: LeaseAccessService[];
  raw: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function readUint(value: unknown): number {
  const raw = readString(value);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((entry): entry is string => !!entry?.trim()).map((entry) => entry.trim());
}

function readRecordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function parseLeaseAccessIp(value: unknown): LeaseAccessIp | null {
  if (!isRecord(value)) return null;
  const ip = readString(readRecordValue(value, "ip"))?.trim();
  if (!ip) return null;
  return {
    ip,
    protocol: readString(readRecordValue(value, "protocol", "proto"))?.trim() ?? "",
    port: readUint(readRecordValue(value, "port")),
    externalPort: readUint(readRecordValue(value, "externalPort", "external_port")),
  };
}

function parseLeaseAccessPort(value: unknown): LeaseAccessPort | null {
  if (!isRecord(value)) return null;
  const host = readString(readRecordValue(value, "host"))?.trim();
  const name = readString(readRecordValue(value, "name"))?.trim() ?? "";
  if (!host && !name) return null;
  return {
    host: host ?? "",
    name,
    proto: readString(readRecordValue(value, "proto", "protocol"))?.trim() ?? "",
    port: readUint(readRecordValue(value, "port")),
    externalPort: readUint(readRecordValue(value, "externalPort", "external_port")),
  };
}

function parseLeaseAccessService(value: unknown): LeaseAccessService | null {
  if (!isRecord(value)) return null;
  const rawStatus = readRecordValue(value, "status");
  const status = isRecord(rawStatus) ? rawStatus : value;
  const name = readString(readRecordValue(value, "name"))?.trim();
  const uris = readStringArray(readRecordValue(status, "uris"));
  const rawPorts = readRecordValue(value, "ports");
  const ports = Array.isArray(rawPorts)
    ? rawPorts.map(parseLeaseAccessPort).filter((entry): entry is LeaseAccessPort => !!entry)
    : [];
  const rawIps = readRecordValue(value, "ips");
  const ips = Array.isArray(rawIps)
    ? rawIps.map(parseLeaseAccessIp).filter((entry): entry is LeaseAccessIp => !!entry)
    : [];
  if (!name && uris.length === 0 && ports.length === 0 && ips.length === 0) return null;
  return {
    name: name ?? "service",
    available: readUint(readRecordValue(status, "available")),
    total: readUint(readRecordValue(status, "total")),
    uris,
    replicas: readUint(readRecordValue(status, "replicas")),
    readyReplicas: readUint(readRecordValue(status, "readyReplicas", "ready_replicas")),
    availableReplicas: readUint(readRecordValue(status, "availableReplicas", "available_replicas")),
    ports,
    ips,
  };
}

function serviceValuesFromProviderStatus(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  const servicesRaw = readRecordValue(value, "services");
  if (Array.isArray(servicesRaw)) return servicesRaw;
  if (!isRecord(servicesRaw)) return [];
  return Object.entries(servicesRaw).map(([name, service]) => {
    if (!isRecord(service)) return service;
    return readString(readRecordValue(service, "name")) ? service : { ...service, name };
  });
}

export function parseLeaseAccessDetails(
  dseq: string,
  provider: string,
  providerHostUri: string,
  statusUrl: string,
  value: unknown
): LeaseAccessDetails {
  const services = serviceValuesFromProviderStatus(value)
    .map(parseLeaseAccessService)
    .filter((entry): entry is LeaseAccessService => !!entry);
  return {
    dseq,
    provider,
    providerHostUri,
    statusUrl,
    services,
    raw: value,
  };
}
