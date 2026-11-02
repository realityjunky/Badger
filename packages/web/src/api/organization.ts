import { apiUrl } from "../app/paths.js";
import { isRecord } from "../util/records.js";

export type ScopeType = "organization" | "group" | "workflow";

function scopeType(value: unknown): ScopeType {
  return value === "group" || value === "workflow" ? value : "organization";
}

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
}

export interface MemberBinding {
  id: string;
  revision: number;
  role: string;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeName: string | null;
}

export interface Member {
  person: { id: string; email: string; displayName: string };
  organizationRoles: string[];
  groups: { id: string; name: string; role: string }[];
  bindings: MemberBinding[];
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeName: string | null;
  invitedByName: string;
  revision: number;
  createdAt: string;
}

export interface OrganizationRecords {
  groups: Group[];
  members: Member[];
  invitations: Invitation[];
}

export interface AuditEvent {
  agentHost?: string | null;
  credentialId?: string | null;
  id: string;
  occurredAt: string;
  actorPersonId: string | null;
  actorDisplayName: string | null;
  actorEmail: string | null;
  channel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  /** What the target was when the action happened. */
  targetLabel: string | null;
  reason: string | null;
}

export interface ActivityFilters {
  actorEmail: string;
  action: string;
  channel: string;
  targetType: string;
  /** A `datetime-local` value; empty means no lower bound. */
  from: string;
  /** A `datetime-local` value; empty means no upper bound. */
  to: string;
}

export const EMPTY_FILTERS: ActivityFilters = {
  actorEmail: "",
  action: "",
  channel: "",
  targetType: "",
  from: "",
  to: "",
};

/** An ISO timestamp for a `datetime-local` value, or null when it is unset. */
function isoTime(value: string): string | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type LoadOutcome<T> =
  { kind: "ok"; value: T } | { kind: "denied" } | { kind: "failed" };

/**
 * How a write ended. "rejected" is a rule the server enforces even for a
 * capable person, such as granting oneself an organization role, which an
 * Administrator may override with a recorded reason.
 */
export type WriteOutcome =
  | { kind: "ok"; invitationDelivery?: InvitationDelivery }
  | { kind: "denied" }
  | { kind: "rejected" }
  | { kind: "conflict" }
  | { kind: "failed" };

export interface InvitationDelivery {
  status: "sent" | "failed" | "not-configured";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseGroup(value: unknown): Group | null {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string"
  ) {
    return null;
  }
  return {
    id: value["id"],
    name: value["name"],
    parentId: typeof value["parentId"] === "string" ? value["parentId"] : null,
    revision: typeof value["revision"] === "number" ? value["revision"] : 1,
  };
}

function parseMember(value: unknown): Member | null {
  if (!isRecord(value) || !isRecord(value["person"])) {
    return null;
  }
  const person = value["person"];
  if (
    typeof person["id"] !== "string" ||
    typeof person["email"] !== "string" ||
    typeof person["displayName"] !== "string"
  ) {
    return null;
  }
  const groups = Array.isArray(value["groups"])
    ? value["groups"].filter(isRecord).map((entry) => ({
        id: typeof entry["id"] === "string" ? entry["id"] : "",
        name: typeof entry["name"] === "string" ? entry["name"] : "",
        role: typeof entry["role"] === "string" ? entry["role"] : "",
      }))
    : [];
  const bindings = Array.isArray(value["bindings"])
    ? value["bindings"].filter(isRecord).flatMap((entry) => {
        if (
          typeof entry["id"] !== "string" ||
          typeof entry["revision"] !== "number" ||
          typeof entry["role"] !== "string"
        ) {
          return [];
        }
        return [
          {
            id: entry["id"],
            revision: entry["revision"],
            role: entry["role"],
            scopeType: scopeType(entry["scopeType"]),
            scopeId:
              typeof entry["scopeId"] === "string" ? entry["scopeId"] : null,
            scopeName:
              typeof entry["scopeName"] === "string"
                ? entry["scopeName"]
                : null,
          },
        ];
      })
    : [];
  return {
    person: {
      id: person["id"],
      email: person["email"],
      displayName: person["displayName"],
    },
    organizationRoles: stringArray(value["organizationRoles"]),
    groups,
    bindings,
  };
}

