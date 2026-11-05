import { randomUUID } from "node:crypto";
import {
  WSClient,
  type TextMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { Logger } from "../log.js";
import type { ChannelRow } from "./channels.js";
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationTarget,
  RobotMessage,
} from "./port.js";
import { decryptTarget, targetBotKey } from "./secrets.js";
import { WeComChannel } from "./wecom.js";
import { verificationHash, type PersonalRobotRow } from "./robots.js";
import { recordAudit } from "../audit.js";

type PersonalTarget = Extract<
  NotificationTarget,
  { transport: "long-connection" }
>;

interface BotConnection {
  client: WSClient;
  target: PersonalTarget;
  recipients: Map<string, "en" | "zh">;
  ready: Promise<boolean>;
  settleReady(value: boolean): void;
  authenticated: boolean;
  expiresAt: number;
  seen: Map<string, number>;
}

const LEASE_MILLISECONDS = 30_000;
const LOCAL_LEASE_MILLISECONDS = 20_000;
const silentSdkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function markdownText(content: string): string {
  return content
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_\[\]])/gu, "\\$1");
}

function failure(error: unknown): DeliveryResult {
  const code =
    typeof error === "object" && error !== null && "errcode" in error
      ? error.errcode
      : undefined;
  return typeof code === "number" && Number.isSafeInteger(code)
    ? {
        ok: false,
        error: `WeCom long-connection error ${code}`,
        rateLimited: code === 45008 || code === 45009,
      }
    : {
        ok: false,
        error:
          "WeCom long-connection authentication, connection, or acknowledgement failed",
      };
}

function proxyOptions(config: ServiceConfig["notifications"]) {
  const hostname = "openws.work.weixin.qq.com";
  const bypass = (config.noProxy ?? "")
    .toLowerCase()
    .split(/[,\s]+/u)
    .some((rule) => {
      const host = rule.replace(/:443$/u, "").replace(/^\*?\./u, "");
      return (
        rule === "*" ||
        (host !== "" && (hostname === host || hostname.endsWith(`.${host}`)))
      );
    });
  const proxy = config.httpsProxy || config.httpProxy;
  return !bypass && proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
}

export class WeComNotificationChannels implements NotificationChannel {
  readonly connectionOwner = randomUUID();
  private readonly connections = new Map<string, BotConnection>();
  private readonly webhook: WeComChannel;
  private readonly watchdog: NodeJS.Timeout;
  private closed = false;
  private renewing = false;
  private renewedAt = 0;

  constructor(
    private readonly options: {
      database: Database;
      config: ServiceConfig;
      dependencies: ServiceDependencies;
      logger?: Logger;
      longConnectionUrl?: string;
    },
  ) {
    this.webhook = new WeComChannel(options.config.notifications);
    this.watchdog = setInterval(() => {
      for (const [key, connection] of this.connections)
        if (connection.expiresAt <= Date.now()) this.disconnect(key);
      if (
        !this.renewing &&
        this.connections.size > 0 &&
        Date.now() - this.renewedAt >= 5000
      ) {
        this.renewing = true;
        this.renewedAt = Date.now();
        void this.renewLeases()
          .catch(() => undefined)
          .finally(() => {
            this.renewing = false;
          });
      }
    }, 1000);
    this.watchdog.unref();
  }

  private async renewLeases(): Promise<void> {
    for (const [key, connection] of this.connections) {
      const now = this.options.dependencies.clock.now();
      const renewed = await this.options.database.query(
        "update notification_bot_leases set lease_until = $4 where bot_key = $1 and holder = $2 and lease_until > $3 returning bot_key",
        [
          key,
          this.connectionOwner,
          now,
          new Date(now.getTime() + LEASE_MILLISECONDS),
        ],
      );
      if (this.closed || this.connections.get(key) !== connection) continue;
      if (renewed.rows.length === 0) this.disconnect(key);
      else {
        connection.expiresAt = Date.now() + LOCAL_LEASE_MILLISECONDS;
        await this.health(
          key,
          connection.authenticated ? "connected" : "connecting",
        );
      }
    }
  }

  private async health(
    key: string,
    state: PersonalRobotRow["connection_state"],
  ): Promise<void> {
    await this.options.database.query(
      `update personal_robots set connection_state=$2,connection_checked_at=$3 where bot_key=$1
      and exists (select 1 from notification_bot_leases where bot_key=$1 and holder=$4 and lease_until>$3)`,
      [key, state, this.options.dependencies.clock.now(), this.connectionOwner],
    );
  }

