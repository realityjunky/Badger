import { apiUrl } from "../app/paths.js";
import type { Group } from "./organization.js";

export interface WorkflowFrame {
  name: string;
  goal: string;
  intent: "new-skill" | "upgrade-existing";
  locale: string;
}
export interface Workflow extends WorkflowFrame {
  id: string;
  groupId: string;
  revision: number;
}
export type StageId =
  | "sources"
  | "source-study"
  | "questionnaire"
  | "dossier"
  | "plan-proposal"
  | "package"
  | "evaluation"
  | "review-publication";
export type StageState = "active" | "todo" | "done" | "blocked" | "invalidated";
export interface WorkflowStage {
  id: StageId;
  state: StageState;
}
export interface WorkflowVersion extends WorkflowFrame {
  id: string;
  number: number;
  revision: number;
  stages: WorkflowStage[];
}
export type SkillPinPurpose = "source" | "upgrade-source";
export interface WorkflowSkillPin {
  workflowVersionId: string;
  skillId: string;
  skillName: string;
  hash: string;
  purpose: SkillPinPurpose;
  revision: number;
  pinnedBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface SourceCheckSource {
  name: string;
  status: "available" | "missing" | "invalid" | "unsafe" | "ambiguous";
  hash: string | null;
  inventory: { path: string; bytes: number; hash: string }[];
  scripts: { path: string; sideEffects: string[] | "undeclared" }[];
  ignored: string[];
  blockers: string[];
}
export interface WorkflowSourceCheck {
  id: string;
  workflowVersionId: string;
  jobId: string | null;
  pinsHash: string;
  status: "queued" | "running" | "passed" | "blocked" | "failed";
  sources: SourceCheckSource[];
  blockers: string[];
  workspacePath: string | null;
  revision: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface WorkflowJob {
  id: string;
  kind: "source-check";
  workflowVersionId: string;
  requesterId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  pinsHash: string;
  outcome: {
    status: WorkflowSourceCheck["status"];
    sources: SourceCheckSource[];
    blockers: string[];
  } | null;
  error: string | null;
  revision: number;
}
export interface WorkflowCapabilities {
  read: boolean;
  editWorkflow: boolean;
  manageRoles: boolean;
  createVersion: boolean;
  managePins: boolean;
}
export const WORKFLOW_ROLES = [
  "Workflow owner",
  "Engineer",
  "Field expert",
  "Reviewer",
  "Operator",
  "Observer",
] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];
export interface WorkflowBinding {
  id: string;
  email: string;
  displayName: string | null;
  role: WorkflowRole;
  pending: boolean;
  revision: number;
}
export interface WorkflowCatalog {
  workflows: (Workflow & {
    groupName: string;
    latestVersion: WorkflowVersion | null;
    capabilities: WorkflowCapabilities;
  })[];
  createGroups: Group[];
}
export interface WorkflowDetail {
  workflow: Workflow;
  groupName: string;
  versions: WorkflowVersion[];
  bindings: WorkflowBinding[];
  capabilities: WorkflowCapabilities;
}
export interface WorkflowVersionDetail {
  workflow: Workflow;
  version: WorkflowVersion;
  capabilities: WorkflowCapabilities;
  pins: WorkflowSkillPin[];
  sourceCheck: WorkflowSourceCheck | null;
  jobs: WorkflowJob[];
}
export type ReadResult<T> =
  { kind: "ok"; value: T } | { kind: "denied" | "missing" | "failed" };
export type WriteResult<T> =
  | { kind: "ok"; value: T }
  | {
      kind: "conflict" | "failed" | "denied";
      message: string;
      currentRevision?: number;
    };

async function read<T>(
  basePath: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReadResult<T>> {
  try {
    const response = await fetch(apiUrl(basePath, path), {
      credentials: "same-origin",
      signal,
    });
    if (response.status === 403 || response.status === 401)
      return { kind: "denied" };
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "failed" };
    return { kind: "ok", value: (await response.json()) as T };
  } catch {
    return { kind: "failed" };
  }
}

/** Conflicts carry the current revision, without retrying the person's write. */
async function write<T>(
  basePath: string,
  method: string,
  path: string,
  body: unknown,
): Promise<WriteResult<T>> {
  try {
    const response = await fetch(apiUrl(basePath, path), {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (response.ok) return { kind: "ok", value: value as T };
    return {
      kind:
        response.status === 409
          ? "conflict"
          : response.status === 403 || response.status === 401
            ? "denied"
            : "failed",
      message:
        typeof value.error?.message === "string" ? value.error.message : "",
      currentRevision: value.workflow?.revision ?? value.binding?.revision,
    };
  } catch {
    return { kind: "failed", message: "" };
  }
}

export function loadWorkflows(basePath: string, signal?: AbortSignal) {
  return read<WorkflowCatalog>(basePath, "/workflows", signal);
}
export function loadWorkflow(
  basePath: string,
  id: string,
  signal?: AbortSignal,
) {
  return read<WorkflowDetail>(
    basePath,
    `/workflows/${encodeURIComponent(id)}`,
    signal,
  );
}
export function loadWorkflowVersion(
  basePath: string,
  workflowId: string,
  versionId: string,
  signal?: AbortSignal,
) {
  return read<WorkflowVersionDetail>(
    basePath,
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}`,
    signal,
  );
}
export function createWorkflow(
  basePath: string,
  input: WorkflowFrame & { groupId: string },
) {
  return write<{ workflow: Workflow; version: WorkflowVersion }>(
    basePath,
    "POST",
    "/workflows",
    input,
  );
}
export function editWorkflow(
  basePath: string,
  workflow: Workflow,
  frame: WorkflowFrame,
) {
  const { name, goal, intent, locale } = frame;
  return write<{ workflow: Workflow }>(
    basePath,
    "PATCH",
    `/workflows/${encodeURIComponent(workflow.id)}`,
    { name, goal, intent, locale, revision: workflow.revision },
  );
}
export function startVersion(basePath: string, workflow: Workflow) {
  return write<{ workflow: Workflow; version: WorkflowVersion }>(
    basePath,
    "POST",
    `/workflows/${encodeURIComponent(workflow.id)}/versions`,
    { revision: workflow.revision },
  );
}
export function pinSkillVersion(
  basePath: string,
  workflowId: string,
  versionId: string,
  skillId: string,
  hash: string,
  purpose: SkillPinPurpose = "source",
) {
  return write<{ pin: WorkflowSkillPin; job: WorkflowJob; pinsHash: string }>(
    basePath,
    "POST",
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/pins`,
    { skillId, hash, purpose },
  );
}
export function unpinSkillVersion(
  basePath: string,
  workflowId: string,
  versionId: string,
  pin: WorkflowSkillPin,
) {
  return write<{ removed: true; job: WorkflowJob; pinsHash: string }>(
    basePath,
    "DELETE",
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/pins/${encodeURIComponent(pin.skillId)}`,
    { revision: pin.revision },
  );
}
export function assignWorkflowRole(
  basePath: string,
  id: string,
  email: string,
  role: WorkflowRole,
) {
  return write<{ binding: WorkflowBinding }>(basePath, "POST", "/bindings", {
    scopeType: "workflow",
    scopeId: id,
    email,
    role,
  });
}
export function removeWorkflowRole(basePath: string, binding: WorkflowBinding) {
  return write<{ removed: true }>(
    basePath,
    "DELETE",
    `/bindings/${encodeURIComponent(binding.id)}`,
    { revision: binding.revision },
  );
}
