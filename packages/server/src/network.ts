import { isIPv4, isIPv6 } from "node:net";

export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
}

function canonicalIPv6(address: string): string | null {
  try {
    return normalizeHostname(new URL(`http://[${address}]`).hostname);
  } catch {
    return null;
  }
}

/**
 * The hostnames that count as the machine the service runs on: `localhost`,
 * an IPv4 address in 127.0.0.0/8, or `::1`. Names are never resolved, so a
 * DNS name such as `127.example.com` is not loopback.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost") {
    return true;
  }
  if (isIPv4(normalized)) {
    return normalized.split(".")[0] === "127";
  }
  return isIPv6(normalized) && canonicalIPv6(normalized) === "::1";
}

/** The browser origins of a service listening on loopback at this port. */
export function loopbackOrigins(port: number): string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
}

export interface ParsedHost {
  hostname: string;
  port: string | null;
}

/** Reads the authority of a Host header without trusting it. */
export function parseHostHeader(host: string): ParsedHost | null {
  if (host.length === 0 || /[\s/\\]/u.test(host)) {
    return null;
  }
  try {
    const url = new URL(`http://${host}`);
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port === "" ? null : url.port,
    };
  } catch {
    return null;
  }
}
