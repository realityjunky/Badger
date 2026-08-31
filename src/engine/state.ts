import path from "path";
import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
  type EngineRunReadOptions,
  type EngineRunRemoveOptions,
  type EngineRunWriteOptions,
} from "./protected-run-file.js";
import type {
  RunState,
  RuntimeIdentity,
  WorkflowAttemptState,
  WorkflowCycleState,
  WorkflowRuntimeState,
  WorkflowVisitOutcome,
  WorkflowVisitState,
} from "./types.js";
import type {
  WorkflowArtifactLifetime,
  WorkflowArtifactProducer,
  WorkflowArtifactSelection,
  WorkflowArtifactVersion,
  WorkflowDecisionReceipt,
  WorkflowDecisionScopeReference,
  WorkflowDecisionScopeSnapshot,
  WorkflowReviewerAttestation,
} from "../types.js";

export type StateDocument = Record<string, unknown>;

const field = (doc: StateDocument, key: string): string | null => {
  const value = doc[key];
  return value === null || value === undefined ? null : String(value);
};

function requiredString(doc: StateDocument, key: string): string {
  const value = doc[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Run state: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredRunReference(doc: StateDocument, key: string): string {
  const value = requiredString(doc, key);
  assertSafeRunReference(value, key);
  return value;
}

function assertSafeRunReference(value: string, key: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) ||
    /[*?]/u.test(value) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(
      `Invalid Run state: ${key} must stay inside the change directory`,
    );
  }
}

function retries(doc: StateDocument): Record<string, number> {
  const raw = doc.run_retries ?? "{}";
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error("Invalid Run state: run_retries must be a JSON object", {
      cause: error,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Run state: run_retries must be a JSON object");
  }
  for (const count of Object.values(value)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        "Invalid Run state: retry counts must be non-negative integers",
      );
    }
  }
  return value as Record<string, number>;
}

export function runStateFromDocument(doc: StateDocument): RunState | null {
  if (!doc.run_id) return null;
  const runId = requiredString(doc, "run_id");
  const skill = requiredString(doc, "skill");
  const skillVersion = requiredString(doc, "skill_version");
  const skillHash = requiredString(doc, "skill_hash");
  const pendingRef = requiredRunReference(doc, "pending_ref");
  const trajectoryRef = requiredRunReference(doc, "trajectory_ref");
  const contextRef = requiredRunReference(doc, "context_ref");
  const artifactsRef = requiredRunReference(doc, "artifacts_ref");
  const checkpointRef = requiredRunReference(doc, "checkpoint_ref");
  const iteration = Number(doc.iteration);
  if (!Number.isInteger(iteration) || iteration < 0) {
    throw new Error(
      "Invalid Run state: iteration must be a non-negative integer",
    );
  }
  if (
    doc.orchestration !== "deterministic" &&
    doc.orchestration !== "adaptive"
  ) {
    throw new Error(
      "Invalid Run state: orchestration must be deterministic or adaptive",
    );
  }
  if (
    doc.run_status !== "running" &&
    doc.run_status !== "waiting" &&
    doc.run_status !== "completed" &&
    doc.run_status !== "failed"
  ) {
    throw new Error("Invalid Run state: run_status is invalid");
  }
  return {
    runId,
    skill,
    skillVersion,
    skillHash,
    orchestration: doc.orchestration,
    currentStep: field(doc, "current_step"),
    iteration,
    pending: field(doc, "pending"),
    pendingRef,
    trajectoryRef,
    contextRef,
    artifactsRef,
    checkpointRef,
    status: doc.run_status,
    retries: retries(doc),
  };
}

/** Write only run_id onto a yaml document (the rest of Run state lives in .comet/run-state.json). */
export function applyRunStateToDocument(
  doc: StateDocument,
  state: RunState | null,
): void {
  if (state) {
    doc.run_id = state.runId;
  } else {
    delete doc.run_id;
  }
}

export const RUN_STATE_FILE = ".comet/run-state.json";
export const RUN_STATE_MAX_BYTES = 256 * 1024;

interface RunStateJson {
  runId: string;
  skill: string;
  skillVersion: string;
  skillHash: string;
  orchestration: "deterministic" | "adaptive";
  currentStep: string | null;
  iteration: number;
  pending: string | null;
  pendingRef: string;
  trajectoryRef: string;
  contextRef: string;
  artifactsRef: string;
  checkpointRef: string;
  status: "running" | "waiting" | "completed" | "failed";
  retries: Record<string, number>;
  runtimeIdentity?: RuntimeIdentity;
  workflowRuntime?: WorkflowRuntimeState;
}