function parseInvitation(value: unknown): Invitation | null {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["email"] !== "string" ||
    typeof value["role"] !== "string"
  ) {
    return null;
  }
  return {
    id: value["id"],
    email: value["email"],
    role: value["role"],
    scopeType: scopeType(value["scopeType"]),
    scopeId: typeof value["scopeId"] === "string" ? value["scopeId"] : null,
    scopeName:
      typeof value["scopeName"] === "string" ? value["scopeName"] : null,
    invitedByName:
      typeof value["invitedByName"] === "string" ? value["invitedByName"] : "",
    revision: typeof value["revision"] === "number" ? value["revision"] : 1,
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : "",
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function get(
  basePath: string,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(apiUrl(basePath, path), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
}

/** Reads the groups, members, and pending invitations the person may see. */
export async function loadOrganization(
  basePath: string,
  signal?: AbortSignal,
): Promise<LoadOutcome<OrganizationRecords>> {
  const [groups, members, invitations] = await Promise.all([
    get(basePath, "/groups?management=true", signal),
    get(basePath, "/members", signal),
    get(basePath, "/invitations", signal),
  ]);
  if (
    [groups, members, invitations].some((response) => response.status === 403)
  ) {
    return { kind: "denied" };
  }
  if (![groups, members, invitations].every((response) => response.ok)) {
    return { kind: "failed" };
  }

  const [groupsBody, membersBody, invitationsBody] = await Promise.all([
    readJson(groups),
    readJson(members),
    readJson(invitations),
  ]);
  if (
    !isRecord(groupsBody) ||
    !isRecord(membersBody) ||
    !isRecord(invitationsBody)
  ) {
    return { kind: "failed" };
  }

  const readList = <T>(
    value: unknown,
    key: string,
    parse: (entry: unknown) => T | null,
  ): T[] =>
    isRecord(value) && Array.isArray(value[key])
      ? value[key].map(parse).filter((entry): entry is T => entry !== null)
      : [];

  return {
    kind: "ok",
    value: {
      groups: readList(groupsBody, "groups", parseGroup),
      members: readList(membersBody, "members", parseMember),
      invitations: readList(invitationsBody, "invitations", parseInvitation),
    },
  };
}

async function send(
  method: string,
  basePath: string,
  path: string,
  body: unknown,
): Promise<WriteOutcome> {
  const response = await fetch(apiUrl(basePath, path), {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.ok) {
    const answer = await readJson(response);
    const delivery = isRecord(answer)
      ? answer["invitationDelivery"]
      : undefined;
    const status = isRecord(delivery) ? delivery["status"] : undefined;
    return {
      kind: "ok",
      ...(status === "sent" ||
      status === "failed" ||
      status === "not-configured"
        ? { invitationDelivery: { status } }
        : {}),
    };
  }
  if (response.status === 403) {
    return { kind: "denied" };
  }
  if (response.status === 409) {
    const answer = await readJson(response);
    if (
      isRecord(answer) &&
      isRecord(answer["error"]) &&
      answer["error"]["code"] === "rejected"
    ) {
      return { kind: "rejected" };
    }
    return { kind: "conflict" };
  }
  return { kind: "failed" };
}

export async function createGroup(
  basePath: string,
  name: string,
  parentId: string | null,
): Promise<WriteOutcome> {
  return send("POST", basePath, "/groups", { name, parentId });
}

export async function inviteByEmail(
  basePath: string,
  input: {
    email: string;
    role: string;
    scopeType: "organization" | "group";
    scopeId: string | null;
    /** Recorded with the binding when it overrides a refused self-grant. */
    overrideReason?: string;
  },
): Promise<WriteOutcome> {
  return send("POST", basePath, "/bindings", input);
}

export function resendInvitation(
  basePath: string,
  id: string,
  revision: number,
): Promise<WriteOutcome> {
  return send(
    "POST",
    basePath,
    `/bindings/${encodeURIComponent(id)}/invitation-email`,
    { revision },
  );
}

/** The groups a person leads and every group inside them. */
export function ledGroupIds(
  personGroups: readonly { id: string; role: string }[],
  groups: readonly Group[],
): Set<string> {
  const led = new Set(
    personGroups
      .filter((grant) => grant.role === "Group lead")
      .map((grant) => grant.id),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of groups) {
      if (
        group.parentId !== null &&
        led.has(group.parentId) &&
        !led.has(group.id)
      ) {
        led.add(group.id);
        grew = true;
      }
    }
  }
  return led;
}

/**
 * Whether to offer a change to a binding or invitation: an Administrator may
 * change any; a Group lead only those on the groups they lead or inside them.
 * The server still decides; this only keeps refused controls out of the way.
 */
export function mayChangeBinding(
  binding: { scopeType: ScopeType; scopeId: string | null },
  administrator: boolean,
  led: ReadonlySet<string>,
): boolean {
  if (administrator) {
    return true;
  }
  return (
    binding.scopeType === "group" &&
    binding.scopeId !== null &&
    led.has(binding.scopeId)
  );
}

export async function removeBinding(
  basePath: string,
  id: string,
  revision: number,
): Promise<WriteOutcome> {
  return send("DELETE", basePath, `/bindings/${encodeURIComponent(id)}`, {
    revision,
  });
}

export function changeGroupRole(
  basePath: string,
  binding: MemberBinding,
  role: string,
): Promise<WriteOutcome> {
  return send(
    "PATCH",
    basePath,
    `/bindings/${encodeURIComponent(binding.id)}`,
    { role, revision: binding.revision },
  );
}

export function groupBindings(
  member: Member,
  groupId: string,
  groups: readonly Group[],
): MemberBinding[] {
  const ancestors = new Set<string>();
  let current: string | null = groupId;
  while (current !== null && !ancestors.has(current)) {
    ancestors.add(current);
    current = groups.find((group) => group.id === current)?.parentId ?? null;
  }
  return member.bindings.filter(
    (binding) =>
      binding.scopeType === "group" &&
      binding.scopeId !== null &&
      ancestors.has(binding.scopeId),
  );
}

/** The activity log's query string, with only the filters that are set. */
export function activityQuery(
  filters: ActivityFilters,
  cursor: string | null,
): string {
  const parameters = new URLSearchParams();
  if (filters.actorEmail.trim() !== "") {
    parameters.set("actorEmail", filters.actorEmail.trim());
  }
  if (filters.action.trim() !== "") {
    parameters.set("action", filters.action.trim());
  }
  if (filters.channel !== "") {
    parameters.set("channel", filters.channel);
  }
  if (filters.targetType.trim() !== "") {
    parameters.set("targetType", filters.targetType.trim());
  }
  const from = isoTime(filters.from);
  if (from !== null) {
    parameters.set("from", from);
  }
  const to = isoTime(filters.to);
  if (to !== null) {
    parameters.set("to", to);
  }
  if (cursor !== null) {
    parameters.set("cursor", cursor);
  }
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

export interface ActivityPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

/** Reads one page of the activity log, newest first. */
export async function loadActivity(
  basePath: string,
  filters: ActivityFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<LoadOutcome<ActivityPage>> {
  const response = await get(
    basePath,
    `/audit-events${activityQuery(filters, cursor)}`,
    signal,
  );
  if (response.status === 403) {
    return { kind: "denied" };
  }
  if (!response.ok) {
    return { kind: "failed" };
  }
  const body = await readJson(response);
  if (!isRecord(body) || !Array.isArray(body["events"])) {
    return { kind: "failed" };
  }
  const events = body["events"].filter(isRecord).map((event): AuditEvent => ({
    id: typeof event["id"] === "string" ? event["id"] : "",
    occurredAt:
      typeof event["occurredAt"] === "string" ? event["occurredAt"] : "",
    actorPersonId:
      typeof event["actorPersonId"] === "string"
        ? event["actorPersonId"]
        : null,
    actorDisplayName:
      typeof event["actorDisplayName"] === "string"
        ? event["actorDisplayName"]
        : null,
    actorEmail:
      typeof event["actorEmail"] === "string" ? event["actorEmail"] : null,
    channel: typeof event["channel"] === "string" ? event["channel"] : "",
    action: typeof event["action"] === "string" ? event["action"] : "",
    targetType:
      typeof event["targetType"] === "string" ? event["targetType"] : "",
    targetId: typeof event["targetId"] === "string" ? event["targetId"] : null,
    targetLabel:
      typeof event["targetLabel"] === "string" ? event["targetLabel"] : null,
    reason: typeof event["reason"] === "string" ? event["reason"] : null,
  }));
  return {
    kind: "ok",
    value: {
      events,
      nextCursor:
        typeof body["nextCursor"] === "string" ? body["nextCursor"] : null,
    },
  };
}
