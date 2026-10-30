import { apiUrl } from "../app/paths.js";
import type { Group } from "./organization.js";
import type { ScriptEffects } from "./skills.js";
import type { SourceStudy } from "./source-study.js";

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
  inheritedFromVersionId?: string | null;
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
  purpose: SkillPinPurpose;
  status: "available" | "missing" | "invalid" | "unsafe" | "ambiguous";
  hash: string | null;
  inventory: { path: string; bytes: number; hash: string }[];
  scripts: { path: string; sideEffects: ScriptEffects }[];
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
  kind: "source-check" | "init" | "generate";
  workflowVersionId: string;
  requesterId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  pinsHash: string;
  /** The latest check's sources are in its read model, not in the job. */
  outcome: {
    status: WorkflowSourceCheck["status"] | "initialized" | "generated";
    blockers: string[];
    stateHash?: string;
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
  confirmSources: boolean;
  manageSourceStudy: boolean;
  composeDossier: boolean;
  approveDossier: boolean;
  editPlan: boolean;
  approvePlan: boolean;
  approveProposal: boolean;
  initialize: boolean;
  generate: boolean;
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
  sourceGate: GateConfirmation | null;
  sourceGateConfirmations?: GateConfirmation[];
  sourceStudy: SourceStudy;
}
export interface GatePreview {
  gate: string;
  workflowVersionId: string;
  boundHashes: Record<string, string>;
  records: { type: string; id: string; label: string; hash: string }[];
  effects: WorkflowStage[];
  confirmationHash: string;
}
export interface GateConfirmation {
  id: string;
  actorId: string;
  confirmedAt: string;
  confirmationHash: string;
  boundHashes: Record<string, string>;
  invalidatedAt: string | null;
  invalidationReason?: string | null;
  supersededBy?: string | null;
}
export interface ApprovalEntry extends GateConfirmation {
  superseded: boolean;
}
/**
 * A gate's approvals, newest first, each superseded once a later change
 * invalidated it; `bound` keeps the approvals of one artifact hash.
 */
export function approvalHistory(
  confirmations: readonly GateConfirmation[] | undefined,
  bound?: { name: string; hash: string },
): ApprovalEntry[] {
  return (confirmations ?? [])
    .filter(
      (confirmation) =>
        bound === undefined ||
        confirmation.boundHashes[bound.name] === bound.hash,
    )
    .map((confirmation) => ({
      ...confirmation,
      superseded: confirmation.invalidatedAt !== null,
    }));
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

export async function read<T>(
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
export async function write<T>(
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
      currentRevision:
        value.workflow?.revision ??
        value.binding?.revision ??
        value.record?.revision,
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
  replacing?: WorkflowSkillPin,
) {
  return write<{ pin: WorkflowSkillPin; job: WorkflowJob; pinsHash: string }>(
    basePath,
    "POST",
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/pins`,
    {
      skillId,
      hash,
      purpose,
      ...(replacing === undefined ? {} : { revision: replacing.revision }),
    },
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
export function previewSources(
  basePath: string,
  workflowId: string,
  versionId: string,
) {
  return write<{ preview: GatePreview }>(
    basePath,
    "POST",
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/gates/sources/preview`,
    {},
  );
}
export function commitSources(
  basePath: string,
  workflowId: string,
  versionId: string,
  confirmationHash: string,
  requestId: string,
) {
  return write<{ confirmation: GateConfirmation }>(
    basePath,
    "POST",
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/gates/sources/commit`,
    { confirmationHash, requestId },
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