const RUN_STATE_JSON_KEYS = new Set<keyof RunStateJson>([
  "runId",
  "skill",
  "skillVersion",
  "skillHash",
  "orchestration",
  "currentStep",
  "iteration",
  "pending",
  "pendingRef",
  "trajectoryRef",
  "contextRef",
  "artifactsRef",
  "checkpointRef",
  "status",
  "retries",
  "runtimeIdentity",
  "workflowRuntime",
]);

function requiredJsonString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Run state: ${key} must be a non-empty string`);
  }
  return value;
}

function nullableJsonString(
  value: unknown,
  key: "currentStep" | "pending",
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid Run state: ${key} must be a non-empty string or null`,
    );
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== "string" || entry.length === 0) {
      throw new Error(`Invalid Run state: ${label} must contain strings`);
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry as string]),
  );
}

function parseJsonRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`Invalid Run state: ${label} must be JSON-serializable`, {
      cause: error,
    });
  }
  return structuredClone(value) as Record<string, unknown>;
}

function parseDecisionScalarRecord(
  value: unknown,
  label: string,
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === null) {
      throw new Error(`Invalid Run state: ${label} must contain scalar values`);
    }
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new Error(`Invalid Run state: ${label} must contain scalar values`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error(
        `Invalid Run state: ${label} must contain finite numbers`,
      );
    }
    result[key] = entry;
  }
  return result;
}

function parseReviewerAttestation(
  value: unknown,
  label: string,
): WorkflowReviewerAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const reviewer = value as Record<string, unknown>;
  const unknown = Object.keys(reviewer).find(
    (key) => key !== "subject" && key !== "authorities",
  );
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const subject = reviewer.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error(`Invalid Run state: ${label}.subject must be non-empty`);
  }
  if (
    !Array.isArray(reviewer.authorities) ||
    reviewer.authorities.length === 0 ||
    reviewer.authorities.some(
      (authority) => typeof authority !== "string" || authority.length === 0,
    )
  ) {
    throw new Error(`Invalid Run state: ${label}.authorities must be strings`);
  }
  if (new Set(reviewer.authorities).size !== reviewer.authorities.length) {
    throw new Error(
      `Invalid Run state: ${label}.authorities must not contain duplicates`,
    );
  }
  return {
    subject,
    authorities: [...(reviewer.authorities as string[])],
  };
}

function parseDecisionScopeReference(
  value: unknown,
  label: string,
): WorkflowDecisionScopeReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const reference = value as Record<string, unknown>;
  const keys = new Set([
    "id",
    "required",
    "versionId",
    "contentHash",
    "producer",
  ]);
  const unknown = Object.keys(reference).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const contentHash = requiredJsonString(
    reference.contentHash,
    `${label}.contentHash`,
  );
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error(
      `Invalid Run state: ${label}.contentHash must be a SHA-256 hash`,
    );
  }
  if (typeof reference.required !== "boolean") {
    throw new Error(`Invalid Run state: ${label}.required must be a boolean`);
  }
  if (
    !reference.producer ||
    typeof reference.producer !== "object" ||
    Array.isArray(reference.producer)
  ) {
    throw new Error(`Invalid Run state: ${label}.producer must be an object`);
  }
  const producer = reference.producer as Record<string, unknown>;
  const producerKeys = new Set([
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision",
  ]);
  const unknownProducer = Object.keys(producer).find(
    (key) => !producerKeys.has(key),
  );
  if (unknownProducer) {
    throw new Error(
      `Invalid Run state: ${label}.producer has unknown field ${unknownProducer}`,
    );
  }
  return {
    id: requiredJsonString(reference.id, `${label}.id`),
    required: reference.required,
    versionId: requiredJsonString(reference.versionId, `${label}.versionId`),
    contentHash,
    producer: parseWorkflowArtifactCoordinate(producer, `${label}.producer`),
  };
}

function parseDecisionScope(
  value: unknown,
  label: string,
): WorkflowDecisionScopeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const scope = value as Record<string, unknown>;
  const unknown = Object.keys(scope).find(
    (key) => key !== "artifacts" && key !== "evidence",
  );
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const parseEntries = (kind: "artifacts" | "evidence") => {
    if (!Array.isArray(scope[kind])) {
      throw new Error(`Invalid Run state: ${label}.${kind} must be an array`);
    }
    if (scope[kind].length > 64) {
      throw new Error(
        `Invalid Run state: ${label}.${kind} has too many entries`,
      );
    }
    return scope[kind].map((entry, index) =>
      parseDecisionScopeReference(entry, `${label}.${kind}[${index}]`),
    );
  };
  return {
    artifacts: parseEntries("artifacts"),
    evidence: parseEntries("evidence"),
  };
}