  private disconnect(key: string): void {
    const connection = this.connections.get(key);
    if (connection === undefined) return;
    this.connections.delete(key);
    connection.authenticated = false;
    connection.settleReady(false);
    connection.client.disconnect();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    const { config, database, dependencies } = this.options;
    const encryptionKey = config.notifications.encryptionKey;
    if (encryptionKey === null || config.notifications.publicUrl === null) {
      for (const key of this.connections.keys()) this.disconnect(key);
      return;
    }
    const rows = (
      await database.query<ChannelRow>(
        "select * from notification_channels where transport = 'long-connection' order by updated_at desc, id",
      )
    ).rows;
    const personal = (
      await database.query<PersonalRobotRow>(
        "select r.* from personal_robots r join people p on p.id=r.person_id where r.enabled and not r.suspended and p.status='active' order by r.id",
      )
    ).rows;
    const desired = new Map<
      string,
      { target: PersonalTarget; recipients: Map<string, "en" | "zh"> }
    >();
    const invalidBots = new Set<string>();
    for (const row of [
      ...rows,
      ...personal.map((robot) => ({
        ...robot,
        transport: "long-connection" as const,
      })),
    ]) {
      try {
        const target = decryptTarget(
          row.target_ciphertext,
          row.transport,
          encryptionKey,
        );
        if (
          target.transport !== "long-connection" ||
          row.bot_key !== targetBotKey(target, encryptionKey)
        )
          continue;
        const existing = desired.get(row.bot_key!);
        if (existing === undefined)
          desired.set(row.bot_key!, {
            target,
            recipients: new Map([[target.recipientUserId, row.language]]),
          });
        else if (
          existing.target.botSecret === target.botSecret &&
          !existing.recipients.has(target.recipientUserId)
        )
          existing.recipients.set(target.recipientUserId, row.language);
      } catch {
        if (row.bot_key !== null) invalidBots.add(row.bot_key);
        this.options.logger?.error({
          event: "worker.wecom-configuration",
          error:
            "Cannot decrypt a long-connection robot with BADGER_NOTIFICATION_KEY",
        });
      }
    }
    for (const [key, connection] of this.connections)
      if (
        !desired.has(key) ||
        desired.get(key)!.target.botSecret !== connection.target.botSecret
      ) {
        this.disconnect(key);
        await database.query(
          "delete from notification_bot_leases where bot_key = $1 and holder = $2",
          [key, this.connectionOwner],
        );
      }
    for (const [key, wanted] of desired) {
      const now = dependencies.clock.now();
      const acquired = await database.query(
        `insert into notification_bot_leases (bot_key, holder, lease_until) values ($1,$2,$4)
        on conflict (bot_key) do update set holder = excluded.holder, lease_until = excluded.lease_until
        where notification_bot_leases.holder = $2 or notification_bot_leases.lease_until <= $3 returning bot_key`,
        [
          key,
          this.connectionOwner,
          now,
          new Date(now.getTime() + LEASE_MILLISECONDS),
        ],
      );
      if (this.closed || acquired.rows.length === 0) {
        this.disconnect(key);
        continue;
      }
      const connection =
        this.connections.get(key) ?? this.connect(key, wanted.target);
      connection.expiresAt = Date.now() + LOCAL_LEASE_MILLISECONDS;
      connection.recipients = wanted.recipients;
      await this.health(
        key,
        connection.authenticated ? "connected" : "connecting",
      );
    }
    for (const key of invalidBots) {
      if (desired.has(key)) continue;
      const now = dependencies.clock.now();
      await database.query(
        `insert into notification_bot_leases (bot_key, holder, lease_until) values ($1,$2,$4)
        on conflict (bot_key) do update set holder = excluded.holder, lease_until = excluded.lease_until
        where notification_bot_leases.holder = $2 or notification_bot_leases.lease_until <= $3`,
        [
          key,
          this.connectionOwner,
          now,
          new Date(now.getTime() + LEASE_MILLISECONDS),
        ],
      );
      await this.health(key, "error");
    }
  }

