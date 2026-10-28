export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
}

/** The hostnames that count as the machine the service runs on. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
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