function parseDecisionReceipt(
  value: unknown,
  index: number,
): WorkflowDecisionReceipt {
  const label = `workflowRuntime.decisionReceipts[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const receipt = value as Record<string, unknown>;
  const keys = new Set([
    "runId",
    "revision",
    "resultingRevision",
    "actionId",
    "decisionId",
    "nodeId",
    "cycleId",
    "attemptId",
    "choiceId",
    "reviewer",
    "inputs",
    "rationale",
    "evidenceReferences",
    "scope",
    "timestamp",
    "protocolHash",
    "packageHash",
    "snapshotHash",
  ]);
  const unknown = Object.keys(receipt).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const integer = (key: "revision" | "resultingRevision"): number => {
    const entry = receipt[key];
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0
    ) {
      throw new Error(
        `Invalid Run state: ${label}.${key} must be a non-negative integer`,
      );
    }
    return entry;
  };
  const revision = integer("revision");
  const resultingRevision = integer("resultingRevision");
  if (resultingRevision !== revision + 1) {
    throw new Error(
      `Invalid Run state: ${label} revisions are not consecutive`,
    );
  }
  const cycleId = receipt.cycleId;
  if (
    cycleId !== null &&
    (typeof cycleId !== "string" || cycleId.length === 0)
  ) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`,
    );
  }
  const protocolHash = requiredJsonString(receipt.protocolHash, "protocolHash");
  const packageHash = requiredJsonString(receipt.packageHash, "packageHash");
  const snapshotHash = requiredJsonString(receipt.snapshotHash, "snapshotHash");
  for (const [key, hash] of [
    ["protocolHash", protocolHash],
    ["packageHash", packageHash],
    ["snapshotHash", snapshotHash],
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(
        `Invalid Run state: ${label}.${key} must be a SHA-256 hash`,
      );
    }
  }
  if (
    receipt.rationale !== undefined &&
    typeof receipt.rationale !== "string"
  ) {
    throw new Error(`Invalid Run state: ${label}.rationale must be a string`);
  }
  let evidenceReferences: string[] | undefined;
  if (receipt.evidenceReferences !== undefined) {
    if (
      !Array.isArray(receipt.evidenceReferences) ||
      receipt.evidenceReferences.some(
        (reference) => typeof reference !== "string" || reference.length === 0,
      )
    ) {
      throw new Error(
        `Invalid Run state: ${label}.evidenceReferences must be strings`,
      );
    }
    evidenceReferences = [...(receipt.evidenceReferences as string[])];
  }
  const scope =
    receipt.scope === undefined
      ? undefined
      : parseDecisionScope(receipt.scope, `${label}.scope`);
  return {
    runId: requiredJsonString(receipt.runId, "runId"),
    revision,
    resultingRevision,
    actionId: requiredJsonString(receipt.actionId, "actionId"),
    decisionId: requiredJsonString(receipt.decisionId, "decisionId"),
    nodeId: requiredJsonString(receipt.nodeId, "nodeId"),
    cycleId: cycleId as string | null,
    attemptId: requiredJsonString(receipt.attemptId, "attemptId"),
    choiceId: requiredJsonString(receipt.choiceId, "choiceId"),
    reviewer: parseReviewerAttestation(receipt.reviewer, `${label}.reviewer`),
    inputs: parseDecisionScalarRecord(receipt.inputs, `${label}.inputs`),
    ...(receipt.rationale !== undefined
      ? { rationale: receipt.rationale }
      : {}),
    ...(evidenceReferences ? { evidenceReferences } : {}),
    ...(scope ? { scope } : {}),
    timestamp: requiredJsonString(receipt.timestamp, "timestamp"),
    protocolHash,
    packageHash,
    snapshotHash,
  };
}

function parseWorkflowCycle(value: unknown, label: string): WorkflowCycleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const cycle = value as Record<string, unknown>;
  const keys = new Set(["id", "key", "instanceOrdinal"]);
  const unknown = Object.keys(cycle).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const instanceOrdinal = cycle.instanceOrdinal;
  if (
    typeof instanceOrdinal !== "number" ||
    !Number.isSafeInteger(instanceOrdinal) ||
    instanceOrdinal < 1
  ) {
    throw new Error(
      `Invalid Run state: ${label}.instanceOrdinal must be a positive integer`,
    );
  }
  return {
    id: requiredJsonString(cycle.id, `${label}.id` as keyof RunStateJson),
    key: requiredJsonString(cycle.key, `${label}.key` as keyof RunStateJson),
    instanceOrdinal,
  };
}

