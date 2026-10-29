export interface ExpertMcpOptions {
  url: string;
  token: string;
  agentHost: string;
}

/** A token stays on this deployment, including when a proxy redirects. */
export class BadgerApi {
  readonly url: string;
  constructor(private readonly options: ExpertMcpOptions) {
    const url = new URL(options.url);
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
      throw new Error(
        "BADGER_URL must be an HTTPS deployment URL or a loopback HTTP URL without credentials, query, or fragment",
      );
    }
    if (
      !options.token ||
      !options.agentHost.trim() ||
      options.agentHost.length > 200 ||
      /[\r\n]/u.test(options.agentHost)
    ) {
      throw new Error("Set BADGER_TOKEN and a valid BADGER_AGENT_HOST");
    }
    this.url = url.href.replace(/\/+$/u, "");
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/v1${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "x-badger-agent-host": this.options.agentHost,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        "Cannot reach Badger; check BADGER_URL and the connection",
      );
    }
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const detail =
        typeof failure?.error?.message === "string"
          ? failure.error.message
              .slice(0, 500)
              .replaceAll(this.options.token, "[redacted]")
          : "Request refused";
      throw new Error(`Badger ${response.status}: ${detail}`);
    }
    return response.json() as Promise<T>;
  }
}
