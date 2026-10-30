import { apiUrl } from "../app/paths.js";

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
export interface Delivery {
  id: string;
  robotLabel: string;
  recipients: { name: string; count: number }[];
  content: { text: { content: string } };
  status: "queued" | "sending" | "retry" | "sent" | "failed" | "cancelled";
  attempts: number;
  error: string | null;
  createdAt: string;
}
export type NotificationResult<T> =
  { kind: "ok"; value: T } | { kind: "failed" | "denied" | "conflict" };

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
    return {
      kind:
        response.status === 409
          ? "conflict"
          : response.status === 403 || response.status === 401
            ? "denied"
            : "failed",
    };
  } catch {
    return { kind: "failed" };
  }
}