  private connect(key: string, target: PersonalTarget): BotConnection {
    const client = new WSClient({
      botId: target.botId,
      secret: target.botSecret,
      wsUrl: this.options.longConnectionUrl,
      wsOptions: {
        ...(this.options.longConnectionUrl === undefined
          ? proxyOptions(this.options.config.notifications)
          : {}),
        handshakeTimeout: 10_000,
        maxPayload: 64 * 1024,
      },
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: silentSdkLogger,
    });
    let resolveReady!: (value: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const timeout = setTimeout(() => resolveReady(false), 10_000);
    timeout.unref();
    const connection: BotConnection = {
      client,
      target,
      recipients: new Map(),
      ready,
      settleReady: (value) => {
        clearTimeout(timeout);
        resolveReady(value);
      },
      authenticated: false,
      expiresAt: Date.now() + LOCAL_LEASE_MILLISECONDS,
      seen: new Map(),
    };
    this.connections.set(key, connection);
    client.on("authenticated", () => {
      connection.authenticated = true;
      connection.settleReady(true);
      void this.health(key, "connected").catch(() => undefined);
    });
    client.on("disconnected", () => {
      connection.authenticated = false;
      void this.health(key, "disconnected").catch(() => undefined);
    });
    client.on("error", () => {
      connection.authenticated = false;
      connection.settleReady(false);
      void this.health(key, "error").catch(() => undefined);
    });
    client.on("message.text", (frame) => {
      void this.reply(key, connection, frame).catch(() => undefined);
    });
    client.connect();
    return connection;
  }

  private async owns(key: string, connection: BotConnection): Promise<boolean> {
    if (
      this.closed ||
      this.connections.get(key) !== connection ||
      connection.expiresAt <= Date.now()
    )
      return false;
    const result = await this.options.database.query(
      "select 1 from notification_bot_leases where bot_key = $1 and holder = $2 and lease_until > $3",
      [key, this.connectionOwner, this.options.dependencies.clock.now()],
    );
    if (result.rows.length > 0) return true;
    this.disconnect(key);
    return false;
  }

  async post(
    target: NotificationTarget,
    message: RobotMessage,
  ): Promise<DeliveryResult> {
    if (target.transport === "webhook")
      return this.webhook.post(target, message);
    const encryptionKey = this.options.config.notifications.encryptionKey;
    if (encryptionKey === null)
      return { ok: false, error: "Worker lacks BADGER_NOTIFICATION_KEY" };
    const key = targetBotKey(target, encryptionKey)!;
    const connection = this.connections.get(key);
    if (
      connection === undefined ||
      connection.target.botSecret !== target.botSecret ||
      !connection.recipients.has(target.recipientUserId)
    )
      return {
        ok: false,
        error:
          "Personal robot connection is unavailable; check its saved credentials and recipient",
      };
    try {
      if (!connection.authenticated) await connection.ready;
      if (!connection.authenticated || !(await this.owns(key, connection)))
        return failure(null);
      const result = await connection.client.sendMessage(
        target.recipientUserId,
        {
          msgtype: "markdown",
          markdown: { content: markdownText(message.text.content) },
        },
      );
      return result.errcode === 0 ? { ok: true } : failure(result);
    } catch (error) {
      return failure(error);
    }
  }

  private async reply(
    key: string,
    connection: BotConnection,
    frame: WsFrame<TextMessage>,
  ): Promise<void> {
    const body = frame.body;
    if (
      body?.chattype !== "single" ||
      body.aibotid !== connection.target.botId ||
      typeof body.from?.userid !== "string" ||
      typeof body.msgid !== "string" ||
      body.msgid.length > 256
    )
      return;
    const language = connection.recipients.get(body.from.userid);
    if (
      language === undefined ||
      !connection.authenticated ||
      !(await this.owns(key, connection))
    )
      return;
    const now = Date.now();
    for (const [messageId, expiresAt] of connection.seen)
      if (expiresAt <= now) connection.seen.delete(messageId);
    if (connection.seen.has(body.msgid)) return;
    if (connection.seen.size >= 1000)
      connection.seen.delete(connection.seen.keys().next().value!);
    connection.seen.set(body.msgid, now + 10 * 60_000);
    const personal = (
      await this.options.database.query<PersonalRobotRow>(
        "select r.* from personal_robots r join people p on p.id=r.person_id where r.bot_key=$1 and r.enabled and not r.suspended and p.status='active'",
        [key],
      )
    ).rows[0];
    if (personal !== undefined) {
      const command =
        typeof body.text?.content === "string" ? body.text.content.trim() : "";
      if (personal.verified_at === null) {
        if (
          personal.verification_hash === null ||
          personal.verification_expires_at === null ||
          new Date(personal.verification_expires_at).getTime() <=
            this.options.dependencies.clock.now().getTime() ||
          verificationHash(command) !== personal.verification_hash
        )
          return;
        const linked = await this.options.database.transaction(async (tx) => {
          const updated = await tx.query(
            `update personal_robots set verified_at=$3,verification_hash=null,verification_expires_at=null,revision=revision+1
            where id=$1 and verification_hash=$2 and verification_expires_at>$3 and enabled and not suspended and revision=$4 returning id`,
            [
              personal.id,
              personal.verification_hash,
              this.options.dependencies.clock.now(),
              personal.revision,
            ],
          );
          if (updated.rows.length === 0) return false;
          await recordAudit(tx, this.options.dependencies, {
            actor: {
              personId: null,
              credential: { kind: "worker", id: this.connectionOwner },
            },
            channel: "worker",
            action: "personal_robot.linked",
            target: { type: "personal_robot", id: personal.id },
            before: { revision: personal.revision, hash: null },
            after: { revision: personal.revision + 1, hash: null },
            reason: "Personal chat recipient verified by a one-time command",
            requestId: randomUUID(),
          });
          return true;
        });
        if (!linked) return;
      } else if (!personal.replies_enabled) return;
    }
    const link = `${this.options.config.notifications.publicUrl}/my-work`;
    const content =
      language === "zh"
        ? `Badger 通知已连接。请打开我的工作：${link}\n请登录 Badger 查看待办、回答问题及确认审批。`
        : `Badger notifications are connected. Open My work: ${link}\nSign in to Badger to review work, answer questions, and confirm approvals.`;
    await connection.client.replyStream(
      frame,
      randomUUID(),
      markdownText(content),
      true,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const key of this.connections.keys()) {
      await this.health(key, "disconnected").catch(() => undefined);
      this.disconnect(key);
    }
    await this.options.database.query(
      "delete from notification_bot_leases where holder = $1",
      [this.connectionOwner],
    );
  }
}
