import { apiUrl } from "../app/paths.js";

export type InboxState = "unread" | "read" | "done";
export interface InboxFilters {
  workflowIds: string[];
  states: InboxState[];
  from: string;
  to: string;
}
export const EMPTY_INBOX_FILTERS: InboxFilters = {
  workflowIds: [],
  states: [],
  from: "",
  to: "",
};

export interface InboxItem {
  id: string;
  workflowVersionId: string;
  workflowName: string;
  versionNumber: number;
  semanticVersion?: string | null;
  gate: string;
  kind:
    | "gate-ready"
    | "script-effect-review"
    | "gate-invalidated"
    | "question-assigned"
    | "answer-submitted"
    | "restatement-ready"
    | "question-reopened"
    | "concern-raised"
    | "job-submitted"
    | "evaluation-finished";
  questionId: string | null;
  questionText: string | null;
  concernId: string | null;
  concernText: string | null;
  state: InboxState;
  revision: number;
  href: string;
  createdAt: string;
}
export interface InboxPage {
  items: InboxItem[];
  unreadCount: number;
  pendingCount: number;
  pendingQuestionCount: number;
  pendingGateCount: number;
  nextCursor: string | null;
}

export async function loadInbox(
  basePath: string,
  cursor: string | null,
  filters: InboxFilters = EMPTY_INBOX_FILTERS,
): Promise<InboxPage> {
  const query = new URLSearchParams();
  if (cursor !== null) query.set("cursor", cursor);
  for (const id of filters.workflowIds) query.append("workflowId", id);
  for (const state of filters.states) query.append("state", state);
  if (filters.from !== "")
    query.set(
      "createdFrom",
      new Date(`${filters.from}T00:00:00`).toISOString(),
    );
  if (filters.to !== "") {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.set("createdBefore", end.toISOString());
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  const response = await fetch(apiUrl(basePath, `/me/inbox${suffix}`), {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("inbox.failed");
  return (await response.json()) as InboxPage;
}

export async function markInbox(
  basePath: string,
  item: InboxItem,
): Promise<void> {
  const response = await fetch(
    apiUrl(basePath, `/me/inbox/${encodeURIComponent(item.id)}`),
    {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: item.revision,
        state: item.state === "unread" ? "read" : "unread",
      }),
    },
  );
  if (!response.ok) throw new Error("inbox.failed");
}