function parseWorkflowAttempt(
  value: unknown,
  label: string,
): WorkflowAttemptState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const attempt = value as Record<string, unknown>;
  const keys = new Set([
    "id",
    "stepId",
    "cycleId",
    "visitOrdinal",
    "retryOrdinal",
  ]);
  const unknown = Object.keys(attempt).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const id = requiredJsonString(
    attempt.id,
    `${label}.id` as keyof RunStateJson,
  );
  const stepId = requiredJsonString(
    attempt.stepId,
    `${label}.stepId` as keyof RunStateJson,
  );
  const cycleId = attempt.cycleId === undefined ? null : attempt.cycleId;
  if (
    cycleId !== null &&
    (typeof cycleId !== "string" || cycleId.length === 0)
  ) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`,
    );
  }
  const visitOrdinal = attempt.visitOrdinal;
  const retryOrdinal = attempt.retryOrdinal;
  if (
    typeof visitOrdinal !== "number" ||
    !Number.isSafeInteger(visitOrdinal) ||
    visitOrdinal < 1
  ) {
    throw new Error(
      `Invalid Run state: ${label}.visitOrdinal must be a positive integer`,
    );
  }
  if (
    typeof retryOrdinal !== "number" ||
    !Number.isSafeInteger(retryOrdinal) ||
    retryOrdinal < 0
  ) {
    throw new Error(
      `Invalid Run state: ${label}.retryOrdinal must be a non-negative integer`,
    );
  }
  return {
    id,
    stepId,
    cycleId: cycleId as string | null,
    visitOrdinal,
    retryOrdinal,
  };
}

function parseWorkflowOutcome(
  value: unknown,
  label: string,
): WorkflowVisitOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const outcome = value as Record<string, unknown>;
  const keys = new Set([
    "actionId",
    "status",
    "summary",
    "retryOrdinal",
    "routing",
    "evidence",
    "artifactVersions",
  ]);
  const unknown = Object.keys(outcome).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const actionId = requiredJsonString(
    outcome.actionId,
    `${label}.actionId` as keyof RunStateJson,
  );
  const summary = requiredJsonString(
    outcome.summary,
    `${label}.summary` as keyof RunStateJson,
  );
  if (outcome.status !== "succeeded" && outcome.status !== "failed") {
    throw new Error(`Invalid Run state: ${label}.status is invalid`);
  }
  const retryOrdinal = outcome.retryOrdinal;
  if (
    typeof retryOrdinal !== "number" ||
    !Number.isSafeInteger(retryOrdinal) ||
    retryOrdinal < 0
  ) {
    throw new Error(
      `Invalid Run state: ${label}.retryOrdinal must be a non-negative integer`,
    );
  }
  return {
    actionId,
    status: outcome.status,
    summary,
    retryOrdinal,
    ...(outcome.routing !== undefined
      ? { routing: parseStringRecord(outcome.routing, `${label}.routing`) }
      : {}),
    ...(outcome.evidence !== undefined
      ? { evidence: parseJsonRecord(outcome.evidence, `${label}.evidence`) }
      : {}),
    ...(outcome.artifactVersions !== undefined
      ? {
          artifactVersions: parseStringRecord(
            outcome.artifactVersions,
            `${label}.artifactVersions`,
          ),
        }
      : {}),
  };
}

function parseWorkflowVisit(value: unknown, index: number): WorkflowVisitState {
  const label = `workflowRuntime.visits[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const visit = value as Record<string, unknown>;
  const keys = new Set([
    "attemptId",
    "stepId",
    "cycleId",
    "visitOrdinal",
    "outcomes",
  ]);
  const unknown = Object.keys(visit).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const attemptId = requiredJsonString(
    visit.attemptId,
    `${label}.attemptId` as keyof RunStateJson,
  );
  const stepId = requiredJsonString(
    visit.stepId,
    `${label}.stepId` as keyof RunStateJson,
  );
  const cycleId = visit.cycleId === undefined ? null : visit.cycleId;
  if (
    cycleId !== null &&
    (typeof cycleId !== "string" || cycleId.length === 0)
  ) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`,
    );
  }
  const visitOrdinal = visit.visitOrdinal;
  if (
    typeof visitOrdinal !== "number" ||
    !Number.isSafeInteger(visitOrdinal) ||
    visitOrdinal < 1
  ) {
    throw new Error(
      `Invalid Run state: ${label}.visitOrdinal must be a positive integer`,
    );
  }
  if (!Array.isArray(visit.outcomes)) {
    throw new Error(`Invalid Run state: ${label}.outcomes must be an array`);
  }
  return {
    attemptId,
    stepId,
    cycleId: cycleId as string | null,
    visitOrdinal,
    outcomes: visit.outcomes.map((outcome, outcomeIndex) =>
      parseWorkflowOutcome(outcome, `${label}.outcomes[${outcomeIndex}]`),
    ),
  };
}

function parseWorkflowArtifactLifetime(
  value: unknown,
  label: string,
): WorkflowArtifactLifetime {
  if (value !== "attempt" && value !== "cycle" && value !== "run") {
    throw new Error(`Invalid Run state: ${label} must be a valid lifetime`);
  }
  return value;
}

function parseWorkflowArtifactProducer(
  value: unknown,
  label: string,
): WorkflowArtifactProducer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const producer = value as Record<string, unknown>;
  const keys = new Set([
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision",
  ]);
  const unknown = Object.keys(producer).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  return parseWorkflowArtifactCoordinate(producer, label);
}

function parseWorkflowArtifactCoordinate(
  coordinate: Record<string, unknown>,
  label: string,
): WorkflowArtifactProducer {
  const cycleId = coordinate.cycleId;
  if (
    cycleId !== null &&
    (typeof cycleId !== "string" || cycleId.length === 0)
  ) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`,
    );
  }
  const revision = coordinate.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new Error(
      `Invalid Run state: ${label}.revision must be a non-negative integer`,
    );
  }
  return {
    runId: requiredJsonString(coordinate.runId, `${label}.runId`),
    nodeId: requiredJsonString(coordinate.nodeId, `${label}.nodeId`),
    cycleId: cycleId as string | null,
    attemptId: requiredJsonString(coordinate.attemptId, `${label}.attemptId`),
    actionId: requiredJsonString(coordinate.actionId, `${label}.actionId`),
    revision,
  };
}

