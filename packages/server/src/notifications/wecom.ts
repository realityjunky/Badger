import { EnvHttpProxyAgent, fetch } from "undici";
import type {
  DeliveryResult,
  NotificationChannel,
  RobotMessage,
} from "./port.js";

export interface WeComNetworkSettings {
  httpsProxy: string | undefined;
  httpProxy: string | undefined;
  noProxy: string | undefined;
}

/** Text posts support both userid and mobile mentions. Never retain remote error text. */
export class WeComChannel implements NotificationChannel {
  constructor(
    private readonly settings: WeComNetworkSettings,
    private readonly endpoint?: string,
  ) {}

  async post(
    webhookUrl: string,
    message: RobotMessage,
  ): Promise<DeliveryResult> {
    const agent = new EnvHttpProxyAgent({
      httpsProxy: this.settings.httpsProxy,
      httpProxy: this.settings.httpProxy,
      noProxy: this.settings.noProxy,
    });
    try {
      const url = new URL(webhookUrl);
      const response = await fetch(
        this.endpoint === undefined
          ? url
          : new URL(`${url.pathname}${url.search}`, this.endpoint),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          dispatcher: agent,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after"));
        return {
          ok: false,
          error: `WeCom HTTP ${response.status}`,
          rateLimited: response.status === 429,
          ...(Number.isFinite(seconds) && seconds > 0
            ? { retryAfterMilliseconds: Math.min(seconds * 1000, 3_600_000) }
            : {}),
        };
      }
      let text = "";
      for await (const chunk of response.body ?? []) {
        text += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(text) > 16_384)
          return { ok: false, error: "WeCom response too large" };
      }
      const body: unknown = JSON.parse(text);
      if (
        typeof body !== "object" ||
        body === null ||
        !("errcode" in body) ||
        !Number.isInteger(body.errcode)
      )
        return { ok: false, error: "Invalid WeCom response" };
      return body.errcode === 0
        ? { ok: true }
        : {
            ok: false,
            error: `WeCom error ${body.errcode as number}`,
            rateLimited: body.errcode === 45009 || body.errcode === 45008,
          };
    } catch {
      // Fetch, TLS, proxy and remote response errors may contain the secret URL.
      return { ok: false, error: "WeCom connection or response failed" };
    } finally {
      await agent.close();
    }
  }
}
