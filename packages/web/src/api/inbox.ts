import { apiUrl } from "../app/paths.js";

export interface InboxItem {
  id: string;
  workflowVersionId: string;
  workflowName: string;
  versionNumber: number;
  gate: string;
  kind:
    | "gate-ready"
    | "gate-invalidated"
    | "question-assigned"
    | "restatement-ready"
    | "question-reopened";
  questionId: string | null;
  questionText: string | null;
  state: "unread" | "read" | "done";
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
): Promise<InboxPage> {
  const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await fetch(apiUrl(basePath, `/me/inbox${query}`), {
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