function parseWorkflowArtifactVersion(
  value: unknown,
  index: number,
): WorkflowArtifactVersion {
  const label = `workflowRuntime.artifactVersions[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const version = value as Record<string, unknown>;
  const keys = new Set([
    "id",
    "artifactId",
    "schemaId",
    "lifetime",
    "scopeId",
    "contentHash",
    "path",
    "producer",
    "timestamp",
  ]);
  const unknown = Object.keys(version).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const contentHash = requiredJsonString(
    version.contentHash,
    `${label}.contentHash`,
  );
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error(
      `Invalid Run state: ${label}.contentHash must be a SHA-256 hash`,
    );
  }
  const artifactPath = requiredJsonString(version.path, `${label}.path`);
  assertSafeRunReference(artifactPath, `${label}.path`);
  return {
    id: requiredJsonString(version.id, `${label}.id`),
    artifactId: requiredJsonString(version.artifactId, `${label}.artifactId`),
    schemaId: requiredJsonString(version.schemaId, `${label}.schemaId`),
    lifetime: parseWorkflowArtifactLifetime(
      version.lifetime,
      `${label}.lifetime`,
    ),
    scopeId: requiredJsonString(version.scopeId, `${label}.scopeId`),
    contentHash,
    path: artifactPath,
    producer: parseWorkflowArtifactProducer(
      version.producer,
      `${label}.producer`,
    ),
    timestamp: requiredJsonString(version.timestamp, `${label}.timestamp`),
  };
}

function parseWorkflowArtifactSelection(
  value: unknown,
  index: number,
): WorkflowArtifactSelection {
  const label = `workflowRuntime.artifactSelections[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const selection = value as Record<string, unknown>;
  const keys = new Set([
    "artifactId",
    "versionId",
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision",
    "timestamp",
  ]);
  const unknown = Object.keys(selection).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const coordinate = parseWorkflowArtifactCoordinate(selection, label);
  return {
    artifactId: requiredJsonString(selection.artifactId, `${label}.artifactId`),
    versionId: requiredJsonString(selection.versionId, `${label}.versionId`),
    ...coordinate,
    timestamp: requiredJsonString(selection.timestamp, `${label}.timestamp`),
  };
}

function parseWorkflowRuntime(
  value: unknown,
  runId: string,
): WorkflowRuntimeState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Run state: workflowRuntime must be an object");
  }
  const runtime = value as Record<string, unknown>;
  const keys = new Set([
    "revision",
    "nextVisitOrdinal",
    "currentAttempt",
    "currentCycle",
    "cycles",
    "visits",
    "decisionReceipts",
    "artifactVersions",
    "artifactSelections",
  ]);
  const unknown = Object.keys(runtime).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Invalid Run state: workflowRuntime has unknown field ${unknown}`,
    );
  }
  for (const key of ["revision", "nextVisitOrdinal"] as const) {
    const entry = runtime[key];
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0
    ) {
      throw new Error(
        `Invalid Run state: workflowRuntime.${key} must be a non-negative integer`,
      );
    }
  }
  const revision = runtime.revision as number;
  const nextVisitOrdinal = runtime.nextVisitOrdinal as number;
  if (!Array.isArray(runtime.visits)) {
    throw new Error(
      "Invalid Run state: workflowRuntime.visits must be an array",
    );
  }
  const visits = runtime.visits.map(parseWorkflowVisit);
  const cycles =
    runtime.cycles === undefined
      ? []
      : Array.isArray(runtime.cycles)
        ? runtime.cycles.map((cycle, index) =>
            parseWorkflowCycle(cycle, `workflowRuntime.cycles[${index}]`),
          )
        : (() => {
            throw new Error(
              "Invalid Run state: workflowRuntime.cycles must be an array",
            );
          })();
  const cycleIds = new Set<string>();
  const cycleOrdinals = new Map<string, number>();
  for (const cycle of cycles) {
    if (cycleIds.has(cycle.id)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Cycle ${cycle.id}`,
      );
    }
    cycleIds.add(cycle.id);
    const expectedOrdinal = (cycleOrdinals.get(cycle.key) ?? 0) + 1;
    if (cycle.instanceOrdinal !== expectedOrdinal) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime Cycle ordinal is invalid for ${cycle.key}`,
      );
    }
    cycleOrdinals.set(cycle.key, cycle.instanceOrdinal);
  }
  const currentCycle =
    runtime.currentCycle === undefined || runtime.currentCycle === null
      ? null
      : parseWorkflowCycle(
          runtime.currentCycle,
          "workflowRuntime.currentCycle",
        );
  if (currentCycle && !cycleIds.has(currentCycle.id)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Cycle is not in cycles",
    );
  }
  const decisionReceipts =
    runtime.decisionReceipts === undefined
      ? []
      : Array.isArray(runtime.decisionReceipts)
        ? runtime.decisionReceipts.map(parseDecisionReceipt)
        : (() => {
            throw new Error(
              "Invalid Run state: WorkflowRuntime decisionReceipts must be an array",
            );
          })();
  const artifactVersions =
    runtime.artifactVersions === undefined
      ? []
      : Array.isArray(runtime.artifactVersions)
        ? runtime.artifactVersions.map(parseWorkflowArtifactVersion)
        : (() => {
            throw new Error(
              "Invalid Run state: WorkflowRuntime artifactVersions must be an array",
            );
          })();
  const artifactSelections =
    runtime.artifactSelections === undefined
      ? []
      : Array.isArray(runtime.artifactSelections)
        ? runtime.artifactSelections.map(parseWorkflowArtifactSelection)
        : (() => {
            throw new Error(
              "Invalid Run state: WorkflowRuntime artifactSelections must be an array",
            );
          })();
  const artifactVersionIds = new Set<string>();
  for (const version of artifactVersions) {
    if (artifactVersionIds.has(version.id)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime artifact version ${version.id}`,
      );
    }
    artifactVersionIds.add(version.id);
    if (version.producer.runId !== runId) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} belongs to another Run`,
      );
    }
    if (
      (version.lifetime === "attempt" &&
        version.scopeId !== version.producer.attemptId) ||
      (version.lifetime === "cycle" &&
        version.scopeId !== version.producer.cycleId) ||
      (version.lifetime === "run" && version.scopeId !== runId)
    ) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} has an invalid scope`,
      );
    }
    if (version.producer.revision >= revision) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} has a future revision`,
      );
    }
  }
  const artifactSelectionKeys = new Set<string>();
  for (const selection of artifactSelections) {
    const selectionKey = `${selection.attemptId}\u0000${selection.actionId}\u0000${selection.artifactId}`;
    if (artifactSelectionKeys.has(selectionKey)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime artifact selection ${selection.artifactId}`,
      );
    }
    artifactSelectionKeys.add(selectionKey);
    if (!artifactVersionIds.has(selection.versionId)) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime selection references unknown artifact version ${selection.versionId}`,
      );
    }
    const version = artifactVersions.find(
      (candidate) => candidate.id === selection.versionId,
    )!;
    if (version.artifactId !== selection.artifactId) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime artifact selection id does not match its version",
      );
    }
    if (selection.runId !== runId || selection.revision >= revision) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime artifact selection ${selection.versionId} has an invalid Run or revision`,
      );
    }
  }
  const attemptIds = new Set<string>();
  const visitOrdinals = new Set<number>();
  const receiptActionIds = new Set<string>();
  for (const receipt of decisionReceipts) {
    if (receiptActionIds.has(receipt.actionId)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Decision Receipt ${receipt.actionId}`,
      );
    }
    receiptActionIds.add(receipt.actionId);
  }
  let outcomeCount = 0;
  for (const visit of visits) {
    if (attemptIds.has(visit.attemptId)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Attempt ${visit.attemptId}`,
      );
    }
    attemptIds.add(visit.attemptId);
    if (visitOrdinals.has(visit.visitOrdinal)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime visit ordinal ${visit.visitOrdinal}`,
      );
    }
    if (visit.cycleId !== null && !cycleIds.has(visit.cycleId)) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime visit references unknown Cycle ${visit.cycleId}`,
      );
    }
    visitOrdinals.add(visit.visitOrdinal);
    outcomeCount += visit.outcomes.length;
    if (visit.visitOrdinal > nextVisitOrdinal) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime visit ordinal exceeds its counter",
      );
    }
  }
  const currentAttempt =
    runtime.currentAttempt === null
      ? null
      : parseWorkflowAttempt(
          runtime.currentAttempt,
          "workflowRuntime.currentAttempt",
        );
  if (currentAttempt && !attemptIds.has(currentAttempt.id)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Attempt is not in visits",
    );
  }
  if (currentAttempt && currentAttempt.cycleId !== (currentCycle?.id ?? null)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Attempt does not match current Cycle",
    );
  }
  if (revision !== outcomeCount) {
    throw new Error(
      "Invalid Run state: WorkflowRuntime revision does not match visit outcomes",
    );
  }
  if (currentAttempt) {
    const currentVisit = visits.find(
      (visit) => visit.attemptId === currentAttempt.id,
    )!;
    if (
      currentVisit.stepId !== currentAttempt.stepId ||
      currentVisit.cycleId !== currentAttempt.cycleId ||
      currentVisit.visitOrdinal !== currentAttempt.visitOrdinal
    ) {
      throw new Error(
        "Invalid Run state: current WorkflowRuntime Attempt does not match its visit",
      );
    }
    const lastOutcome = currentVisit.outcomes.at(-1);
    const expectedRetryOrdinal = lastOutcome ? lastOutcome.retryOrdinal + 1 : 0;
    if (currentAttempt.retryOrdinal !== expectedRetryOrdinal) {
      throw new Error(
        "Invalid Run state: current WorkflowRuntime retry ordinal is invalid",
      );
    }
  }
  return {
    revision,
    nextVisitOrdinal,
    currentAttempt,
    currentCycle,
    cycles,
    visits,
    decisionReceipts,
    artifactVersions,
    artifactSelections,
  };
}

