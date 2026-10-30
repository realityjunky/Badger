import { apiUrl, normalizeBasePath } from "../app/paths.js";
import { formatMessage, message } from "../i18n/catalog.js";
import type { Language } from "../preferences/model.js";
import { isRecord } from "../util/records.js";

export type NotificationEvent =
  | "gate-ready"
  | "gate-invalidated"
  | "question-assigned"
  | "answer-submitted"
  | "restatement-ready"
  | "question-reopened"
  | "concern-raised"
  | "job-submitted";
export interface NotificationPreferences {
  revision: number;
  wecomUserId: string | null;
  mobile: string | null;
  mentionEvents: NotificationEvent[];
}
export interface RobotChannel {
  id: string;
  label: string;
  language: "en" | "zh";
  revision: number;
  webhookUrl: string;
}
export interface WaitingItem {
  id: string;
  kind: NotificationEvent;
  href: string;
  recipients: { name: string; count: number }[];
  canRemind: boolean;
  remindAfter: string | null;
}
/** What Remind returns for Copy reminder: the parts, not the text. */
export interface CopyReminder {
  workflowName: string;
  event: NotificationEvent;
  recipients: { name: string; count: number }[];
  /** The item's page, relative to the dashboard's base path. */
  href: string;
}
export interface ReminderResult {
  /** Null when a robot post would have reached nobody, so none was recorded. */
  reminder: {
    id: string;
    recipients: { name: string; count: number }[];
    createdAt: string;
  } | null;
  copy: CopyReminder | null;
  deliveryId: string | null;
  remindAfter: string | null;
}

/**
 * Ready-to-paste text in the viewer's language. The link starts from the
 * page's own origin and base path, so it works without BADGER_PUBLIC_URL.
 */
export function copyReminderText(
  copy: CopyReminder,
  locale: Language,
  origin: string,
  basePath: string,
): string {
  const base = normalizeBasePath(basePath);
  return [
    formatMessage(locale, "notifications.copyTitle", {
      workflow: copy.workflowName,
    }),
    message(locale, `notifications.waitingFor.${copy.event}`),
    ...copy.recipients.map(
      (recipient) =>
        `${recipient.name.replace(/[\r\n]+/gu, " ").slice(0, 80)}: ${recipient.count}`,
    ),
    `${origin}${base === "/" ? "" : base}${copy.href}`,
  ].join("\n");
}

export interface Delivery {
  id: string;
  robotLabel: string;
  /** How the post mentioned each person; the log never carries the identifiers. */
  recipients: {
    name: string;
    count: number;
    mention: "userid" | "mobile" | "name";
  }[];
  content: { text: { content: string } };
  status: "queued" | "sending" | "retry" | "sent" | "failed" | "cancelled";
  attempts: number;
  error: string | null;
  createdAt: string;
}
/** A refusal carries the server's reason, or "" when it gave none. */
export type NotificationResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed" | "denied" | "conflict"; message: string };

export async function notificationRequest<T>(
  basePath: string,
  route: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<NotificationResult<T>> {
  try {
    const response = await fetch(apiUrl(basePath, route), {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (response.ok) return { kind: "ok", value: (await response.json()) as T };
    const refusal: unknown = await response.json().catch(() => null);
    return {
      kind:
        response.status === 409
          ? "conflict"
          : response.status === 403 || response.status === 401
            ? "denied"
            : "failed",
      message:
        isRecord(refusal) &&
        isRecord(refusal.error) &&
        typeof refusal.error.message === "string"
          ? refusal.error.message
          : "",
    };
  } catch {
    return { kind: "failed", message: "" };
  }
}
