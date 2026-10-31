import { deploymentUrl } from "@realityjunky/badger-hosts/configuration";

/** The HTTP seam needs no fetch implementation or WebAssembly-backed globals. */
export interface BadgerHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type BadgerHttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<BadgerHttpResponse>;

export interface ExpertMcpOptions {
  url: string;
  token: string;
  agentHost: string;
  /** Host-owned HTTP transport; certification uses Node HTTP under --jitless. */
  fetch?: BadgerHttpTransport;
}

/** A setting is wrong; the message names the setting, never its value. */
export class ConfigurationError extends Error {}
export class BadgerConnectionError extends Error {}

/** The service refused a request; `code` is its error kind. */
export class BadgerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** Seconds the service asked the caller to wait, from `Retry-After`. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** The service did not answer in time, so a write may still have landed. */
export class BadgerTimeoutError extends Error {
  constructor(
    readonly seconds: number,
    message: string,
  ) {
    super(message);
  }
}

/** A rate limit is never a denial: the token is still valid, and the request
 * may be repeated once `retryAfter` has passed. */
export function isRateLimitedBadgerFailure(
  error: unknown,
): error is BadgerApiError {
  return error instanceof BadgerApiError && error.status === 429;
}

/** Only transport outages, explicit gateway/service availability failures, and
 * rate limits can reuse this live connection's previously successful
 * authorization. */
export function isRetryableBadgerFailure(error: unknown): boolean {
  return (
    error instanceof BadgerConnectionError ||
    error instanceof BadgerTimeoutError ||
    isRateLimitedBadgerFailure(error) ||
    (error instanceof BadgerApiError && [502, 503, 504].includes(error.status))
  );
}

const TIMEOUT_SECONDS = 30;

/** Header values travel as bytes; printable ASCII arrives unchanged. */
export function validAgentHost(value: string): boolean {
  return /^[\x20-\x7e]{1,200}$/u.test(value) && value.trim() !== "";
}

/** A token stays on this deployment, including when a proxy redirects. */
export class BadgerApi {
  readonly url: string;
  constructor(private readonly options: ExpertMcpOptions) {
    try {
      this.url = deploymentUrl(options.url);
    } catch (error) {
      throw new ConfigurationError(
        `BADGER_URL: ${error instanceof Error ? error.message : "Set a valid Badger deployment URL"}`,
      );
    }
    if (!options.token) throw new ConfigurationError("Set BADGER_TOKEN");
    if (!validAgentHost(options.agentHost))
      throw new ConfigurationError(
        "BADGER_AGENT_HOST must be 1 to 200 printable ASCII characters",
      );
  }

  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutSeconds = TIMEOUT_SECONDS,
  ): Promise<T> {
    let response: BadgerHttpResponse;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.url}/api/v1${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "x-badger-agent-host": this.options.agentHost,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new BadgerTimeoutError(
          timeoutSeconds,
          `Badger did not answer within ${timeoutSeconds} s.${method === "GET" ? "" : " The change may still have been saved; read the current state before repeating it."}`,
        );
      if (
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "unexpected redirect"
      )
        throw new Error(
          "Badger answered with a redirect, which the MCP refuses so the token stays with this deployment; check BADGER_URL, including its base path",
        );
      throw new BadgerConnectionError(
        "Cannot reach Badger; check BADGER_URL and the connection",
      );
    }
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as
        | ({ error?: { code?: unknown; message?: unknown } } & Record<
            string,
            unknown
          >)
        | null;
      const code =
        typeof failure?.error?.code === "string" ? failure.error.code : null;
      // Facts a caller acts on, such as a conflict's current revision.
      const facts = Object.entries(failure ?? {})
        .filter(
          ([key, value]) =>
            !["error", "requestId"].includes(key) &&
            ["string", "number", "boolean"].includes(typeof value),
        )
        .map(([key, value]) => `${key}: ${String(value)}`);
      const header = response.headers.get("retry-after");
      const retryAfter =
        header && /^\d+$/u.test(header) ? Number(header) : null;
      const detail = [
        typeof failure?.error?.message === "string"
          ? failure.error.message
          : "Request refused",
        ...(facts.length ? [`(${facts.join(", ")})`] : []),
        ...(retryAfter === null ? [] : [`Retry after ${retryAfter} s.`]),
      ]
        .join(" ")
        .replaceAll(this.options.token, "[redacted]")
        .slice(0, 500);
      throw new BadgerApiError(
        response.status,
        code,
        `Badger ${response.status}${code ? ` ${code}` : ""}: ${detail}`,
        retryAfter,
      );
    }
    return response.json() as Promise<T>;
  }
}
