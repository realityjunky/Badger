export interface ExpertMcpOptions {
  url: string;
  token: string;
  agentHost: string;
  /** Host-owned HTTP transport; certification uses Node HTTP under --jitless. */
  fetch?: typeof fetch;
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

const TIMEOUT_SECONDS = 30;

/** Header values travel as bytes; printable ASCII arrives unchanged. */
export function validAgentHost(value: string): boolean {
  return /^[\x20-\x7e]{1,200}$/u.test(value) && value.trim() !== "";
}

/** A token stays on this deployment, including when a proxy redirects. */
export class BadgerApi {
  readonly url: string;
  constructor(private readonly options: ExpertMcpOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new ConfigurationError("BADGER_URL must be an absolute URL");
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    ) {
      throw new ConfigurationError(
        "BADGER_URL must be an HTTPS deployment URL or a loopback HTTP URL without credentials, query, or fragment",
      );
    }
    if (!options.token) throw new ConfigurationError("Set BADGER_TOKEN");
    if (!validAgentHost(options.agentHost))
      throw new ConfigurationError(
        "BADGER_AGENT_HOST must be 1 to 200 printable ASCII characters",
      );
    this.url = url.href.replace(/\/+$/u, "");
  }

  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutSeconds = TIMEOUT_SECONDS,
  ): Promise<T> {
    let response: Response;
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
      const retryAfter = response.headers.get("retry-after");
      const detail = [
        typeof failure?.error?.message === "string"
          ? failure.error.message
          : "Request refused",
        ...(facts.length ? [`(${facts.join(", ")})`] : []),
        ...(retryAfter && /^\d+$/u.test(retryAfter)
          ? [`Retry after ${retryAfter} s.`]
          : []),
      ]
        .join(" ")
        .replaceAll(this.options.token, "[redacted]")
        .slice(0, 500);
      throw new BadgerApiError(
        response.status,
        code,
        `Badger ${response.status}${code ? ` ${code}` : ""}: ${detail}`,
      );
    }
    return response.json() as Promise<T>;
  }
}