function parseRunStateJson(value: unknown): RunStateJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Run state: stored value must be an object");
  }
  const json = value as Record<string, unknown>;
  const unknown = Object.keys(json).find(
    (key) => !RUN_STATE_JSON_KEYS.has(key as keyof RunStateJson),
  );
  if (unknown) throw new Error(`Invalid Run state: unknown field ${unknown}`);
  const runId = requiredJsonString(json.runId, "runId");
  const skill = requiredJsonString(json.skill, "skill");
  const skillVersion = requiredJsonString(json.skillVersion, "skillVersion");
  const skillHash = requiredJsonString(json.skillHash, "skillHash");
  if (
    json.orchestration !== "deterministic" &&
    json.orchestration !== "adaptive"
  ) {
    throw new Error(
      "Invalid Run state: orchestration must be deterministic or adaptive",
    );
  }
  const currentStep = nullableJsonString(json.currentStep, "currentStep");
  const iteration = json.iteration;
  if (
    typeof iteration !== "number" ||
    !Number.isSafeInteger(iteration) ||
    iteration < 0
  ) {
    throw new Error(
      "Invalid Run state: iteration must be a non-negative integer",
    );
  }
  const pending = nullableJsonString(json.pending, "pending");
  const pendingRef = requiredJsonString(json.pendingRef, "pendingRef");
  const trajectoryRef = requiredJsonString(json.trajectoryRef, "trajectoryRef");
  const contextRef = requiredJsonString(json.contextRef, "contextRef");
  const artifactsRef = requiredJsonString(json.artifactsRef, "artifactsRef");
  const checkpointRef = requiredJsonString(json.checkpointRef, "checkpointRef");
  assertSafeRunReference(pendingRef, "pending_ref");
  assertSafeRunReference(trajectoryRef, "trajectory_ref");
  assertSafeRunReference(contextRef, "context_ref");
  assertSafeRunReference(artifactsRef, "artifacts_ref");
  assertSafeRunReference(checkpointRef, "checkpoint_ref");
  if (
    json.status !== "running" &&
    json.status !== "waiting" &&
    json.status !== "completed" &&
    json.status !== "failed"
  ) {
    throw new Error("Invalid Run state: run_status is invalid");
  }
  if (
    !json.retries ||
    typeof json.retries !== "object" ||
    Array.isArray(json.retries)
  ) {
    throw new Error("Invalid Run state: run_retries must be a JSON object");
  }
  for (const count of Object.values(json.retries)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        "Invalid Run state: retry counts must be non-negative integers",
      );
    }
  }

  let runtimeIdentity: RuntimeIdentity | undefined;
  if (json.runtimeIdentity !== undefined) {
    if (
      !json.runtimeIdentity ||
      typeof json.runtimeIdentity !== "object" ||
      Array.isArray(json.runtimeIdentity)
    ) {
      throw new Error("Invalid Run state: runtimeIdentity must be an object");
    }
    const identity = json.runtimeIdentity as Record<string, unknown>;
    const identityKeys = new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
    ]);
    const unknownIdentityKey = Object.keys(identity).find(
      (key) => !identityKeys.has(key),
    );
    if (unknownIdentityKey) {
      throw new Error(
        `Invalid Run state: runtimeIdentity unknown field ${unknownIdentityKey}`,
      );
    }
    if (
      typeof identity.protocolHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity.protocolHash) ||
      typeof identity.packageHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity.packageHash) ||
      typeof identity.snapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity.snapshotHash) ||
      !identity.nodeToStep ||
      typeof identity.nodeToStep !== "object" ||
      Array.isArray(identity.nodeToStep) ||
      (identity.capabilityVersion !== undefined &&
        identity.capabilityVersion !== 3) ||
      (identity.resolverHash !== undefined &&
        (typeof identity.resolverHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(identity.resolverHash)))
    ) {
      throw new Error("Invalid Run state: runtimeIdentity is invalid");
    }
    for (const [nodeId, stepId] of Object.entries(identity.nodeToStep)) {
      if (!nodeId || typeof stepId !== "string" || !stepId) {
        throw new Error(
          "Invalid Run state: runtimeIdentity mapping is invalid",
        );
      }
    }
    runtimeIdentity = {
      protocolHash: identity.protocolHash,
      packageHash: identity.packageHash,
      snapshotHash: identity.snapshotHash,
      nodeToStep: Object.fromEntries(
        Object.entries(identity.nodeToStep).map(([nodeId, stepId]) => [
          nodeId,
          stepId as string,
        ]),
      ),
      ...(identity.capabilityVersion === 3
        ? { capabilityVersion: 3 as const }
        : {}),
      ...(typeof identity.resolverHash === "string"
        ? { resolverHash: identity.resolverHash }
        : {}),
    };
  }

  const workflowRuntime = parseWorkflowRuntime(json.workflowRuntime, runId);

  return {
    runId,
    skill,
    skillVersion,
    skillHash,
    orchestration: json.orchestration,
    currentStep,
    iteration,
    pending,
    pendingRef,
    trajectoryRef,
    contextRef,
    artifactsRef,
    checkpointRef,
    status: json.status,
    retries: json.retries as Record<string, number>,
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    ...(workflowRuntime ? { workflowRuntime } : {}),
  };
}

export function parseRunStateValue(value: unknown): RunState {
  return parseRunStateJson(value);
}

export function serializeRunState(state: RunState): string {
  return JSON.stringify(parseRunStateJson(state), null, 2);
}

export async function readRunState(
  changeDir: string,
  options: EngineRunReadOptions = {},
): Promise<RunState | null> {
  const raw = await readOptionalEngineRunText(
    changeDir,
    RUN_STATE_FILE,
    RUN_STATE_MAX_BYTES,
    "Run state",
    options,
  );
  if (raw === null) return null;
  return parseRunStateValue(JSON.parse(raw) as unknown);
}

export async function writeRunState(
  changeDir: string,
  state: RunState,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const serialized = serializeRunState(state);
  await writeEngineRunText(
    changeDir,
    RUN_STATE_FILE,
    serialized,
    RUN_STATE_MAX_BYTES,
    "Run state",
    options,
  );
}

export async function removeRunState(
  changeDir: string,
  options: EngineRunRemoveOptions = {},
): Promise<void> {
  await removeEngineRunFile(changeDir, RUN_STATE_FILE, "Run state", options);
}
