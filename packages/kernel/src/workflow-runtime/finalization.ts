import { promises as fs } from "node:fs";
import path from "node:path";

import {
  atomicWriteContainedText,
  moveContainedFile,
  removeContainedFile,
} from "../engine/contained-atomic-write.js";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
} from "../engine/protected-run-file.js";
import type { RuntimeIdentity, RunState } from "../engine/types.js";
import type {
  WorkflowDurabilityProfile,
  WorkflowFinalizationConfirmationPolicy,
  WorkflowFinalizationDefinition,
  WorkflowFinalizationCleanup,
  WorkflowFinalizationCleanupEntry,
  WorkflowFinalizationMaterialIdentity,
  WorkflowFinalizationOperation,
  WorkflowFinalizationPlannedOperation,
  WorkflowFinalizationPreview,
  WorkflowFinalizationPendingConfirmation,
  WorkflowFinalizationConfirmationRecord,
  WorkflowFinalizationOperationReceipt,
  WorkflowFinalizationReceipt,
  WorkflowFinalizationReceiptReference,
  WorkflowFinalizationRoot,
  WorkflowFinalizationState,
} from "../types.js";
import { sha256, stableValue } from "../util.js";
import { parseExecutionIdentity } from "./revision-claim.js";

export const WORKFLOW_FINALIZATION_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_FINALIZATION_TRANSACTION_PATH =
  ".badger/finalization/transaction.json";
export const WORKFLOW_FINALIZATION_RECEIPT_DIRECTORY =
  ".badger/finalization/receipts";
export const WORKFLOW_FINALIZATION_MAX_OPERATIONS = 256;
export const WORKFLOW_FINALIZATION_MAX_EVENTS = 1_024;
export const WORKFLOW_FINALIZATION_MAX_TEXT_BYTES = 64 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_IDENTIFIER_LENGTH = 256;
const PROTECTED_RUNTIME_DIRECTORY = ".badger";

export type WorkflowFinalizationBoundaryPhase =
  | "prepared"
  | "applying"
  | "before-staging"
  | "staged"
  | "before-operation"
  | "after-operation"
  | "before-target-removal"
  | "target-removed"
  | "before-quarantine"
  | "quarantined"
  | "before-source-removal"
  | "source-removed"
  | "before-target-publication"
  | "target-published"
  | "operation-verified"
  | "committing"
  | "committed"
  | "before-receipt"
  | "receipt-written"
  | "rolling-back"
  | "before-rollback-operation"
  | "rollback-verified"
  | "before-cleanup"
  | "cleanup-item"
  | "cleaned"
  | "rolled-back"
  | "cleared";

export const WORKFLOW_FINALIZATION_BOUNDARY_PHASES: readonly WorkflowFinalizationBoundaryPhase[] =
  [
    "prepared",
    "applying",
    "before-staging",
    "staged",
    "before-operation",
    "after-operation",
    "before-target-removal",
    "target-removed",
    "before-quarantine",
    "quarantined",
    "before-source-removal",
    "source-removed",
    "before-target-publication",
    "target-published",
    "operation-verified",
    "committing",
    "committed",
    "before-receipt",
    "receipt-written",
    "rolling-back",
    "before-rollback-operation",
    "rollback-verified",
    "before-cleanup",
    "cleanup-item",
    "cleaned",
    "rolled-back",
    "cleared",
  ];

export interface WorkflowFinalizationBoundary {
  phase: WorkflowFinalizationBoundaryPhase;
  operationId?: string;
  path?: string;
}

export type WorkflowFinalizationFault = (
  boundary: WorkflowFinalizationBoundary,
) => void | Promise<void>;

export interface WorkflowFinalizationFaultSelector {
  phase: WorkflowFinalizationBoundaryPhase;
  operationId?: string;
  path?: string;
}

let configuredFault: WorkflowFinalizationFault | undefined;

class WorkflowFinalizationInjectedFaultError extends Error {
  constructor() {
    super("deterministic workflow finalization fault");
    this.name = "WorkflowFinalizationInjectedFaultError";
  }
}

export function setWorkflowFinalizationFaultForTests(
  selectorOrFault:
    WorkflowFinalizationFaultSelector | WorkflowFinalizationFault,
): void {
  if (typeof selectorOrFault === "function") {
    configuredFault = selectorOrFault;
    return;
  }
  configuredFault = (boundary) => {
    if (
      boundary.phase === selectorOrFault.phase &&
      (selectorOrFault.operationId === undefined ||
        boundary.operationId === selectorOrFault.operationId) &&
      (selectorOrFault.path === undefined ||
        boundary.path === selectorOrFault.path)
    ) {
      throw new WorkflowFinalizationInjectedFaultError();
    }
  };
}

export function clearWorkflowFinalizationFaultForTests(): void {
  configuredFault = undefined;
}

async function invokeFault(
  boundary: WorkflowFinalizationBoundary,
): Promise<void> {
  const configured =
    process.env.BADGER_WORKFLOW_TEST_FINALIZATION_FAULT_BOUNDARY;
  const qualified = boundary.operationId
    ? `${boundary.phase}:${boundary.operationId}`
    : boundary.phase;
  if (configured === boundary.phase || configured === qualified) {
    throw new WorkflowFinalizationInjectedFaultError();
  }
  await configuredFault?.(boundary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function boundedContent(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > WORKFLOW_FINALIZATION_MAX_TEXT_BYTES
  ) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const result = boundedText(value, label);
  if (!SAFE_ID_PATTERN.test(result)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  return result;
}

function boundedHash(value: unknown, label: string): string {
  const result = boundedText(value, label);
  if (!HASH_PATTERN.test(result))
    throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}

function nullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  return boundedHash(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizePath(
  value: unknown,
  label: string,
  allowDot = false,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (allowDot && (normalized === "." || normalized === "")) return "";
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^(?:~|[\\/]|[A-Za-z]:)/u.test(normalized)
  ) {
    throw new Error(`${label} must be relative`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    /[*?]/u.test(normalized)
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return segments.join("/");
}

function parseFinalizationRoot(
  value: unknown,
  index: number,
): WorkflowFinalizationRoot {
  const label = `Workflow finalization root ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["id", "path"]), label);
  const root = {
    id: safeId(value.id, `${label} id`),
    path: normalizePath(value.path, `${label} path`, true),
  };
  if (isProtectedRuntimePath(root.path)) {
    throw new Error(`${label} cannot target the protected runtime directory`);
  }
  return root;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${label} must be a bounded array`);
  }
  const values = value.map((item) => boundedText(item, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeReviewer(value: unknown): {
  subjects: string[];
  authorities: string[];
} {
  if (value === undefined) return { subjects: [], authorities: [] };
  if (!isRecord(value))
    throw new Error("Finalization reviewer must be an object");
  assertKnownFields(
    value,
    new Set(["subjects", "authorities"]),
    "Finalization reviewer",
  );
  return {
    subjects: normalizeStringList(
      value.subjects ?? [],
      "Finalization reviewer subjects",
    ),
    authorities: normalizeStringList(
      value.authorities ?? [],
      "Finalization reviewer authorities",
    ),
  };
}

function normalizeConfirmation(
  value: unknown,
): WorkflowFinalizationConfirmationPolicy {
  if (value === undefined) {
    return {
      required: true,
      reviewer: { subjects: [], authorities: [] },
      rationale: { required: false },
    };
  }
  if (!isRecord(value)) {
    throw new Error("Finalization confirmation must be an object");
  }
  assertKnownFields(
    value,
    new Set(["required", "reviewer", "rationale"]),
    "Finalization confirmation",
  );
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error("Finalization confirmation required must be boolean");
  }
  if (value.required === false) {
    throw new Error(
      "Finalization confirmation is required for every local write effect",
    );
  }
  let rationale = { required: false };
  if (value.rationale !== undefined) {
    if (!isRecord(value.rationale)) {
      throw new Error("Finalization confirmation rationale must be an object");
    }
    assertKnownFields(
      value.rationale,
      new Set(["required"]),
      "Finalization confirmation rationale",
    );
    if (typeof value.rationale.required !== "boolean") {
      throw new Error(
        "Finalization confirmation rationale required must be boolean",
      );
    }
    rationale = { required: value.rationale.required };
  }
  return {
    required: true,
    reviewer: normalizeReviewer(value.reviewer),
    rationale,
  };
}

function normalizeOperation(
  value: unknown,
  index: number,
  roots: ReadonlySet<string>,
): WorkflowFinalizationOperation {
  const label = `Finalization operation ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (typeof value.kind !== "string")
    throw new Error(`${label} kind is required`);
  const kind = value.kind;
  if (kind === "write") {
    assertKnownFields(
      value,
      new Set([
        "id",
        "kind",
        "root",
        "target",
        "content",
        "requiresConfirmation",
      ]),
      label,
    );
    if (
      value.requiresConfirmation !== undefined &&
      typeof value.requiresConfirmation !== "boolean"
    ) {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation = {
      id: safeId(value.id, `${label} id`),
      kind: "write" as const,
      root: safeId(value.root, `${label} root`),
      target: normalizePath(value.target, `${label} target`),
      content: boundedContent(value.content, `${label} content`),
      ...(value.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: value.requiresConfirmation }),
    };
    if (!roots.has(operation.root))
      throw new Error(`${label} root is not declared`);
    return operation;
  }
  if (kind === "remove") {
    assertKnownFields(
      value,
      new Set(["id", "kind", "root", "target", "requiresConfirmation"]),
      label,
    );
    if (
      value.requiresConfirmation !== undefined &&
      typeof value.requiresConfirmation !== "boolean"
    ) {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation = {
      id: safeId(value.id, `${label} id`),
      kind: "remove" as const,
      root: safeId(value.root, `${label} root`),
      target: normalizePath(value.target, `${label} target`),
      ...(value.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: value.requiresConfirmation }),
    };
    if (!roots.has(operation.root))
      throw new Error(`${label} root is not declared`);
    return operation;
  }
  if (kind === "move") {
    assertKnownFields(
      value,
      new Set([
        "id",
        "kind",
        "root",
        "source",
        "target",
        "requiresConfirmation",
      ]),
      label,
    );
    if (
      value.requiresConfirmation !== undefined &&
      typeof value.requiresConfirmation !== "boolean"
    ) {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation = {
      id: safeId(value.id, `${label} id`),
      kind: "move" as const,
      root: safeId(value.root, `${label} root`),
      source: normalizePath(value.source, `${label} source`),
      target: normalizePath(value.target, `${label} target`),
      ...(value.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: value.requiresConfirmation }),
    };
    if (!roots.has(operation.root))
      throw new Error(`${label} root is not declared`);
    if (operation.source === operation.target) {
      throw new Error(`${label} source and target must differ`);
    }
    return operation;
  }
  throw new Error(`${label} kind is not registered: ${kind}`);
}

export function normalizeWorkflowFinalizationDefinition(
  value: WorkflowFinalizationDefinition,
): WorkflowFinalizationDefinition {
  if (!isRecord(value))
    throw new Error("Workflow finalization must be an object");
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "roots",
      "operations",
      "confirmation",
      "requiredVerificationReceiptIds",
      "requireContentSnapshot",
    ]),
    "Workflow finalization",
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION) {
    throw new Error("Workflow finalization schema version is unsupported");
  }
  if (
    !Array.isArray(value.roots) ||
    value.roots.length === 0 ||
    value.roots.length > 256
  ) {
    throw new Error("Workflow finalization roots are outside their bound");
  }
  const roots = value.roots.map((entry, index) => {
    return parseFinalizationRoot(entry, index);
  });
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error("Workflow finalization root ids must be unique");
  }
  const rootIds = new Set(roots.map((root) => root.id));
  if (
    roots.some((left, leftIndex) =>
      roots.some(
        (right, rightIndex) =>
          leftIndex !== rightIndex &&
          (left.path === right.path ||
            (left.path.length === 0 && right.path.length > 0) ||
            (right.path.length === 0 && left.path.length > 0) ||
            (left.path.length > 0 && right.path.startsWith(`${left.path}/`)) ||
            (right.path.length > 0 && left.path.startsWith(`${right.path}/`))),
      ),
    )
  ) {
    throw new Error("Workflow finalization roots must not overlap");
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS
  ) {
    throw new Error("Workflow finalization operations are outside their bound");
  }
  const operations = value.operations.map((entry, index) =>
    normalizeOperation(entry, index, rootIds),
  );
  if (
    new Set(operations.map((operation) => operation.id)).size !==
    operations.length
  ) {
    throw new Error("Workflow finalization operation ids must be unique");
  }
  const paths = operations.flatMap((operation) => {
    const root = roots.find((candidate) => candidate.id === operation.root)!;
    return [
      `${root.path}${root.path ? "/" : ""}${operation.target}`,
      ...(operation.kind === "move"
        ? [`${root.path}${root.path ? "/" : ""}${operation.source}`]
        : []),
    ];
  });
  if (paths.some(isProtectedRuntimePath)) {
    throw new Error(
      "Workflow finalization cannot target the protected runtime directory",
    );
  }
  if (
    paths.some((value, index) =>
      paths.some(
        (candidate, candidateIndex) =>
          index !== candidateIndex &&
          (value === candidate ||
            value.startsWith(`${candidate}/`) ||
            candidate.startsWith(`${value}/`)),
      ),
    )
  ) {
    throw new Error("Workflow finalization operation paths must not overlap");
  }
  if (
    value.requiredVerificationReceiptIds !== undefined &&
    (!Array.isArray(value.requiredVerificationReceiptIds) ||
      value.requiredVerificationReceiptIds.length > 256)
  ) {
    throw new Error(
      "Workflow finalization receipt requirements are outside their bound",
    );
  }
  const requiredVerificationReceiptIds = [
    ...new Set(
      (value.requiredVerificationReceiptIds ?? []).map((entry) =>
        boundedText(entry, "Workflow finalization verification receipt id"),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (
    value.requireContentSnapshot !== undefined &&
    typeof value.requireContentSnapshot !== "boolean"
  ) {
    throw new Error(
      "Workflow finalization requireContentSnapshot must be boolean",
    );
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    roots,
    operations,
    confirmation: normalizeConfirmation(value.confirmation),
    ...(requiredVerificationReceiptIds.length > 0
      ? { requiredVerificationReceiptIds }
      : {}),
    ...(value.requireContentSnapshot === true
      ? { requireContentSnapshot: true }
      : {}),
  };
}

export function validateWorkflowFinalizationDefinition(
  value: WorkflowFinalizationDefinition,
): void {
  normalizeWorkflowFinalizationDefinition(value);
}

function parseReviewerPolicy(
  value: unknown,
  label: string,
): {
  subjects: string[];
  authorities: string[];
} {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["subjects", "authorities"]), label);
  return {
    subjects: normalizeStringList(value.subjects, `${label}.subjects`),
    authorities: normalizeStringList(value.authorities, `${label}.authorities`),
  };
}

function parseRationalePolicy(
  value: unknown,
  label: string,
): { required: boolean } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["required"]), label);
  if (typeof value.required !== "boolean") {
    throw new Error(`${label}.required must be boolean`);
  }
  return { required: value.required };
}

export function parseWorkflowFinalizationPendingConfirmation(
  value: unknown,
): WorkflowFinalizationPendingConfirmation {
  const label = "Workflow finalization pending confirmation";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "decisionId",
      "actionId",
      "sourceActionId",
      "planHash",
      "revision",
      "planRevision",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "reviewer",
      "rationale",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
    value.kind !== "workflow-finalization-confirmation"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (
    !Array.isArray(value.verificationReceiptIds) ||
    value.verificationReceiptIds.length > 256
  ) {
    throw new Error(`${label} verificationReceiptIds are invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map((entry) =>
    boundedText(entry, `${label} verificationReceiptIds`),
  );
  if (new Set(verificationReceiptIds).size !== verificationReceiptIds.length) {
    throw new Error(
      `${label} verificationReceiptIds must not contain duplicates`,
    );
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-confirmation",
    decisionId: safeId(value.decisionId, `${label} decisionId`),
    actionId: safeId(value.actionId, `${label} actionId`),
    sourceActionId: safeId(value.sourceActionId, `${label} sourceActionId`),
    planHash: boundedHash(value.planHash, `${label} planHash`),
    revision: nonNegativeInteger(value.revision, `${label} revision`),
    planRevision: nonNegativeInteger(
      value.planRevision,
      `${label} planRevision`,
    ),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label} contentSnapshotHash`,
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    reviewer: parseReviewerPolicy(value.reviewer, `${label} reviewer`),
    rationale: parseRationalePolicy(value.rationale, `${label} rationale`),
  };
}

export function parseWorkflowFinalizationReceiptReference(
  value: unknown,
): WorkflowFinalizationReceiptReference {
  const label = "Workflow finalization receipt reference";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "receiptId",
      "receiptHash",
      "transactionId",
      "planHash",
      "runId",
      "revision",
      "resultingRevision",
      "status",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
    value.kind !== "workflow-finalization-receipt-reference"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (value.status !== "committed" && value.status !== "rolled-back") {
    throw new Error(`${label} status is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt-reference",
    receiptId: safeId(value.receiptId, `${label} receiptId`),
    receiptHash: boundedHash(value.receiptHash, `${label} receiptHash`),
    transactionId: safeId(value.transactionId, `${label} transactionId`),
    planHash: boundedHash(value.planHash, `${label} planHash`),
    runId: boundedText(value.runId, `${label} runId`),
    revision: nonNegativeInteger(value.revision, `${label} revision`),
    resultingRevision: nonNegativeInteger(
      value.resultingRevision,
      `${label} resultingRevision`,
    ),
    status: value.status,
  };
}

export function parseWorkflowFinalizationState(
  value: unknown,
  profile?: WorkflowDurabilityProfile,
): WorkflowFinalizationState {
  const label = "Workflow finalization state";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "status",
      "planHash",
      "revision",
      "sourceActionId",
      "planRevision",
      "pendingConfirmation",
      "confirmationActionId",
      "confirmationCount",
      "transactionId",
      "receipt",
    ]),
    label,
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION) {
    throw new Error(`${label} schema version is unsupported`);
  }
  const statuses = new Set([
    "awaiting-confirmation",
    "applying",
    "committed",
    "rolling-back",
    "rolled-back",
    "blocked",
  ]);
  if (typeof value.status !== "string" || !statuses.has(value.status)) {
    throw new Error(`${label} status is invalid`);
  }
  const pendingConfirmation =
    value.pendingConfirmation === undefined
      ? undefined
      : parseWorkflowFinalizationPendingConfirmation(value.pendingConfirmation);
  const receipt =
    value.receipt === undefined
      ? undefined
      : parseWorkflowFinalizationReceiptReference(value.receipt);
  const transactionId =
    value.transactionId === undefined
      ? undefined
      : safeId(value.transactionId, `${label} transactionId`);
  if (value.status === "awaiting-confirmation" && !pendingConfirmation) {
    throw new Error(
      `${label} awaiting-confirmation state is missing its action`,
    );
  }
  const revision = nonNegativeInteger(value.revision, `${label} revision`);
  const planRevision = nonNegativeInteger(
    value.planRevision,
    `${label} planRevision`,
  );
  if (planRevision > revision) {
    throw new Error(`${label} plan revision is newer than Run revision`);
  }
  if (
    pendingConfirmation &&
    (pendingConfirmation.planRevision !== planRevision ||
      pendingConfirmation.planHash !== value.planHash ||
      pendingConfirmation.sourceActionId !== value.sourceActionId)
  ) {
    throw new Error(`${label} pending confirmation identity is invalid`);
  }
  if (pendingConfirmation && pendingConfirmation.revision !== revision) {
    throw new Error(`${label} pending confirmation revision is invalid`);
  }
  if (value.status !== "awaiting-confirmation" && pendingConfirmation) {
    throw new Error(`${label} has an unexpected pending confirmation`);
  }
  if (
    value.confirmationActionId !== undefined &&
    value.status === "awaiting-confirmation"
  ) {
    if (value.confirmationCount === undefined) {
      throw new Error(`${label} confirmation count is missing`);
    }
  }
  const confirmationCount =
    value.confirmationCount === undefined
      ? value.confirmationActionId === undefined
        ? 0
        : 1
      : nonNegativeInteger(
          value.confirmationCount,
          `${label} confirmationCount`,
        );
  if (
    (confirmationCount === 0 && value.confirmationActionId !== undefined) ||
    (confirmationCount > 0 && value.confirmationActionId === undefined)
  ) {
    throw new Error(`${label} confirmation identity is invalid`);
  }
  if (value.status === "committed" && !receipt) {
    throw new Error(`${label} terminal state is missing its receipt`);
  }
  if (
    value.status === "rolled-back" &&
    transactionId !== undefined &&
    !receipt
  ) {
    throw new Error(`${label} terminal state is missing its receipt`);
  }
  if (
    receipt &&
    value.status !== "committed" &&
    value.status !== "rolled-back"
  ) {
    throw new Error(`${label} has a receipt in an in-progress state`);
  }
  if (receipt && !transactionId) {
    throw new Error(`${label} receipt is missing its transaction id`);
  }
  if (receipt && transactionId !== receipt.transactionId) {
    throw new Error(`${label} receipt transaction identity is invalid`);
  }
  if (
    receipt &&
    ((value.status === "committed" && receipt.status !== "committed") ||
      (value.status === "rolled-back" && receipt.status !== "rolled-back"))
  ) {
    throw new Error(`${label} receipt status does not match its state`);
  }
  const state: WorkflowFinalizationState = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    status: value.status as WorkflowFinalizationState["status"],
    planHash: boundedHash(value.planHash, `${label} planHash`),
    revision,
    sourceActionId: safeId(value.sourceActionId, `${label} sourceActionId`),
    planRevision,
    ...(pendingConfirmation ? { pendingConfirmation } : {}),
    ...(value.confirmationActionId !== undefined
      ? {
          confirmationActionId: safeId(
            value.confirmationActionId,
            `${label} confirmationActionId`,
          ),
        }
      : {}),
    ...(confirmationCount > 0 ? { confirmationCount } : {}),
    ...(transactionId !== undefined ? { transactionId } : {}),
    ...(receipt ? { receipt } : {}),
  };
  const maxBytes = profile?.bounds.finalizationPlanBytes;
  if (
    maxBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(state), "utf8") > maxBytes
  ) {
    throw new Error(`${label} exceeds its configured bound`);
  }
  return state;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function joinRelative(root: string, child: string): string {
  return root.length > 0 ? `${root}/${child}` : child;
}

function isRelativePathWithin(root: string, candidate: string): boolean {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function isProtectedRuntimePath(relative: string): boolean {
  return (
    relative === PROTECTED_RUNTIME_DIRECTORY ||
    relative.startsWith(`${PROTECTED_RUNTIME_DIRECTORY}/`)
  );
}

function materialIdentity(
  content: string | null,
): WorkflowFinalizationMaterialIdentity {
  if (content === null) return { exists: false, bytes: 0, sha256: null };
  return {
    exists: true,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  };
}

function sameIdentity(
  left: WorkflowFinalizationMaterialIdentity,
  right: WorkflowFinalizationMaterialIdentity,
): boolean {
  return (
    left.exists === right.exists &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

async function readMaterial(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<{
  identity: WorkflowFinalizationMaterialIdentity;
  content: string | null;
}> {
  const inspection = await inspectProtectedProjectPath(root, relative, {
    label: `Workflow finalization target ${relative}`,
    expected: "any",
  });
  if (!inspection.exists)
    return { identity: materialIdentity(null), content: null };
  if (inspection.kind !== "file") {
    throw new Error(
      `Workflow finalization target is not a regular file: ${relative}`,
    );
  }
  const result = await readProtectedProjectFile(root, relative, maxBytes, {
    label: `Workflow finalization target ${relative}`,
  });
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new Error(
      `Workflow finalization target is not valid UTF-8: ${relative}`,
      {
        cause: error,
      },
    );
  }
  return { identity: materialIdentity(content), content };
}

async function assertRoot(root: string, relative: string): Promise<void> {
  if (relative === "") {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        "Workflow finalization approved root must be a real directory",
      );
    }
    return;
  }
  const inspection = await inspectProtectedProjectPath(root, relative, {
    label: `Workflow finalization approved root ${relative}`,
    expected: "directory",
  });
  if (!inspection.exists) {
    throw new Error(
      `Workflow finalization approved root is missing: ${relative}`,
    );
  }
}

function profileBound(
  profile: WorkflowDurabilityProfile,
  key:
    | "finalizationPlanBytes"
    | "finalizationTransactionBytes"
    | "finalizationReceiptBytes"
    | "finalizationContentBytes"
    | "finalizationOperationCount"
    | "finalizationEventCount",
): number {
  const value = profile.bounds[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Workflow finalization bound is missing: ${key}`);
  }
  return value;
}

function operationRequiresConfirmation(
  operation: WorkflowFinalizationOperation,
  confirmation: WorkflowFinalizationConfirmationPolicy,
): boolean {
  return (
    confirmation.required === true ||
    operation.requiresConfirmation === true ||
    operation.kind === "remove" ||
    operation.kind === "move"
  );
}

function identityForOperation(
  operation: WorkflowFinalizationOperation,
  rootPath: string,
  materialsByPath: Map<
    string,
    { identity: WorkflowFinalizationMaterialIdentity; content: string | null }
  >,
): WorkflowFinalizationPlannedOperation {
  const targetPath = joinRelative(rootPath, operation.target);
  const target = materialsByPath.get(targetPath);
  if (!target)
    throw new Error(
      `Workflow finalization target was not inspected: ${targetPath}`,
    );
  const sourcePath =
    operation.kind === "move" ? joinRelative(rootPath, operation.source) : null;
  const source = sourcePath ? materialsByPath.get(sourcePath) : undefined;
  if (sourcePath && !source) {
    throw new Error(
      `Workflow finalization source was not inspected: ${sourcePath}`,
    );
  }
  if (operation.kind === "move" && !source?.identity.exists) {
    throw new Error(
      `Workflow finalization move source is missing: ${sourcePath}`,
    );
  }
  const expectedTarget =
    operation.kind === "write"
      ? materialIdentity(operation.content)
      : operation.kind === "remove"
        ? materialIdentity(null)
        : source!.identity;
  const expectedSource =
    operation.kind === "move" ? materialIdentity(null) : null;
  return {
    id: operation.id,
    kind: operation.kind,
    rootId: operation.root,
    source: sourcePath,
    target: targetPath,
    stagedPath: null,
    backupPath: target.identity.exists ? null : null,
    quarantinePath: null,
    precondition: {
      source: source?.identity ?? null,
      target: target.identity,
    },
    expectedPostState: {
      source: expectedSource,
      target: expectedTarget,
    },
    contentHash:
      operation.kind === "write"
        ? sha256(operation.content)
        : operation.kind === "move"
          ? source!.identity.sha256
          : null,
    contentBytes:
      operation.kind === "write"
        ? Buffer.byteLength(operation.content, "utf8")
        : operation.kind === "move"
          ? source!.identity.bytes
          : 0,
    requiresConfirmation: operationRequiresConfirmation(operation, {
      required: false,
      reviewer: { subjects: [], authorities: [] },
      rationale: { required: false },
    }),
  };
}

export async function buildWorkflowFinalizationPreview(options: {
  baseRoot: string;
  state: RunState;
  execution: RuntimeIdentity;
  definition: WorkflowFinalizationDefinition;
  profile: WorkflowDurabilityProfile;
}): Promise<WorkflowFinalizationPreview> {
  const definition = normalizeWorkflowFinalizationDefinition(
    options.definition,
  );
  const operationBound = profileBound(
    options.profile,
    "finalizationOperationCount",
  );
  if (definition.operations.length > operationBound) {
    throw new Error(
      "Workflow finalization operation count exceeds its configured bound",
    );
  }
  const contentBound = profileBound(
    options.profile,
    "finalizationContentBytes",
  );
  for (const operation of definition.operations) {
    if (
      operation.kind === "write" &&
      Buffer.byteLength(operation.content, "utf8") > contentBound
    ) {
      throw new Error(
        "Workflow finalization write content exceeds its configured bound",
      );
    }
  }
  const currentSnapshots =
    options.state.workflowRuntime?.contentSnapshots ?? [];
  const contentSnapshotHash = currentSnapshots.at(-1)?.hash ?? null;
  const finalizationState = options.state.workflowRuntime?.finalization;
  const planRevision =
    finalizationState?.planRevision ??
    finalizationState?.pendingConfirmation?.planRevision ??
    options.state.workflowRuntime?.revision ??
    0;
  const planActionId =
    finalizationState?.pendingConfirmation?.sourceActionId ??
    options.state.pending ??
    null;
  if (definition.requireContentSnapshot && contentSnapshotHash === null) {
    throw new Error("Workflow finalization requires a content snapshot");
  }
  const currentReceipts = new Map(
    (options.state.workflowRuntime?.verificationReceipts ?? []).map(
      (receipt) => [receipt.receiptId, receipt],
    ),
  );
  const verificationReceiptIds = [
    ...(definition.requiredVerificationReceiptIds ?? []),
  ];
  for (const receiptId of verificationReceiptIds) {
    if (!currentReceipts.has(receiptId)) {
      throw new Error(
        `Workflow finalization verification receipt is missing: ${receiptId}`,
      );
    }
    if (currentReceipts.get(receiptId)?.status !== "passed") {
      throw new Error(
        `Workflow finalization verification receipt is not passed: ${receiptId}`,
      );
    }
  }
  const materialsByPath = new Map<
    string,
    { identity: WorkflowFinalizationMaterialIdentity; content: string | null }
  >();
  const roots = new Map(definition.roots.map((root) => [root.id, root.path]));
  for (const root of definition.roots) {
    await assertRoot(options.baseRoot, root.path);
  }
  for (const operation of definition.operations) {
    const rootPath = roots.get(operation.root)!;
    const paths = [
      joinRelative(rootPath, operation.target),
      ...(operation.kind === "move"
        ? [joinRelative(rootPath, operation.source)]
        : []),
    ];
    for (const relative of paths) {
      if (materialsByPath.has(relative)) continue;
      const material = await readMaterial(
        options.baseRoot,
        relative,
        contentBound,
      );
      materialsByPath.set(relative, material);
    }
  }
  const baseOperations = definition.operations.map((operation) => {
    const rootPath = roots.get(operation.root)!;
    return identityForOperation(operation, rootPath, materialsByPath);
  });
  const seed = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    runId: options.state.runId,
    revision: planRevision,
    actionId: planActionId,
    roots: structuredClone(definition.roots),
    execution: structuredClone(options.execution),
    contentSnapshotHash,
    verificationReceiptIds: [...verificationReceiptIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    operations: baseOperations,
  };
  const transactionId = `workflow-finalization-${sha256(
    JSON.stringify(stableValue(seed)),
  ).slice(0, 32)}`;
  const confirmation = normalizeConfirmation(definition.confirmation);
  const operations = baseOperations.map((operation) => {
    const rootPath = roots.get(operation.rootId)!;
    const prefix = `${joinRelative(rootPath, ".badger/finalization")}/${transactionId}`;
    const backupPath =
      operation.precondition.target.exists &&
      (operation.kind === "write" || operation.kind === "move")
        ? `${prefix}/${operation.id}.backup`
        : null;
    const stagedPath =
      operation.kind === "write" ? `${prefix}/${operation.id}.stage` : null;
    const quarantinePath =
      (operation.kind === "remove" && operation.precondition.target.exists) ||
      (operation.kind === "move" && operation.precondition.source?.exists)
        ? `${prefix}/${operation.id}.quarantine`
        : null;
    const declaration = definition.operations.find(
      (candidate) => candidate.id === operation.id,
    )!;
    return {
      ...operation,
      stagedPath,
      backupPath,
      quarantinePath,
      requiresConfirmation: operationRequiresConfirmation(
        declaration,
        confirmation,
      ),
    };
  });
  const requiresConfirmation = operations.some((operation) =>
    operationRequiresConfirmation(
      definition.operations.find((candidate) => candidate.id === operation.id)!,
      confirmation,
    ),
  );
  const cleanupEntryCount = operations.reduce(
    (count, operation) =>
      count +
      [
        operation.stagedPath,
        operation.backupPath,
        operation.quarantinePath,
      ].filter((relative) => relative !== null).length,
    0,
  );
  const estimatedEventCount =
    16 + operations.length * 11 + cleanupEntryCount * 2;
  if (
    estimatedEventCount >
    profileBound(options.profile, "finalizationEventCount")
  ) {
    throw new Error(
      "Workflow finalization event count exceeds its configured bound",
    );
  }
  for (const operation of operations) {
    const approvedRoot = path.resolve(
      options.baseRoot,
      ...(roots.get(operation.rootId) ?? "").split("/"),
    );
    if (
      operation.stagedPath &&
      !isInside(
        approvedRoot,
        path.resolve(options.baseRoot, operation.stagedPath),
      )
    ) {
      throw new Error(
        `Workflow finalization staging path escapes its approved root: ${operation.id}`,
      );
    }
    if (
      operation.backupPath &&
      !isInside(
        approvedRoot,
        path.resolve(options.baseRoot, operation.backupPath),
      )
    ) {
      throw new Error(
        `Workflow finalization backup path escapes its approved root: ${operation.id}`,
      );
    }
    if (
      operation.quarantinePath &&
      !isInside(
        approvedRoot,
        path.resolve(options.baseRoot, operation.quarantinePath),
      )
    ) {
      throw new Error(
        `Workflow finalization quarantine path escapes its approved root: ${operation.id}`,
      );
    }
  }
  const previewBase = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-preview" as const,
    runId: options.state.runId,
    revision: planRevision,
    actionId: planActionId,
    transactionId,
    roots: structuredClone(definition.roots),
    execution: structuredClone(options.execution),
    contentSnapshotHash,
    verificationReceiptIds: [...verificationReceiptIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    operations,
    confirmation,
    requiresConfirmation,
  };
  const planHash = sha256(JSON.stringify(stableValue(previewBase)));
  const preview = { ...previewBase, planHash };
  const planBytes = Buffer.byteLength(
    JSON.stringify(stableValue(preview)),
    "utf8",
  );
  if (planBytes > profileBound(options.profile, "finalizationPlanBytes")) {
    throw new Error(
      "Workflow finalization preview exceeds its configured bound",
    );
  }
  if (!HASH_PATTERN.test(planHash))
    throw new Error("Workflow finalization plan hash is invalid");
  return preview;
}

export function sameWorkflowFinalizationPreview(
  left: WorkflowFinalizationPreview,
  right: WorkflowFinalizationPreview,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

type WorkflowFinalizationTransactionStatus =
  "prepared" | "applying" | "committed" | "rolling-back" | "rolled-back";

type WorkflowFinalizationOperationStatus =
  | "pending"
  | "staged"
  | "target-quarantined"
  | "source-quarantined"
  | "target-published"
  | "verified"
  | "applying"
  | "committed"
  | "rolled-back";

type WorkflowFinalizationEventType =
  | "prepared"
  | "applying"
  | "operation-staged"
  | "operation-started"
  | "operation-completed"
  | "operation-quarantined"
  | "operation-published"
  | "operation-verified"
  | "committing"
  | "receipt-written"
  | "committed"
  | "rolling-back"
  | "operation-rolled-back"
  | "rolled-back"
  | "cleanup-started"
  | "cleanup-item"
  | "cleanup-completed";

interface WorkflowFinalizationTransactionOperation extends WorkflowFinalizationPlannedOperation {
  content: string | null;
  previousSourceContent: string | null;
  previousTargetContent: string | null;
  status: WorkflowFinalizationOperationStatus;
}

interface WorkflowFinalizationTransactionEvent {
  sequence: number;
  type: WorkflowFinalizationEventType;
  operationId: string | null;
  boundary: string;
  timestamp: string;
}

export interface WorkflowFinalizationTransaction {
  schemaVersion: 1;
  kind: "workflow-finalization-transaction";
  status: WorkflowFinalizationTransactionStatus;
  transactionId: string;
  runId: string;
  revision: number;
  resultingRevision: number;
  sourceActionId: string;
  execution: RuntimeIdentity;
  plan: WorkflowFinalizationPreview;
  operations: WorkflowFinalizationTransactionOperation[];
  confirmation: WorkflowFinalizationConfirmationRecord;
  events: WorkflowFinalizationTransactionEvent[];
  cleanup: WorkflowFinalizationCleanup;
  recovery: {
    status: "none" | "recovered" | "rolled-back";
    crashBoundaries: string[];
  };
  receipt?: WorkflowFinalizationReceipt;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowFinalizationApplyRequest {
  runRoot: string;
  baseRoot: string;
  profile: WorkflowDurabilityProfile;
  plan: WorkflowFinalizationPreview;
  definition: WorkflowFinalizationDefinition;
  execution: RuntimeIdentity;
  sourceActionId: string;
  resultingRevision: number;
  confirmation: WorkflowFinalizationConfirmationRecord;
}

export interface WorkflowFinalizationApplyResult {
  status: "committed" | "rolled-back";
  transaction: WorkflowFinalizationTransaction;
  receipt: WorkflowFinalizationReceipt;
}

export interface WorkflowFinalizationRecoveryResult {
  status: "none" | "recovered" | "blocked" | "rolled-back";
  transaction?: WorkflowFinalizationTransaction;
  unknownPaths?: string[];
  receipt?: WorkflowFinalizationReceipt;
}

export class WorkflowFinalizationTransactionPendingError extends Error {
  constructor(readonly transaction: WorkflowFinalizationTransaction) {
    super(
      "WorkflowRuntime finalization recovery is required before another mutation",
    );
    this.name = "WorkflowFinalizationTransactionPendingError";
  }
}

export class WorkflowFinalizationConflictError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `Workflow finalization observed an unknown file identity: ${paths.join(", ")}`,
    );
    this.name = "WorkflowFinalizationConflictError";
  }
}

function parseMaterialIdentity(
  value: unknown,
  label: string,
): WorkflowFinalizationMaterialIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["exists", "bytes", "sha256"]), label);
  if (typeof value.exists !== "boolean")
    throw new Error(`${label}.exists must be boolean`);
  const bytes = nonNegativeInteger(value.bytes, `${label}.bytes`);
  const digest =
    value.sha256 === null ? null : boundedHash(value.sha256, `${label}.sha256`);
  if (
    (!value.exists && (bytes !== 0 || digest !== null)) ||
    (value.exists && digest === null)
  ) {
    throw new Error(`${label} identity is inconsistent`);
  }
  return { exists: value.exists, bytes, sha256: digest };
}

function parseOperationState(
  value: unknown,
  label: string,
): WorkflowFinalizationPlannedOperation["precondition"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["source", "target"]), label);
  return {
    source:
      value.source === null
        ? null
        : parseMaterialIdentity(value.source, `${label}.source`),
    target: parseMaterialIdentity(value.target, `${label}.target`),
  };
}

function parsePlannedOperation(
  value: unknown,
  index: number,
): WorkflowFinalizationPlannedOperation {
  const label = `Workflow finalization planned operation ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "id",
      "kind",
      "rootId",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "contentHash",
      "contentBytes",
      "requiresConfirmation",
    ]),
    label,
  );
  if (
    value.kind !== "write" &&
    value.kind !== "remove" &&
    value.kind !== "move"
  ) {
    throw new Error(`${label} kind is invalid`);
  }
  if (value.source !== null && value.source !== undefined) {
    normalizePath(value.source, `${label} source`);
  }
  if (value.stagedPath !== null && value.stagedPath !== undefined) {
    normalizePath(value.stagedPath, `${label} stagedPath`);
  }
  if (value.backupPath !== null && value.backupPath !== undefined) {
    normalizePath(value.backupPath, `${label} backupPath`);
  }
  if (value.quarantinePath !== null && value.quarantinePath !== undefined) {
    normalizePath(value.quarantinePath, `${label} quarantinePath`);
  }
  const contentHash =
    value.contentHash === null
      ? null
      : boundedHash(value.contentHash, `${label} contentHash`);
  const contentBytes = nonNegativeInteger(
    value.contentBytes,
    `${label} contentBytes`,
  );
  if (typeof value.requiresConfirmation !== "boolean") {
    throw new Error(`${label} requiresConfirmation must be boolean`);
  }
  const planned: WorkflowFinalizationPlannedOperation = {
    id: safeId(value.id, `${label} id`),
    kind: value.kind,
    rootId: safeId(value.rootId, `${label} rootId`),
    source:
      value.source === null || value.source === undefined
        ? null
        : String(value.source),
    target: normalizePath(value.target, `${label} target`),
    stagedPath:
      value.stagedPath === null || value.stagedPath === undefined
        ? null
        : String(value.stagedPath),
    backupPath:
      value.backupPath === null || value.backupPath === undefined
        ? null
        : String(value.backupPath),
    quarantinePath:
      value.quarantinePath === null || value.quarantinePath === undefined
        ? null
        : String(value.quarantinePath),
    precondition: parseOperationState(
      value.precondition,
      `${label} precondition`,
    ),
    expectedPostState: parseOperationState(
      value.expectedPostState,
      `${label} expectedPostState`,
    ),
    contentHash,
    contentBytes,
    requiresConfirmation: value.requiresConfirmation,
  };
  if (
    planned.kind === "write" &&
    (planned.source !== null ||
      planned.contentHash === null ||
      !planned.expectedPostState.target.exists ||
      planned.expectedPostState.source !== null ||
      planned.contentBytes !== planned.expectedPostState.target.bytes ||
      planned.contentHash !== planned.expectedPostState.target.sha256)
  ) {
    throw new Error(`${label} write identity is invalid`);
  }
  if (
    planned.kind === "remove" &&
    (planned.source !== null ||
      planned.contentHash !== null ||
      planned.contentBytes !== 0 ||
      planned.expectedPostState.source !== null ||
      planned.expectedPostState.target.exists)
  ) {
    throw new Error(`${label} remove identity is invalid`);
  }
  if (
    planned.kind === "move" &&
    (planned.source === null ||
      planned.precondition.source === null ||
      planned.contentHash !== planned.precondition.source.sha256 ||
      planned.contentBytes !== planned.precondition.source.bytes ||
      planned.expectedPostState.source?.exists !== false ||
      !sameIdentity(
        planned.expectedPostState.target,
        planned.precondition.source,
      ))
  ) {
    throw new Error(`${label} move identity is invalid`);
  }
  return planned;
}

function parseTimestamp(value: unknown, label: string): string {
  const result = boundedText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return result;
}

function parseActionId(value: unknown, label: string): string | null {
  return value === null ? null : safeId(value, label);
}

export function parseWorkflowFinalizationPreview(
  value: unknown,
): WorkflowFinalizationPreview {
  const label = "Workflow finalization preview";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "runId",
      "revision",
      "actionId",
      "transactionId",
      "roots",
      "execution",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "operations",
      "confirmation",
      "requiresConfirmation",
      "planHash",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
    value.kind !== "workflow-finalization-preview"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  const transactionId = safeId(value.transactionId, `${label} transactionId`);
  if (
    !Array.isArray(value.verificationReceiptIds) ||
    value.verificationReceiptIds.length > 256
  ) {
    throw new Error(`${label} verificationReceiptIds are invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map((entry) =>
    boundedText(entry, `${label} verificationReceiptIds`),
  );
  if (new Set(verificationReceiptIds).size !== verificationReceiptIds.length) {
    throw new Error(
      `${label} verificationReceiptIds must not contain duplicates`,
    );
  }
  if (
    !Array.isArray(value.roots) ||
    value.roots.length === 0 ||
    value.roots.length > 256
  ) {
    throw new Error(`${label}.roots are outside their bound`);
  }
  const roots = value.roots.map((entry, index) =>
    parseFinalizationRoot(entry, index),
  );
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error(`${label}.roots must have unique ids`);
  }
  if (
    roots.some((left, leftIndex) =>
      roots.some(
        (right, rightIndex) =>
          leftIndex !== rightIndex &&
          (left.path === right.path ||
            isRelativePathWithin(left.path, right.path) ||
            isRelativePathWithin(right.path, left.path)),
      ),
    )
  ) {
    throw new Error(`${label}.roots must not overlap`);
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS
  ) {
    throw new Error(`${label} operations are outside their bound`);
  }
  const operations = value.operations.map((entry, index) =>
    parsePlannedOperation(entry, index),
  );
  if (
    new Set(operations.map((operation) => operation.id)).size !==
    operations.length
  ) {
    throw new Error(`${label} operation ids must be unique`);
  }
  for (const operation of operations) {
    const root = roots.find((candidate) => candidate.id === operation.rootId);
    if (!root) throw new Error(`${label} operation root is not declared`);
    const operationPrefix = `${joinRelative(
      root.path,
      `.badger/finalization/${transactionId}`,
    )}/${operation.id}`;
    const expectedStagedPath =
      operation.kind === "write" ? `${operationPrefix}.stage` : null;
    const expectedBackupPath =
      operation.precondition.target.exists &&
      (operation.kind === "write" || operation.kind === "move")
        ? `${operationPrefix}.backup`
        : null;
    const expectedQuarantinePath =
      (operation.kind === "remove" && operation.precondition.target.exists) ||
      (operation.kind === "move" && operation.precondition.source?.exists)
        ? `${operationPrefix}.quarantine`
        : null;
    if (
      operation.stagedPath !== expectedStagedPath ||
      operation.backupPath !== expectedBackupPath ||
      operation.quarantinePath !== expectedQuarantinePath ||
      (operation.kind !== "move" && operation.source !== null) ||
      (operation.kind === "move" && operation.source === null)
    ) {
      throw new Error(`${label} operation coordinates are invalid`);
    }
    const internalPrefix = `${joinRelative(
      root.path,
      `.badger/finalization/${transactionId}`,
    )}/`;
    if (
      (operation.stagedPath !== null &&
        !operation.stagedPath.startsWith(internalPrefix)) ||
      (operation.backupPath !== null &&
        !operation.backupPath.startsWith(internalPrefix))
    ) {
      throw new Error(
        `${label} staging or backup path is not transaction-scoped`,
      );
    }
    for (const [candidate, protectedPath] of [
      [operation.target, true],
      [operation.source, true],
      [operation.stagedPath, false],
      [operation.backupPath, false],
      [operation.quarantinePath, false],
    ] as const) {
      if (
        candidate !== null &&
        ((protectedPath && isProtectedRuntimePath(candidate)) ||
          !isRelativePathWithin(root.path, candidate))
      ) {
        throw new Error(`${label} operation path escapes its approved root`);
      }
    }
  }
  if (typeof value.requiresConfirmation !== "boolean") {
    throw new Error(`${label} requiresConfirmation must be boolean`);
  }
  const preview: WorkflowFinalizationPreview = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-preview",
    runId: boundedText(value.runId, `${label} runId`),
    revision: nonNegativeInteger(value.revision, `${label} revision`),
    actionId: parseActionId(value.actionId, `${label} actionId`),
    transactionId,
    roots,
    execution: parseExecutionIdentity(value.execution),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label} contentSnapshotHash`,
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    operations,
    confirmation: normalizeConfirmation(value.confirmation),
    requiresConfirmation: value.requiresConfirmation,
    planHash: boundedHash(value.planHash, `${label} planHash`),
  };
  const { planHash: _planHash, ...withoutHash } = preview;
  const expectedHash = sha256(JSON.stringify(stableValue(withoutHash)));
  if (expectedHash !== preview.planHash)
    throw new Error(`${label} hash is not canonical`);
  return preview;
}

function parseConfirmationRecord(
  value: unknown,
  label: string,
): WorkflowFinalizationConfirmationRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "decisionId",
      "actionId",
      "sourceActionId",
      "planHash",
      "revision",
      "choiceId",
      "reviewer",
      "rationaleHash",
      "confirmedAt",
    ]),
    label,
  );
  const reviewer = value.reviewer;
  if (!isRecord(reviewer))
    throw new Error(`${label}.reviewer must be an object`);
  assertKnownFields(
    reviewer,
    new Set(["subject", "authorities"]),
    `${label}.reviewer`,
  );
  if (
    !Array.isArray(reviewer.authorities) ||
    reviewer.authorities.length > 64
  ) {
    throw new Error(`${label}.reviewer.authorities must be a bounded array`);
  }
  const authorities = reviewer.authorities.map((entry) =>
    boundedText(entry, `${label}.reviewer.authorities`),
  );
  if (new Set(authorities).size !== authorities.length) {
    throw new Error(
      `${label}.reviewer.authorities must not contain duplicates`,
    );
  }
  const sortedAuthorities = [...authorities].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(authorities) !== JSON.stringify(sortedAuthorities)) {
    throw new Error(`${label}.reviewer.authorities must be sorted`);
  }
  return {
    decisionId: safeId(value.decisionId, `${label}.decisionId`),
    actionId: safeId(value.actionId, `${label}.actionId`),
    sourceActionId: safeId(value.sourceActionId, `${label}.sourceActionId`),
    planHash: boundedHash(value.planHash, `${label}.planHash`),
    revision: nonNegativeInteger(value.revision, `${label}.revision`),
    choiceId:
      value.choiceId === "confirm"
        ? "confirm"
        : (() => {
            throw new Error(`${label}.choiceId is invalid`);
          })(),
    reviewer: {
      subject: boundedText(reviewer.subject, `${label}.reviewer.subject`),
      authorities,
    },
    rationaleHash:
      value.rationaleHash === null
        ? null
        : boundedHash(value.rationaleHash, `${label}.rationaleHash`),
    confirmedAt: parseTimestamp(value.confirmedAt, `${label}.confirmedAt`),
  };
}

function parseOperationReceipt(
  value: unknown,
  index: number,
): WorkflowFinalizationOperationReceipt {
  const label = `Workflow finalization operation receipt ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "id",
      "kind",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "observedPostState",
      "status",
    ]),
    label,
  );
  if (
    value.kind !== "write" &&
    value.kind !== "remove" &&
    value.kind !== "move"
  ) {
    throw new Error(`${label}.kind is invalid`);
  }
  if (value.status !== "committed" && value.status !== "rolled-back") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    id: safeId(value.id, `${label}.id`),
    kind: value.kind,
    source:
      value.source === null || value.source === undefined
        ? null
        : normalizePath(value.source, `${label}.source`),
    target: normalizePath(value.target, `${label}.target`),
    stagedPath:
      value.stagedPath === null || value.stagedPath === undefined
        ? null
        : normalizePath(value.stagedPath, `${label}.stagedPath`),
    backupPath:
      value.backupPath === null || value.backupPath === undefined
        ? null
        : normalizePath(value.backupPath, `${label}.backupPath`),
    quarantinePath:
      value.quarantinePath === null || value.quarantinePath === undefined
        ? null
        : normalizePath(value.quarantinePath, `${label}.quarantinePath`),
    precondition: parseOperationState(
      value.precondition,
      `${label}.precondition`,
    ),
    expectedPostState: parseOperationState(
      value.expectedPostState,
      `${label}.expectedPostState`,
    ),
    observedPostState: parseOperationState(
      value.observedPostState,
      `${label}.observedPostState`,
    ),
    status: value.status,
  };
}

function parseCleanupEntry(
  value: unknown,
  index: number,
): WorkflowFinalizationCleanupEntry {
  const label = `Workflow finalization cleanup entry ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set(["operationId", "role", "path", "expected", "status"]),
    label,
  );
  if (
    value.role !== "staged" &&
    value.role !== "backup" &&
    value.role !== "quarantine"
  ) {
    throw new Error(`${label}.role is invalid`);
  }
  if (
    value.status !== "pending" &&
    value.status !== "cleaned" &&
    value.status !== "missing"
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    operationId: safeId(value.operationId, `${label}.operationId`),
    role: value.role,
    path: normalizePath(value.path, `${label}.path`),
    expected: parseMaterialIdentity(value.expected, `${label}.expected`),
    status: value.status,
  };
}

function parseCleanup(
  value: unknown,
  label: string,
): WorkflowFinalizationCleanup {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, new Set(["status", "entries"]), label);
  if (value.status !== "pending" && value.status !== "completed") {
    throw new Error(`${label}.status is invalid`);
  }
  if (!Array.isArray(value.entries) || value.entries.length > 768) {
    throw new Error(`${label}.entries are outside their bound`);
  }
  const entries = value.entries.map((entry, index) =>
    parseCleanupEntry(entry, index),
  );
  const keys = entries.map(
    (entry) => `${entry.operationId}:${entry.role}:${entry.path}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label}.entries must be unique`);
  }
  if (
    value.status === "completed" &&
    entries.some((entry) => entry.status === "pending")
  ) {
    throw new Error(`${label}.completed state has pending entries`);
  }
  return { status: value.status, entries };
}

function cleanupEntryKey(
  entry: Pick<WorkflowFinalizationCleanupEntry, "operationId" | "role">,
): string {
  return `${entry.operationId}:${entry.role}`;
}

function validateCleanupEntries(
  expected: readonly WorkflowFinalizationCleanupEntry[],
  actual: WorkflowFinalizationCleanup,
  label: string,
): void {
  if (expected.length !== actual.entries.length) {
    throw new Error(`${label}.entries do not match transaction operations`);
  }
  const expectedByKey = new Map(
    expected.map((entry) => [cleanupEntryKey(entry), entry]),
  );
  const actualKeys = new Set<string>();
  for (const entry of actual.entries) {
    const key = cleanupEntryKey(entry);
    const expectedEntry = expectedByKey.get(key);
    if (
      !expectedEntry ||
      actualKeys.has(key) ||
      entry.path !== expectedEntry.path ||
      !sameIdentity(entry.expected, expectedEntry.expected)
    ) {
      throw new Error(`${label}.entry identity is invalid`);
    }
    actualKeys.add(key);
  }
}

function receiptCleanupEntries(
  operations: readonly WorkflowFinalizationOperationReceipt[],
): WorkflowFinalizationCleanupEntry[] {
  const entries: WorkflowFinalizationCleanupEntry[] = [];
  for (const operation of operations) {
    const values: Array<{
      role: WorkflowFinalizationCleanupEntry["role"];
      path: string | null;
      expected: WorkflowFinalizationMaterialIdentity;
    }> = [
      {
        role: "staged",
        path: operation.stagedPath,
        expected: operation.expectedPostState.target,
      },
      {
        role: "backup",
        path: operation.backupPath,
        expected: operation.precondition.target,
      },
      {
        role: "quarantine",
        path: operation.quarantinePath,
        expected:
          operation.kind === "remove"
            ? operation.precondition.target
            : (operation.precondition.source ?? materialIdentity(null)),
      },
    ];
    for (const value of values) {
      if (!value.path || !value.expected.exists) continue;
      entries.push({
        operationId: operation.id,
        role: value.role,
        path: value.path,
        expected: value.expected,
        status: "pending",
      });
    }
  }
  return entries;
}

function parseFinalizationReceipt(value: unknown): WorkflowFinalizationReceipt {
  const label = "Workflow finalization receipt";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "receiptId",
      "receiptHash",
      "transactionId",
      "runId",
      "revision",
      "resultingRevision",
      "planHash",
      "execution",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "confirmation",
      "operations",
      "events",
      "cleanup",
      "recovery",
      "committedAt",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
    value.kind !== "workflow-finalization-receipt"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (
    !Array.isArray(value.verificationReceiptIds) ||
    value.verificationReceiptIds.length > 256
  ) {
    throw new Error(`${label}.verificationReceiptIds is invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map((entry) =>
    boundedText(entry, `${label}.verificationReceiptIds`),
  );
  const operations = Array.isArray(value.operations)
    ? value.operations.map((entry, index) =>
        parseOperationReceipt(entry, index),
      )
    : (() => {
        throw new Error(`${label}.operations must be an array`);
      })();
  if (
    operations.length === 0 ||
    operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS
  ) {
    throw new Error(`${label}.operations are outside their bound`);
  }
  if (
    new Set(operations.map((operation) => operation.id)).size !==
    operations.length
  ) {
    throw new Error(`${label}.operations must have unique ids`);
  }
  if (
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    value.events.length > WORKFLOW_FINALIZATION_MAX_EVENTS
  ) {
    throw new Error(`${label}.events are outside their bound`);
  }
  const events = value.events.map((entry, index) =>
    parseTransactionEvent(entry, index),
  );
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error(`${label}.events must have contiguous sequences`);
  }
  if (!isRecord(value.recovery))
    throw new Error(`${label}.recovery must be an object`);
  assertKnownFields(
    value.recovery,
    new Set(["status", "crashBoundaries"]),
    `${label}.recovery`,
  );
  if (
    value.recovery.status !== "none" &&
    value.recovery.status !== "recovered" &&
    value.recovery.status !== "rolled-back"
  ) {
    throw new Error(`${label}.recovery.status is invalid`);
  }
  if (
    !Array.isArray(value.recovery.crashBoundaries) ||
    value.recovery.crashBoundaries.length > WORKFLOW_FINALIZATION_MAX_EVENTS
  ) {
    throw new Error(`${label}.recovery.crashBoundaries is invalid`);
  }
  const crashBoundaries = value.recovery.crashBoundaries.map((entry) =>
    boundedText(entry, `${label}.recovery.crashBoundaries`),
  );
  const cleanup =
    value.cleanup === undefined
      ? { status: "completed" as const, entries: [] }
      : parseCleanup(value.cleanup, `${label}.cleanup`);
  if (value.cleanup !== undefined) {
    validateCleanupEntries(receiptCleanupEntries(operations), cleanup, label);
  }
  const receipt: WorkflowFinalizationReceipt = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt",
    receiptId: safeId(value.receiptId, `${label}.receiptId`),
    receiptHash: boundedHash(value.receiptHash, `${label}.receiptHash`),
    transactionId: safeId(value.transactionId, `${label}.transactionId`),
    runId: boundedText(value.runId, `${label}.runId`),
    revision: nonNegativeInteger(value.revision, `${label}.revision`),
    resultingRevision: nonNegativeInteger(
      value.resultingRevision,
      `${label}.resultingRevision`,
    ),
    planHash: boundedHash(value.planHash, `${label}.planHash`),
    execution: parseExecutionIdentity(value.execution),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label}.contentSnapshotHash`,
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    confirmation:
      value.confirmation === null
        ? (() => {
            throw new Error(`${label}.confirmation is required`);
          })()
        : parseConfirmationRecord(value.confirmation, `${label}.confirmation`),
    operations,
    events,
    cleanup,
    recovery: { status: value.recovery.status, crashBoundaries },
    committedAt: parseTimestamp(value.committedAt, `${label}.committedAt`),
  };
  if (
    cleanup.entries.some(
      (entry) =>
        entry.status === "missing" &&
        !cleanupMissingIsExpectedFor(operations, events, entry),
    )
  ) {
    throw new Error(`${label} cleanup missing identity is ambiguous`);
  }
  if (receipt.confirmation.planHash !== receipt.planHash) {
    throw new Error(`${label} confirmation plan identity is invalid`);
  }
  const expectedOperationStatus =
    receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed";
  for (const operation of receipt.operations) {
    if (operation.status !== expectedOperationStatus) {
      throw new Error(`${label} operation status does not match recovery`);
    }
    const expectedObservedState =
      expectedOperationStatus === "rolled-back"
        ? operation.precondition
        : operation.expectedPostState;
    if (!sameStableValue(operation.observedPostState, expectedObservedState)) {
      throw new Error(`${label} operation observed state is invalid`);
    }
  }
  const { receiptHash: _receiptHash, ...withoutHash } = receipt;
  if (
    sha256(JSON.stringify(stableValue(withoutHash))) !== receipt.receiptHash
  ) {
    throw new Error(`${label} hash is not canonical`);
  }
  return receipt;
}

function parseTransactionEvent(
  value: unknown,
  index: number,
): WorkflowFinalizationTransactionEvent {
  const label = `Workflow finalization transaction event ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set(["sequence", "type", "operationId", "boundary", "timestamp"]),
    label,
  );
  const eventTypes = new Set<WorkflowFinalizationEventType>([
    "prepared",
    "applying",
    "operation-staged",
    "operation-started",
    "operation-completed",
    "operation-quarantined",
    "operation-published",
    "operation-verified",
    "committing",
    "receipt-written",
    "committed",
    "rolling-back",
    "operation-rolled-back",
    "rolled-back",
    "cleanup-started",
    "cleanup-item",
    "cleanup-completed",
  ]);
  if (
    typeof value.type !== "string" ||
    !eventTypes.has(value.type as WorkflowFinalizationEventType)
  ) {
    throw new Error(`${label}.type is invalid`);
  }
  const boundary = boundedText(value.boundary, `${label}.boundary`);
  if (
    !WORKFLOW_FINALIZATION_BOUNDARY_PHASES.some(
      (phase) => boundary === phase || boundary.startsWith(`${phase}:`),
    )
  ) {
    throw new Error(`${label}.boundary is invalid`);
  }
  return {
    sequence: nonNegativeInteger(value.sequence, `${label}.sequence`),
    type: value.type as WorkflowFinalizationEventType,
    operationId:
      value.operationId === null
        ? null
        : safeId(value.operationId, `${label}.operationId`),
    boundary,
    timestamp: parseTimestamp(value.timestamp, `${label}.timestamp`),
  };
}

function parseTransactionOperation(
  value: unknown,
  index: number,
): WorkflowFinalizationTransactionOperation {
  const label = `Workflow finalization transaction operation ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "id",
      "kind",
      "rootId",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "contentHash",
      "contentBytes",
      "requiresConfirmation",
      "content",
      "previousSourceContent",
      "previousTargetContent",
      "status",
    ]),
    label,
  );
  const {
    content: _content,
    previousSourceContent: _previousSourceContent,
    previousTargetContent: _previousTargetContent,
    status: _status,
    ...plannedValue
  } = value;
  const planned = parsePlannedOperation(plannedValue, index);
  const statusValues = new Set<WorkflowFinalizationOperationStatus>([
    "pending",
    "staged",
    "target-quarantined",
    "source-quarantined",
    "target-published",
    "verified",
    "applying",
    "committed",
    "rolled-back",
  ]);
  if (
    typeof value.status !== "string" ||
    !statusValues.has(value.status as WorkflowFinalizationOperationStatus)
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  const content =
    value.content === null
      ? null
      : boundedContent(value.content, `${label}.content`);
  const previousSourceContent =
    value.previousSourceContent === null
      ? null
      : boundedContent(
          value.previousSourceContent,
          `${label}.previousSourceContent`,
        );
  const previousTargetContent =
    value.previousTargetContent === null
      ? null
      : boundedContent(
          value.previousTargetContent,
          `${label}.previousTargetContent`,
        );
  const expectedContentIdentity =
    content === null ? materialIdentity(null) : materialIdentity(content);
  if (
    (planned.kind === "write" || planned.kind === "move") &&
    (content === null ||
      !sameIdentity(expectedContentIdentity, {
        exists: true,
        bytes: planned.contentBytes,
        sha256: planned.contentHash,
      }))
  ) {
    throw new Error(`${label}.content identity is invalid`);
  }
  if (planned.kind === "remove" && content !== null) {
    throw new Error(`${label}.content is invalid for remove`);
  }
  if (
    !sameIdentity(
      materialIdentity(previousTargetContent),
      planned.precondition.target,
    ) ||
    !sameIdentity(
      materialIdentity(previousSourceContent),
      planned.precondition.source ?? materialIdentity(null),
    )
  ) {
    throw new Error(
      `${label} previous material does not match its precondition`,
    );
  }
  return {
    ...planned,
    content,
    previousSourceContent,
    previousTargetContent,
    status: value.status as WorkflowFinalizationOperationStatus,
  };
}

export function parseWorkflowFinalizationTransaction(
  value: unknown,
): WorkflowFinalizationTransaction {
  const label = "Workflow finalization transaction";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "status",
      "transactionId",
      "runId",
      "revision",
      "resultingRevision",
      "sourceActionId",
      "execution",
      "plan",
      "operations",
      "confirmation",
      "events",
      "cleanup",
      "recovery",
      "receipt",
      "createdAt",
      "updatedAt",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION ||
    value.kind !== "workflow-finalization-transaction"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  const statuses = new Set<WorkflowFinalizationTransactionStatus>([
    "prepared",
    "applying",
    "committed",
    "rolling-back",
    "rolled-back",
  ]);
  if (
    typeof value.status !== "string" ||
    !statuses.has(value.status as WorkflowFinalizationTransactionStatus)
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS
  ) {
    throw new Error(`${label}.operations are outside their bound`);
  }
  if (
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    value.events.length > WORKFLOW_FINALIZATION_MAX_EVENTS
  ) {
    throw new Error(`${label}.events are outside their bound`);
  }
  const plan = parseWorkflowFinalizationPreview(value.plan);
  const operations = value.operations.map((entry, index) =>
    parseTransactionOperation(entry, index),
  );
  if (
    new Set(operations.map((operation) => operation.id)).size !==
    operations.length
  ) {
    throw new Error(`${label}.operations must have unique ids`);
  }
  if (
    JSON.stringify(
      stableValue(
        operations.map(
          ({
            content,
            previousSourceContent,
            previousTargetContent,
            status,
            ...operation
          }) => operation,
        ),
      ),
    ) !== JSON.stringify(stableValue(plan.operations))
  ) {
    throw new Error(`${label}.operations do not match its plan`);
  }
  const events = value.events.map((entry, index) =>
    parseTransactionEvent(entry, index),
  );
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error(`${label}.events must have contiguous sequences`);
  }
  if (!isRecord(value.recovery))
    throw new Error(`${label}.recovery must be an object`);
  assertKnownFields(
    value.recovery,
    new Set(["status", "crashBoundaries"]),
    `${label}.recovery`,
  );
  if (
    value.recovery.status !== "none" &&
    value.recovery.status !== "recovered" &&
    value.recovery.status !== "rolled-back"
  ) {
    throw new Error(`${label}.recovery.status is invalid`);
  }
  if (
    !Array.isArray(value.recovery.crashBoundaries) ||
    value.recovery.crashBoundaries.length > WORKFLOW_FINALIZATION_MAX_EVENTS
  ) {
    throw new Error(`${label}.recovery.crashBoundaries is invalid`);
  }
  const receipt =
    value.receipt === undefined
      ? undefined
      : parseFinalizationReceipt(value.receipt);
  const legacyCleanupEntries = cleanupEntriesForOperations(operations);
  const cleanup =
    value.cleanup === undefined
      ? legacyCleanupEntries.length > 0
        ? { status: "pending" as const, entries: legacyCleanupEntries }
        : { status: "completed" as const, entries: [] }
      : parseCleanup(value.cleanup, `${label}.cleanup`);
  if (value.cleanup !== undefined) {
    validateCleanupEntries(
      cleanupEntriesForOperations(operations),
      cleanup,
      label,
    );
  }
  if (value.status === "committed" && !receipt) {
    throw new Error(`${label} committed state is missing its receipt`);
  }
  if (value.status === "rolled-back" && !receipt) {
    throw new Error(`${label} rolled-back transaction is missing its receipt`);
  }
  if (
    receipt &&
    (receipt.transactionId !== value.transactionId ||
      receipt.planHash !== plan.planHash ||
      (value.status === "rolled-back" &&
        receipt.recovery.status !== "rolled-back"))
  ) {
    throw new Error(`${label} receipt identity does not match the transaction`);
  }
  const transaction: WorkflowFinalizationTransaction = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-transaction",
    status: value.status as WorkflowFinalizationTransactionStatus,
    transactionId: safeId(value.transactionId, `${label}.transactionId`),
    runId: boundedText(value.runId, `${label}.runId`),
    revision: nonNegativeInteger(value.revision, `${label}.revision`),
    resultingRevision: nonNegativeInteger(
      value.resultingRevision,
      `${label}.resultingRevision`,
    ),
    sourceActionId: safeId(value.sourceActionId, `${label}.sourceActionId`),
    execution: parseExecutionIdentity(value.execution),
    plan,
    operations,
    confirmation:
      value.confirmation === null
        ? (() => {
            throw new Error(`${label}.confirmation is required`);
          })()
        : parseConfirmationRecord(value.confirmation, `${label}.confirmation`),
    events,
    cleanup,
    recovery: {
      status: value.recovery.status,
      crashBoundaries: value.recovery.crashBoundaries.map((entry) =>
        boundedText(entry, `${label}.recovery.crashBoundaries`),
      ),
    },
    ...(receipt ? { receipt } : {}),
    createdAt: parseTimestamp(value.createdAt, `${label}.createdAt`),
    updatedAt: parseTimestamp(value.updatedAt, `${label}.updatedAt`),
  };
  if (
    transaction.cleanup.entries.some(
      (entry) =>
        entry.status === "missing" &&
        !cleanupMissingIsExpected(transaction, entry),
    )
  ) {
    throw new Error(`${label} cleanup missing identity is ambiguous`);
  }
  const reviewerPolicy = normalizeConfirmation(plan.confirmation).reviewer;
  const reviewerSubjects = reviewerPolicy?.subjects ?? [];
  const reviewerAuthorities = reviewerPolicy?.authorities ?? [];
  if (
    transaction.status === "committed" &&
    transaction.operations.some((operation) => operation.status !== "committed")
  ) {
    throw new Error(`${label} committed transaction has incomplete operations`);
  }
  if (
    transaction.status === "rolled-back" &&
    transaction.operations.some(
      (operation) => operation.status !== "rolled-back",
    )
  ) {
    throw new Error(
      `${label} rolled-back transaction has incomplete operations`,
    );
  }
  if (
    transaction.cleanup.status === "completed" &&
    transaction.cleanup.entries.some((entry) => entry.status === "pending")
  ) {
    throw new Error(`${label} completed cleanup has pending entries`);
  }
  if (
    (reviewerSubjects.length > 0 &&
      !reviewerSubjects.includes(transaction.confirmation.reviewer.subject)) ||
    reviewerAuthorities.some(
      (authority) =>
        !transaction.confirmation.reviewer.authorities.includes(authority),
    )
  ) {
    throw new Error(`${label} confirmation reviewer is unauthorized`);
  }
  if (
    transaction.runId !== plan.runId ||
    transaction.revision !== plan.revision ||
    transaction.transactionId !== plan.transactionId ||
    transaction.plan.actionId !== plan.actionId ||
    transaction.sourceActionId !== plan.actionId ||
    transaction.resultingRevision !== transaction.confirmation.revision + 1 ||
    transaction.sourceActionId.length === 0 ||
    JSON.stringify(stableValue(transaction.execution)) !==
      JSON.stringify(stableValue(plan.execution))
  ) {
    throw new Error(`${label} identity does not match its plan`);
  }
  if (plan.requiresConfirmation !== (transaction.confirmation !== null)) {
    throw new Error(`${label} confirmation policy does not match its plan`);
  }
  if (
    transaction.confirmation &&
    (transaction.confirmation.planHash !== plan.planHash ||
      transaction.confirmation.sourceActionId !== transaction.sourceActionId ||
      transaction.confirmation.revision !== plan.revision + 1)
  ) {
    throw new Error(`${label} confirmation identity is invalid`);
  }
  if (
    receipt &&
    (receipt.runId !== transaction.runId ||
      receipt.revision !== transaction.revision ||
      receipt.resultingRevision !== transaction.resultingRevision ||
      !sameStableValue(receipt.execution, transaction.execution) ||
      !sameStableValue(receipt.confirmation, transaction.confirmation) ||
      (transaction.status === "committed" &&
        receipt.recovery.status === "rolled-back") ||
      (transaction.status === "rolled-back" &&
        receipt.recovery.status !== "rolled-back"))
  ) {
    throw new Error(`${label} receipt identity is invalid`);
  }
  if (
    receipt &&
    transaction.cleanup.status === "completed" &&
    !sameStableValue(receipt.cleanup, transaction.cleanup)
  ) {
    throw new Error(`${label} receipt cleanup does not match transaction`);
  }
  if (receipt && value.cleanup !== undefined) {
    const expectedOperations = transaction.operations.map((operation) =>
      receiptOperation(
        operation,
        receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed",
      ),
    );
    if (!sameStableValue(receipt.operations, expectedOperations)) {
      throw new Error(`${label} receipt operations do not match transaction`);
    }
    if (
      transaction.cleanup.status === "completed" &&
      !sameStableValue(receipt.events, transaction.events)
    ) {
      throw new Error(`${label} receipt events do not match transaction`);
    }
  }
  return transaction;
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function transactionMaxBytes(profile: WorkflowDurabilityProfile): number {
  return profileBound(profile, "finalizationTransactionBytes");
}

function receiptMaxBytes(profile: WorkflowDurabilityProfile): number {
  return profileBound(profile, "finalizationReceiptBytes");
}

function contentMaxBytes(profile: WorkflowDurabilityProfile): number {
  return profileBound(profile, "finalizationContentBytes");
}

function serializeTransaction(
  transaction: WorkflowFinalizationTransaction,
): string {
  return `${JSON.stringify(stableValue(transaction), null, 2)}\n`;
}

async function writeTransaction(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const serialized = serializeTransaction(transaction);
  const maxBytes = transactionMaxBytes(profile);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(
      `Workflow finalization transaction exceeds ${maxBytes} bytes`,
    );
  }
  await writeEngineRunText(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    serialized,
    maxBytes,
    "Workflow finalization transaction",
    { exclusive: options.exclusive, maxBytes },
  );
}

export async function readWorkflowFinalizationTransaction(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowFinalizationTransaction | null> {
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    transactionMaxBytes(profile),
    "Workflow finalization transaction",
  );
  if (raw === null) return null;
  try {
    const transaction = parseWorkflowFinalizationTransaction(
      JSON.parse(raw) as unknown,
    );
    if (Buffer.byteLength(raw, "utf8") > transactionMaxBytes(profile)) {
      throw new Error(
        "Workflow finalization transaction exceeds its configured bound",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(stableValue(transaction.plan)), "utf8") >
      profileBound(profile, "finalizationPlanBytes")
    ) {
      throw new Error(
        "Workflow finalization plan exceeds its configured bound",
      );
    }
    if (
      transaction.operations.length >
      profileBound(profile, "finalizationOperationCount")
    ) {
      throw new Error(
        "Workflow finalization transaction operation count exceeds its configured bound",
      );
    }
    if (
      transaction.events.length >
      profileBound(profile, "finalizationEventCount")
    ) {
      throw new Error(
        "Workflow finalization transaction event count exceeds its configured bound",
      );
    }
    return transaction;
  } catch (error) {
    throw new Error("Workflow finalization transaction is malformed", {
      cause: error,
    });
  }
}

async function appendTransactionEvent(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
  type: WorkflowFinalizationEventType,
  boundary: WorkflowFinalizationBoundary,
  operationId: string | null = boundary.operationId ?? null,
): Promise<void> {
  if (
    transaction.events.length >= profileBound(profile, "finalizationEventCount")
  ) {
    throw new Error(
      "Workflow finalization transaction event bound is exhausted",
    );
  }
  const timestamp = new Date().toISOString();
  transaction.events.push({
    sequence: transaction.events.length + 1,
    type,
    operationId,
    boundary: boundary.path
      ? `${boundary.phase}:${boundary.path}`
      : boundary.phase,
    timestamp,
  });
  transaction.updatedAt = timestamp;
  await writeTransaction(runRoot, profile, transaction);
  await invokeFault(boundary);
}

function basePath(root: string, relative: string, label: string): string {
  const normalized = normalizePath(relative, label);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!isInside(root, resolved))
    throw new Error(`${label} escapes its managed root`);
  return resolved;
}

async function writeBaseText(
  root: string,
  relative: string,
  content: string,
  maxBytes: number,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(
      "Workflow finalization content exceeds its configured bound",
    );
  }
  await atomicWriteContainedText(
    basePath(root, relative, "Workflow finalization write target"),
    content,
    {
      containedRoot: path.resolve(root),
      beforeCommit,
    },
  );
}

async function removeBaseFile(
  root: string,
  relative: string,
  beforeRemove?: () => void | Promise<void>,
): Promise<boolean> {
  const inspection = await inspectProtectedProjectPath(
    root,
    normalizePath(relative, "Workflow finalization remove target"),
    { label: "Workflow finalization remove target", expected: "file" },
  );
  if (!inspection.exists) return false;
  try {
    return await removeContainedFile(inspection.target, {
      containedRoot: inspection.projectRoot,
      beforeRemove,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /Contained file removal target changed before removal/u.test(
        error.message,
      )
    ) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
    throw error;
  }
}

async function moveBaseFile(
  root: string,
  source: string,
  destination: string,
  beforeMove?: () => void | Promise<void>,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<boolean> {
  const destinationParent = path.posix.dirname(destination);
  if (destinationParent !== ".") {
    await ensureProtectedProjectDirectory(
      path.resolve(root),
      destinationParent,
      {
        label: "Workflow finalization move destination parent",
      },
    );
  }
  try {
    return await moveContainedFile(
      basePath(root, source, "Workflow finalization move source"),
      basePath(root, destination, "Workflow finalization move destination"),
      {
        containedRoot: path.resolve(root),
        beforeMove,
        beforeSourceUnlink,
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EEXIST" ||
      (error instanceof Error &&
        /Contained file move (?:source|destination) (?:changed|must be missing)|Contained file move (?:parent|identity) changed/u.test(
          error.message,
        ))
    ) {
      throw new WorkflowFinalizationConflictError([source, destination]);
    }
    throw error;
  }
}

interface OperationMaterial {
  source: {
    identity: WorkflowFinalizationMaterialIdentity;
    content: string | null;
  } | null;
  target: {
    identity: WorkflowFinalizationMaterialIdentity;
    content: string | null;
  };
  staged: {
    identity: WorkflowFinalizationMaterialIdentity;
    content: string | null;
  } | null;
  backup: {
    identity: WorkflowFinalizationMaterialIdentity;
    content: string | null;
  } | null;
  quarantine: {
    identity: WorkflowFinalizationMaterialIdentity;
    content: string | null;
  } | null;
}

async function operationMaterial(
  root: string,
  operation: WorkflowFinalizationPlannedOperation,
  maxBytes: number,
): Promise<OperationMaterial> {
  const target = await readMaterial(root, operation.target, maxBytes);
  const source =
    operation.source === null
      ? null
      : await readMaterial(root, operation.source, maxBytes);
  const staged =
    operation.stagedPath === null
      ? null
      : await readMaterial(root, operation.stagedPath, maxBytes);
  const backup =
    operation.backupPath === null
      ? null
      : await readMaterial(root, operation.backupPath, maxBytes);
  const quarantine =
    operation.quarantinePath === null
      ? null
      : await readMaterial(root, operation.quarantinePath, maxBytes);
  return { source, target, staged, backup, quarantine };
}

function operationMatches(
  actual: OperationMaterial,
  expected:
    | WorkflowFinalizationPlannedOperation["precondition"]
    | WorkflowFinalizationPlannedOperation["expectedPostState"],
): boolean {
  return (
    ((actual.source === null && expected.source === null) ||
      (actual.source !== null &&
        expected.source !== null &&
        sameIdentity(actual.source.identity, expected.source))) &&
    sameIdentity(actual.target.identity, expected.target)
  );
}

function operationSourceExpected(
  operation: WorkflowFinalizationPlannedOperation,
): WorkflowFinalizationMaterialIdentity {
  if (!operation.precondition.source) {
    return materialIdentity(null);
  }
  return operation.precondition.source;
}

function operationTargetExpected(
  operation: WorkflowFinalizationPlannedOperation,
): WorkflowFinalizationMaterialIdentity {
  return operation.precondition.target;
}

function operationPostSourceExpected(
  operation: WorkflowFinalizationPlannedOperation,
): WorkflowFinalizationMaterialIdentity {
  if (!operation.expectedPostState.source) {
    return materialIdentity(null);
  }
  return operation.expectedPostState.source;
}

function operationPostTargetExpected(
  operation: WorkflowFinalizationPlannedOperation,
): WorkflowFinalizationMaterialIdentity {
  return operation.expectedPostState.target;
}

function storageContentExpected(
  operation: WorkflowFinalizationTransactionOperation,
  role: "staged" | "backup" | "quarantine",
): string | null {
  if (role === "staged") {
    return operation.kind === "write" ? operation.content : null;
  }
  if (role === "backup") return operation.previousTargetContent;
  return operation.kind === "remove"
    ? operation.previousTargetContent
    : operation.kind === "move"
      ? operation.previousSourceContent
      : null;
}

function storageMaterial(
  actual: OperationMaterial,
  role: "staged" | "backup" | "quarantine",
): OperationMaterial[typeof role] {
  return actual[role];
}

function storageMatchesContent(
  actual: OperationMaterial,
  role: "staged" | "backup" | "quarantine",
  content: string,
): boolean {
  const material = storageMaterial(actual, role);
  return Boolean(
    material?.identity.exists &&
    sameIdentity(material.identity, materialIdentity(content)),
  );
}

function storagePath(
  operation: WorkflowFinalizationTransactionOperation,
  role: "staged" | "backup" | "quarantine",
): string | null {
  return role === "staged"
    ? operation.stagedPath
    : role === "backup"
      ? operation.backupPath
      : operation.quarantinePath;
}

function storageIsExpectedOrMissing(
  actual: OperationMaterial,
  operation: WorkflowFinalizationTransactionOperation,
  role: "staged" | "backup" | "quarantine",
): boolean {
  const material = storageMaterial(actual, role);
  const expected = storageContentExpected(operation, role);
  if (material === null) return expected === null;
  if (!material.identity.exists) return true;
  return (
    expected !== null &&
    sameIdentity(material.identity, materialIdentity(expected))
  );
}

function operationStorageUnknownPaths(
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
): string[] {
  return (["staged", "backup", "quarantine"] as const).flatMap((role) => {
    const material = storageMaterial(actual, role);
    if (!material || storageIsExpectedOrMissing(actual, operation, role)) {
      return [];
    }
    return [storagePath(operation, role)!];
  });
}

type OperationProgress =
  "previous" | "staged" | "source-quarantined" | "target-published" | "post";

function operationProgress(
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
): OperationProgress | null {
  const sourcePre =
    operation.source === null ||
    (actual.source !== null &&
      sameIdentity(actual.source.identity, operationSourceExpected(operation)));
  const sourcePost =
    operation.source === null ||
    (actual.source !== null &&
      sameIdentity(
        actual.source.identity,
        operationPostSourceExpected(operation),
      ));
  const targetPre = sameIdentity(
    actual.target.identity,
    operationTargetExpected(operation),
  );
  const targetPost = sameIdentity(
    actual.target.identity,
    operationPostTargetExpected(operation),
  );
  if (operation.kind === "write") {
    if (targetPost) return "post";
    if (targetPre) {
      return actual.staged?.identity.exists ? "staged" : "previous";
    }
    if (!actual.target.identity.exists && actual.staged?.identity.exists) {
      return "staged";
    }
    return null;
  }
  if (operation.kind === "remove") {
    if (targetPre) return "previous";
    if (targetPost) return "post";
    return null;
  }
  if (sourcePre && targetPre) return "previous";
  if (sourcePost && targetPre) return "source-quarantined";
  if (sourcePost && !actual.target.identity.exists) return "source-quarantined";
  if (sourcePre && targetPost) return "source-quarantined";
  if (sourcePost && targetPost) return "post";
  return null;
}

function transactionOperationContent(
  operation: WorkflowFinalizationOperation,
  material: OperationMaterial,
): string | null {
  if (operation.kind === "write") return operation.content;
  if (operation.kind === "move") {
    if (!material.source || material.source.content === null) {
      throw new Error(
        `Workflow finalization move source is not readable: ${operation.source}`,
      );
    }
    return material.source.content;
  }
  return null;
}

async function createTransactionOperations(
  request: WorkflowFinalizationApplyRequest,
): Promise<WorkflowFinalizationTransactionOperation[]> {
  const definition = normalizeWorkflowFinalizationDefinition(
    request.definition,
  );
  const declarations = new Map(
    definition.operations.map((operation) => [operation.id, operation]),
  );
  const result: WorkflowFinalizationTransactionOperation[] = [];
  for (const planned of request.plan.operations) {
    const declaration = declarations.get(planned.id);
    if (
      !declaration ||
      declaration.kind !== planned.kind ||
      declaration.root !== planned.rootId ||
      joinRelative(
        definition.roots.find((root) => root.id === declaration.root)!.path,
        declaration.target,
      ) !== planned.target ||
      (declaration.kind === "move" &&
        joinRelative(
          definition.roots.find((root) => root.id === declaration.root)!.path,
          declaration.source,
        ) !== planned.source)
    ) {
      throw new WorkflowFinalizationConflictError([planned.id]);
    }
    const material = await operationMaterial(
      request.baseRoot,
      planned,
      contentMaxBytes(request.profile),
    );
    if (!operationMatches(material, planned.precondition)) {
      throw new WorkflowFinalizationConflictError([
        planned.target,
        ...(planned.source ? [planned.source] : []),
      ]);
    }
    const content = transactionOperationContent(declaration, material);
    if (
      content !== null &&
      !sameIdentity(materialIdentity(content), {
        exists: true,
        bytes: planned.contentBytes,
        sha256: planned.contentHash,
      })
    ) {
      throw new WorkflowFinalizationConflictError([planned.target]);
    }
    result.push({
      ...structuredClone(planned),
      content,
      previousSourceContent: material.source?.content ?? null,
      previousTargetContent: material.target.content,
      status: "pending",
    });
  }
  return result;
}

function transactionMatchesRequest(
  transaction: WorkflowFinalizationTransaction,
  request: WorkflowFinalizationApplyRequest,
): boolean {
  return (
    transaction.transactionId === request.plan.transactionId &&
    transaction.runId === request.plan.runId &&
    transaction.revision === request.plan.revision &&
    transaction.resultingRevision === request.resultingRevision &&
    transaction.sourceActionId === request.sourceActionId &&
    transaction.plan.planHash === request.plan.planHash &&
    sameStableValue(transaction.execution, request.execution) &&
    sameStableValue(transaction.confirmation, request.confirmation)
  );
}

export function validateWorkflowFinalizationPlanDeclaration(
  plan: WorkflowFinalizationPreview,
  definition: WorkflowFinalizationDefinition,
): void {
  const normalized = normalizeWorkflowFinalizationDefinition(definition);
  if (
    !sameStableValue(plan.roots, normalized.roots) ||
    !sameStableValue(plan.confirmation, normalized.confirmation) ||
    !sameStableValue(
      plan.verificationReceiptIds,
      normalized.requiredVerificationReceiptIds ?? [],
    ) ||
    plan.requiresConfirmation !== true ||
    plan.operations.length !== normalized.operations.length
  ) {
    throw new WorkflowFinalizationConflictError(["plan"]);
  }
  for (const [index, operation] of normalized.operations.entries()) {
    const planned = plan.operations[index];
    const target = joinRelative(
      normalized.roots.find((root) => root.id === operation.root)!.path,
      operation.target,
    );
    const source =
      operation.kind === "move"
        ? joinRelative(
            normalized.roots.find((root) => root.id === operation.root)!.path,
            operation.source,
          )
        : null;
    const prefix = `${joinRelative(
      normalized.roots.find((root) => root.id === operation.root)!.path,
      `.badger/finalization/${plan.transactionId}`,
    )}/${operation.id}`;
    const stagedPath = operation.kind === "write" ? `${prefix}.stage` : null;
    const backupPath =
      plan.operations[index].precondition.target.exists &&
      (operation.kind === "write" || operation.kind === "move")
        ? `${prefix}.backup`
        : null;
    const quarantinePath =
      (operation.kind === "remove" &&
        plan.operations[index].precondition.target.exists) ||
      (operation.kind === "move" &&
        plan.operations[index].precondition.source?.exists)
        ? `${prefix}.quarantine`
        : null;
    if (
      !planned ||
      planned.id !== operation.id ||
      planned.kind !== operation.kind ||
      planned.rootId !== operation.root ||
      planned.target !== target ||
      planned.source !== source ||
      planned.stagedPath !== stagedPath ||
      planned.backupPath !== backupPath ||
      planned.quarantinePath !== quarantinePath ||
      planned.requiresConfirmation !== true ||
      (operation.kind === "write" &&
        (planned.contentHash !== sha256(operation.content) ||
          planned.contentBytes !==
            Buffer.byteLength(operation.content, "utf8")))
    ) {
      throw new WorkflowFinalizationConflictError([operation.id]);
    }
  }
}

function cleanupEntriesForOperations(
  operations: readonly WorkflowFinalizationTransactionOperation[],
): WorkflowFinalizationCleanupEntry[] {
  const entries: WorkflowFinalizationCleanupEntry[] = [];
  for (const operation of operations) {
    for (const role of ["staged", "backup", "quarantine"] as const) {
      const relative = storagePath(operation, role);
      const content = storageContentExpected(operation, role);
      if (!relative || content === null) continue;
      entries.push({
        operationId: operation.id,
        role,
        path: relative,
        expected: materialIdentity(content),
        status: "pending",
      });
    }
  }
  return entries;
}

function newTransaction(
  request: WorkflowFinalizationApplyRequest,
  operations: WorkflowFinalizationTransactionOperation[],
): WorkflowFinalizationTransaction {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-transaction",
    status: "prepared",
    transactionId: request.plan.transactionId,
    runId: request.plan.runId,
    revision: request.plan.revision,
    resultingRevision: request.resultingRevision,
    sourceActionId: request.sourceActionId,
    execution: structuredClone(request.execution),
    plan: structuredClone(request.plan),
    operations,
    confirmation: structuredClone(request.confirmation),
    events: [],
    cleanup: {
      status: "pending",
      entries: cleanupEntriesForOperations(operations),
    },
    recovery: { status: "none", crashBoundaries: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function receiptRelativePath(receiptHash: string): string {
  return `${WORKFLOW_FINALIZATION_RECEIPT_DIRECTORY}/${receiptHash}.json`;
}

function receiptReference(
  receipt: WorkflowFinalizationReceipt,
): WorkflowFinalizationReceiptReference {
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt-reference",
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    transactionId: receipt.transactionId,
    planHash: receipt.planHash,
    runId: receipt.runId,
    revision: receipt.revision,
    resultingRevision: receipt.resultingRevision,
    status:
      receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed",
  };
}

export function workflowFinalizationReceiptReference(
  receipt: WorkflowFinalizationReceipt,
): WorkflowFinalizationReceiptReference {
  return receiptReference(receipt);
}

function receiptOperation(
  operation: WorkflowFinalizationTransactionOperation,
  status: "committed" | "rolled-back",
): WorkflowFinalizationOperationReceipt {
  const precondition = operation.precondition;
  const expectedPostState = operation.expectedPostState;
  return {
    id: operation.id,
    kind: operation.kind,
    source: operation.source,
    target: operation.target,
    stagedPath: operation.stagedPath,
    backupPath: operation.backupPath,
    quarantinePath: operation.quarantinePath,
    precondition: structuredClone(precondition),
    expectedPostState: structuredClone(expectedPostState),
    observedPostState:
      status === "committed"
        ? structuredClone(expectedPostState)
        : structuredClone(precondition),
    status,
  };
}

function buildFinalizationReceipt(
  transaction: WorkflowFinalizationTransaction,
  status: "committed" | "rolled-back",
): WorkflowFinalizationReceipt {
  const base = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt" as const,
    transactionId: transaction.transactionId,
    runId: transaction.runId,
    revision: transaction.revision,
    resultingRevision: transaction.resultingRevision,
    planHash: transaction.plan.planHash,
    execution: structuredClone(transaction.execution),
    contentSnapshotHash: transaction.plan.contentSnapshotHash,
    verificationReceiptIds: [...transaction.plan.verificationReceiptIds],
    confirmation: structuredClone(transaction.confirmation),
    operations: transaction.operations.map((operation) =>
      receiptOperation(operation, status),
    ),
    events: structuredClone(transaction.events),
    cleanup: structuredClone(transaction.cleanup),
    recovery: structuredClone(transaction.recovery),
    committedAt: transaction.createdAt,
  };
  const receiptId = `workflow-finalization-receipt-${sha256(
    JSON.stringify(stableValue(base)),
  ).slice(0, 24)}`;
  const withId = { ...base, receiptId };
  const receiptHash = sha256(JSON.stringify(stableValue(withId)));
  return { ...withId, receiptHash };
}

async function publishReceipt(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  receipt: WorkflowFinalizationReceipt,
): Promise<void> {
  const serialized = `${JSON.stringify(stableValue(receipt), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > receiptMaxBytes(profile)) {
    throw new Error(
      "Workflow finalization receipt exceeds its configured bound",
    );
  }
  const relative = receiptRelativePath(receipt.receiptHash);
  const existing = await readOptionalEngineRunText(
    runRoot,
    relative,
    receiptMaxBytes(profile),
    "Workflow finalization receipt",
  );
  if (existing !== null) {
    const parsed = parseFinalizationReceipt(JSON.parse(existing) as unknown);
    if (!sameStableValue(parsed, receipt)) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
    return;
  }
  try {
    await writeEngineRunText(
      runRoot,
      relative,
      serialized,
      receiptMaxBytes(profile),
      "Workflow finalization receipt",
      { exclusive: true, maxBytes: receiptMaxBytes(profile) },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readOptionalEngineRunText(
      runRoot,
      relative,
      receiptMaxBytes(profile),
      "Workflow finalization receipt",
    );
    if (
      raced === null ||
      !sameStableValue(parseFinalizationReceipt(JSON.parse(raced)), receipt)
    ) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
  }
}

async function completeFinalizationCleanup(
  runRoot: string,
  baseRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
): Promise<WorkflowFinalizationReceipt> {
  if (
    transaction.cleanup.status === "completed" &&
    transaction.receipt?.cleanup.status === "completed"
  ) {
    for (const entry of transaction.cleanup.entries) {
      const current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile),
      );
      if (current.identity.exists) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
    }
    return transaction.receipt;
  }
  if (
    !hasTransactionEvent(transaction, "cleanup-started", null, "before-cleanup")
  ) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-started",
      { phase: "before-cleanup" },
      null,
    );
  }
  for (const entry of transaction.cleanup.entries) {
    if (entry.status !== "pending") continue;
    const operation = transaction.operations.find(
      (candidate) => candidate.id === entry.operationId,
    );
    if (!operation) {
      throw new WorkflowFinalizationConflictError([entry.path]);
    }
    const beforeCleanup = {
      phase: "cleanup-item" as const,
      operationId: entry.operationId,
      path: entry.path,
    };
    if (
      !hasTransactionPathEvent(
        transaction,
        "cleanup-item",
        entry.operationId,
        "cleanup-item",
        entry.path,
      )
    ) {
      await appendTransactionEvent(
        runRoot,
        profile,
        transaction,
        "cleanup-item",
        beforeCleanup,
        entry.operationId,
      );
    }
    let current: {
      identity: WorkflowFinalizationMaterialIdentity;
      content: string | null;
    };
    try {
      current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile),
      );
    } catch (error) {
      throw error;
    }
    if (!current.identity.exists) {
      if (!cleanupMissingIsExpected(transaction, entry)) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      entry.status = "missing";
    } else {
      if (!sameIdentity(current.identity, entry.expected)) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      await removeBaseFile(baseRoot, entry.path, async () => {
        const latest = await readMaterial(
          baseRoot,
          entry.path,
          contentMaxBytes(profile),
        );
        if (!sameIdentity(latest.identity, entry.expected)) {
          throw new WorkflowFinalizationConflictError([entry.path]);
        }
      });
      const verified = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile),
      );
      if (verified.identity.exists) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      entry.status = "cleaned";
    }
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-item",
      { phase: "cleaned", operationId: entry.operationId, path: entry.path },
      entry.operationId,
    );
  }
  for (const entry of transaction.cleanup.entries) {
    let current: {
      identity: WorkflowFinalizationMaterialIdentity;
      content: string | null;
    };
    try {
      current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile),
      );
    } catch (error) {
      throw error;
    }
    if (current.identity.exists) {
      throw new WorkflowFinalizationConflictError([entry.path]);
    }
  }
  if (!hasTransactionEvent(transaction, "cleanup-completed", null, "cleaned")) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-completed",
      { phase: "cleaned" },
      null,
    );
  }
  transaction.cleanup.status = "completed";
  if (!hasTransactionEvent(transaction, "receipt-written", null, "cleaned")) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "receipt-written",
      { phase: "cleaned" },
      null,
    );
  }
  const receipt = buildFinalizationReceipt(
    transaction,
    transaction.status === "rolled-back" ? "rolled-back" : "committed",
  );
  await publishReceipt(runRoot, profile, receipt);
  transaction.receipt = receipt;
  await writeTransaction(runRoot, profile, transaction);
  return receipt;
}

export async function readWorkflowFinalizationReceipt(
  runRoot: string,
  receiptHash: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowFinalizationReceipt | null> {
  const hash = boundedHash(receiptHash, "Workflow finalization receipt hash");
  const raw = await readOptionalEngineRunText(
    runRoot,
    receiptRelativePath(hash),
    receiptMaxBytes(profile),
    "Workflow finalization receipt",
  );
  if (raw === null) return null;
  try {
    const receipt = parseFinalizationReceipt(JSON.parse(raw) as unknown);
    if (receipt.receiptHash !== hash) {
      throw new Error(
        "Workflow finalization receipt hash does not match its path",
      );
    }
    if (Buffer.byteLength(raw, "utf8") > receiptMaxBytes(profile)) {
      throw new Error(
        "Workflow finalization receipt exceeds its configured bound",
      );
    }
    return receipt;
  } catch (error) {
    throw new Error("Workflow finalization receipt is malformed", {
      cause: error,
    });
  }
}

async function createOperationMaterials(
  request: WorkflowFinalizationApplyRequest,
): Promise<WorkflowFinalizationTransactionOperation[]> {
  const operations = await createTransactionOperations(request);
  if (
    operations.length >
    profileBound(request.profile, "finalizationOperationCount")
  ) {
    throw new Error(
      "Workflow finalization operation count exceeds its configured bound",
    );
  }
  return operations;
}

function transactionAffectedPaths(
  transaction: WorkflowFinalizationTransaction,
): string[] {
  return uniqueStrings(
    transaction.operations.flatMap((operation) => [
      operation.target,
      ...(operation.source ? [operation.source] : []),
      ...(operation.stagedPath ? [operation.stagedPath] : []),
      ...(operation.backupPath ? [operation.backupPath] : []),
      ...(operation.quarantinePath ? [operation.quarantinePath] : []),
    ]),
  );
}

function recoveryBlocked(
  transaction: WorkflowFinalizationTransaction,
  error: unknown,
): WorkflowFinalizationRecoveryResult {
  if (
    error instanceof WorkflowFinalizationInjectedFaultError ||
    (error instanceof Error &&
      error.message === "deterministic workflow finalization fault")
  ) {
    throw error;
  }
  if (error instanceof WorkflowFinalizationConflictError) {
    return {
      status: "blocked",
      transaction,
      unknownPaths: [...error.paths],
    };
  }
  if (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR" ||
      /crosses a symbolic link|must be a real (?:file|directory|any)|not a regular file|not valid UTF-8|resolves outside the project root/u.test(
        error.message,
      ))
  ) {
    return {
      status: "blocked",
      transaction,
      unknownPaths: transactionAffectedPaths(transaction),
    };
  }
  throw error;
}

async function applyTransaction(
  runRoot: string,
  baseRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
  recovery: boolean,
): Promise<void> {
  if (transaction.status === "prepared") {
    transaction.status = "applying";
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "applying",
      { phase: "applying" },
      null,
    );
  }
  for (const operation of transaction.operations) {
    await applyTransactionOperation(
      runRoot,
      baseRoot,
      profile,
      transaction,
      operation,
      recovery,
    );
  }
}

async function commitTransaction(
  runRoot: string,
  baseRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
): Promise<WorkflowFinalizationReceipt> {
  if (transaction.status === "rolled-back") {
    if (!transaction.receipt) {
      throw new Error("Workflow finalization rollback receipt is missing");
    }
    return transaction.receipt;
  }
  if (transaction.status !== "committed") {
    const current = await Promise.all(
      transaction.operations.map((operation) =>
        currentOperation(baseRoot, operation, profile),
      ),
    );
    if (
      current.some(
        (material, index) =>
          !operationMatches(
            material,
            transaction.operations[index].expectedPostState,
          ),
      )
    ) {
      throw new WorkflowFinalizationConflictError(
        transaction.operations.flatMap((operation) => [
          operation.target,
          ...(operation.source ? [operation.source] : []),
        ]),
      );
    }
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committing",
      { phase: "committing" },
      null,
    );
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committing",
      { phase: "before-receipt" },
      null,
    );
    const receipt =
      transaction.recovery.status === "recovered"
        ? buildFinalizationReceipt(transaction, "committed")
        : (transaction.receipt ??
          buildFinalizationReceipt(transaction, "committed"));
    await publishReceipt(runRoot, profile, receipt);
    transaction.receipt = receipt;
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "receipt-written",
      { phase: "receipt-written" },
      null,
    );
    transaction.status = "committed";
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committed",
      { phase: "committed" },
      null,
    );
  }
  if (!transaction.receipt) {
    throw new Error(
      "Workflow finalization committed transaction has no receipt",
    );
  }
  return transaction.receipt;
}

function validateApplyRequest(
  request: WorkflowFinalizationApplyRequest,
): WorkflowFinalizationPreview {
  const plan = parseWorkflowFinalizationPreview(request.plan);
  if (request.sourceActionId.length === 0) {
    throw new WorkflowFinalizationConflictError(["sourceActionId"]);
  }
  if (!sameStableValue(plan.execution, request.execution)) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (plan.actionId !== request.sourceActionId) {
    throw new WorkflowFinalizationConflictError(["actionId"]);
  }
  if (!plan.requiresConfirmation || !request.confirmation) {
    throw new WorkflowFinalizationConflictError(["confirmation"]);
  }
  const expectedResultingRevision = request.confirmation.revision + 1;
  if (request.resultingRevision !== expectedResultingRevision) {
    throw new WorkflowFinalizationConflictError(["resultingRevision"]);
  }
  if (
    request.confirmation.planHash !== plan.planHash ||
    request.confirmation.revision !== plan.revision + 1 ||
    request.confirmation.sourceActionId !== request.sourceActionId
  ) {
    throw new WorkflowFinalizationConflictError(["confirmation"]);
  }
  return plan;
}

export async function applyWorkflowFinalization(
  request: WorkflowFinalizationApplyRequest,
): Promise<WorkflowFinalizationApplyResult> {
  const plan = validateApplyRequest(request);
  const normalizedDefinition = normalizeWorkflowFinalizationDefinition(
    request.definition,
  );
  validateWorkflowFinalizationPlanDeclaration(plan, normalizedDefinition);
  const existing = await readWorkflowFinalizationTransaction(
    request.runRoot,
    request.profile,
  );
  if (existing) {
    if (!transactionMatchesRequest(existing, { ...request, plan })) {
      throw new WorkflowFinalizationTransactionPendingError(existing);
    }
    if (existing.status === "committed") {
      if (!existing.receipt)
        throw new Error("Workflow finalization receipt is missing");
      const receipt = await completeFinalizationCleanup(
        request.runRoot,
        request.baseRoot,
        request.profile,
        existing,
      );
      return {
        status: "committed",
        transaction: existing,
        receipt,
      };
    }
    if (existing.status === "rolled-back") {
      if (!existing.receipt)
        throw new Error("Workflow finalization rollback receipt is missing");
      const receipt = await completeFinalizationCleanup(
        request.runRoot,
        request.baseRoot,
        request.profile,
        existing,
      );
      return {
        status: "rolled-back",
        transaction: existing,
        receipt,
      };
    }
    throw new WorkflowFinalizationTransactionPendingError(existing);
  }
  const operations = await createOperationMaterials({ ...request, plan });
  const transaction = newTransaction(
    {
      ...request,
      plan: structuredClone(plan),
      definition: normalizedDefinition,
    },
    operations,
  );
  await appendTransactionEvent(
    request.runRoot,
    request.profile,
    transaction,
    "prepared",
    { phase: "prepared" },
    null,
  );
  await applyTransaction(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction,
    false,
  );
  await commitTransaction(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction,
  );
  const receipt = await completeFinalizationCleanup(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction,
  );
  return { status: "committed", transaction, receipt };
}

export async function recoverWorkflowFinalization(options: {
  runRoot: string;
  baseRoot: string;
  profile: WorkflowDurabilityProfile;
  execution?: RuntimeIdentity;
  runId?: string;
  definition?: WorkflowFinalizationDefinition;
}): Promise<WorkflowFinalizationRecoveryResult> {
  const transaction = await readWorkflowFinalizationTransaction(
    options.runRoot,
    options.profile,
  );
  if (!transaction) return { status: "none" };
  if (options.definition) {
    validateWorkflowFinalizationPlanDeclaration(
      transaction.plan,
      options.definition,
    );
  }
  if (options.runId !== undefined && transaction.runId !== options.runId) {
    throw new WorkflowFinalizationConflictError(["runId"]);
  }
  if (
    options.execution !== undefined &&
    !sameStableValue(transaction.execution, options.execution)
  ) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (transaction.status === "committed") {
    if (!transaction.receipt)
      throw new Error("Workflow finalization committed receipt is missing");
    let current: OperationMaterial[];
    try {
      current = await Promise.all(
        transaction.operations.map((operation) =>
          currentOperation(options.baseRoot, operation, options.profile),
        ),
      );
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
    const unknown = current.flatMap((material, index) =>
      operationMatches(
        material,
        transaction.operations[index].expectedPostState,
      )
        ? []
        : [
            transaction.operations[index].target,
            ...(transaction.operations[index].source
              ? [transaction.operations[index].source!]
              : []),
          ],
    );
    if (unknown.length > 0) {
      return {
        status: "blocked",
        transaction,
        unknownPaths: uniqueStrings(unknown),
      };
    }
    try {
      if (
        transaction.cleanup.status !== "completed" ||
        transaction.receipt.cleanup.status !== "completed"
      ) {
        transaction.recovery = {
          status: "recovered",
          crashBoundaries: uniqueStrings(
            transaction.events.map((event) => event.boundary),
          ),
        };
        await writeTransaction(options.runRoot, options.profile, transaction);
      }
      const receipt = await completeFinalizationCleanup(
        options.runRoot,
        options.baseRoot,
        options.profile,
        transaction,
      );
      return { status: "recovered", transaction, receipt };
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  if (transaction.status === "rolling-back") {
    return rollbackWorkflowFinalization(options);
  }
  if (transaction.status === "rolled-back") {
    try {
      const receipt = await completeFinalizationCleanup(
        options.runRoot,
        options.baseRoot,
        options.profile,
        transaction,
      );
      return { status: "rolled-back", transaction, receipt };
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  transaction.recovery = {
    status: "recovered",
    crashBoundaries: uniqueStrings(
      transaction.events.map((event) => event.boundary),
    ),
  };
  try {
    await applyTransaction(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
      true,
    );
    await commitTransaction(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
    );
    const receipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
    );
    return { status: "recovered", transaction, receipt };
  } catch (error) {
    return recoveryBlocked(transaction, error);
  }
}

async function restoreContent(
  root: string,
  relative: string,
  content: string | null,
  expectedCurrent: WorkflowFinalizationMaterialIdentity,
  profile: WorkflowDurabilityProfile,
): Promise<void> {
  const verifyCurrent = async () => {
    const current = await readMaterial(
      root,
      relative,
      contentMaxBytes(profile),
    );
    if (!sameIdentity(current.identity, expectedCurrent)) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
  };
  if (content === null) {
    await removeBaseFile(root, relative, verifyCurrent);
    return;
  }
  await writeBaseText(
    root,
    relative,
    content,
    contentMaxBytes(profile),
    verifyCurrent,
  );
}

function cleanupMissingIsExpectedFor(
  operations: ReadonlyArray<{
    id: string;
    kind: "write" | "remove" | "move";
    status: string;
  }>,
  events: ReadonlyArray<{
    type: WorkflowFinalizationEventType;
    operationId: string | null;
    boundary: string;
  }>,
  entry: WorkflowFinalizationCleanupEntry,
): boolean {
  const operation = operations.find(
    (candidate) => candidate.id === entry.operationId,
  );
  if (!operation) return false;
  if (
    operation.status === "rolled-back" &&
    events.some(
      (event) =>
        event.type === "operation-rolled-back" &&
        event.operationId === operation.id &&
        event.boundary.startsWith("rollback-verified"),
    )
  ) {
    return true;
  }
  if (
    entry.role === "staged" &&
    operation.kind === "write" &&
    events.some(
      (event) =>
        event.type === "operation-published" &&
        event.operationId === operation.id &&
        event.boundary.startsWith("target-published"),
    )
  ) {
    return true;
  }
  return (
    entry.role === "quarantine" &&
    operation.kind === "move" &&
    events.some(
      (event) =>
        event.type === "operation-published" &&
        event.operationId === operation.id &&
        event.boundary.startsWith("target-published"),
    )
  );
}

function cleanupMissingIsExpected(
  transaction: WorkflowFinalizationTransaction,
  entry: WorkflowFinalizationCleanupEntry,
): boolean {
  return cleanupMissingIsExpectedFor(
    transaction.operations,
    transaction.events,
    entry,
  );
}

async function rollbackTransactionOperation(
  baseRoot: string,
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
  profile: WorkflowDurabilityProfile,
): Promise<void> {
  if (operation.kind === "write") {
    if (operationMatches(actual, operation.precondition)) return;
    await restoreContent(
      baseRoot,
      operation.target,
      operation.previousTargetContent,
      actual.target.identity,
      profile,
    );
    return;
  }
  if (operation.kind === "remove") {
    if (!operation.precondition.target.exists) return;
    if (!operation.quarantinePath || actual.target.identity.exists) {
      if (!actual.target.identity.exists) {
        throw new WorkflowFinalizationConflictError([
          operation.target,
          ...(operation.quarantinePath ? [operation.quarantinePath] : []),
        ]);
      }
      return;
    }
    const moved = await moveBaseFile(
      baseRoot,
      operation.quarantinePath,
      operation.target,
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          current.target.identity.exists ||
          !current.quarantine?.identity.exists ||
          !sameIdentity(
            current.quarantine.identity,
            materialIdentity(operation.previousTargetContent!),
          )
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          !sameIdentity(
            current.target.identity,
            operationTargetExpected(operation),
          ) ||
          !storageMatchesContent(
            current,
            "quarantine",
            operation.previousTargetContent!,
          )
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation.quarantinePath,
        operation.target,
      ]);
    }
    return;
  }
  if (!operation.source || !actual.source) {
    throw new WorkflowFinalizationConflictError([operation.target]);
  }
  const sourcePre = sameIdentity(
    actual.source.identity,
    operationSourceExpected(operation),
  );
  const sourcePost = sameIdentity(
    actual.source.identity,
    operationPostSourceExpected(operation),
  );
  const targetPre = sameIdentity(
    actual.target.identity,
    operationTargetExpected(operation),
  );
  const targetPost = sameIdentity(
    actual.target.identity,
    operationPostTargetExpected(operation),
  );
  if (sourcePre && targetPre) return;
  if (sourcePost && targetPre) {
    if (!operation.quarantinePath) {
      throw new WorkflowFinalizationConflictError([
        operation.source,
        operation.target,
      ]);
    }
    const moved = await moveBaseFile(
      baseRoot,
      operation.quarantinePath,
      operation.source,
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          current.source?.identity.exists ||
          !sameIdentity(
            current.target.identity,
            operationTargetExpected(operation),
          ) ||
          !current.quarantine?.identity.exists
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          !current.source ||
          !sameIdentity(
            current.source.identity,
            operationSourceExpected(operation),
          ) ||
          !sameIdentity(
            current.target.identity,
            operationTargetExpected(operation),
          ) ||
          !storageMatchesContent(
            current,
            "quarantine",
            operation.previousSourceContent!,
          )
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation.quarantinePath,
        operation.source,
      ]);
    }
    return;
  }
  if (sourcePost && targetPost) {
    const moved = await moveBaseFile(
      baseRoot,
      operation.target,
      operation.source,
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          current.source?.identity.exists ||
          !sameIdentity(
            current.target.identity,
            operationPostTargetExpected(operation),
          )
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          !current.source ||
          !sameIdentity(
            current.source.identity,
            operationSourceExpected(operation),
          ) ||
          !sameIdentity(
            current.target.identity,
            operationPostTargetExpected(operation),
          )
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      },
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation.target,
        operation.source,
      ]);
    }
    if (operation.precondition.target.exists) {
      if (!operation.backupPath) {
        throw new WorkflowFinalizationConflictError([operation.target]);
      }
      const restored = await moveBaseFile(
        baseRoot,
        operation.backupPath,
        operation.target,
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            current.target.identity.exists ||
            !current.backup?.identity.exists ||
            !current.source?.identity.exists
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !current.source ||
            !sameIdentity(
              current.source.identity,
              operationSourceExpected(operation),
            ) ||
            !sameIdentity(
              current.target.identity,
              operationTargetExpected(operation),
            ) ||
            !storageMatchesContent(
              current,
              "backup",
              operation.previousTargetContent!,
            )
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
      );
      if (!restored) {
        throw new WorkflowFinalizationConflictError([
          operation.backupPath,
          operation.target,
        ]);
      }
    }
    return;
  }
  if (sourcePre && targetPost) {
    throw new WorkflowFinalizationConflictError([
      operation.source,
      operation.target,
    ]);
  }
  throw new WorkflowFinalizationConflictError([
    operation.source,
    operation.target,
  ]);
}

export async function rollbackWorkflowFinalization(options: {
  runRoot: string;
  baseRoot: string;
  profile: WorkflowDurabilityProfile;
  execution?: RuntimeIdentity;
  runId?: string;
  definition?: WorkflowFinalizationDefinition;
}): Promise<WorkflowFinalizationRecoveryResult> {
  const transaction = await readWorkflowFinalizationTransaction(
    options.runRoot,
    options.profile,
  );
  if (!transaction) return { status: "none" };
  if (options.definition) {
    validateWorkflowFinalizationPlanDeclaration(
      transaction.plan,
      options.definition,
    );
  }
  if (options.runId !== undefined && transaction.runId !== options.runId) {
    throw new WorkflowFinalizationConflictError(["runId"]);
  }
  if (
    options.execution !== undefined &&
    !sameStableValue(transaction.execution, options.execution)
  ) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (transaction.status === "rolled-back") {
    const receipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
    );
    return { status: "rolled-back", transaction, receipt };
  }
  if (transaction.status === "committed") {
    return {
      status: "blocked",
      transaction,
      unknownPaths: [WORKFLOW_FINALIZATION_TRANSACTION_PATH],
    };
  }
  transaction.status = "rolling-back";
  await appendTransactionEvent(
    options.runRoot,
    options.profile,
    transaction,
    "rolling-back",
    { phase: "rolling-back" },
    null,
  );
  for (const operation of [...transaction.operations].reverse()) {
    try {
      const actual = await currentOperation(
        options.baseRoot,
        operation,
        options.profile,
      );
      if (!operationCanResume(operation, actual)) {
        return {
          status: "blocked",
          transaction,
          unknownPaths: operationConflictPaths(operation, actual),
        };
      }
      if (
        operation.status === "rolled-back" &&
        operationMatches(actual, operation.precondition)
      ) {
        continue;
      }
      if (
        !hasTransactionEvent(
          transaction,
          "operation-rolled-back",
          operation.id,
          "before-rollback-operation",
        )
      ) {
        await appendTransactionEvent(
          options.runRoot,
          options.profile,
          transaction,
          "operation-rolled-back",
          {
            phase: "before-rollback-operation",
            operationId: operation.id,
            path: operation.target,
          },
          operation.id,
        );
      }
      await rollbackTransactionOperation(
        options.baseRoot,
        operation,
        actual,
        options.profile,
      );
      const verified = await currentOperation(
        options.baseRoot,
        operation,
        options.profile,
      );
      if (!operationMatches(verified, operation.precondition)) {
        throw new WorkflowFinalizationConflictError([
          operation.target,
          ...(operation.source ? [operation.source] : []),
        ]);
      }
      operation.status = "rolled-back";
      await appendTransactionEvent(
        options.runRoot,
        options.profile,
        transaction,
        "operation-rolled-back",
        {
          phase: "rollback-verified",
          operationId: operation.id,
          path: operation.target,
        },
        operation.id,
      );
      await appendTransactionEvent(
        options.runRoot,
        options.profile,
        transaction,
        "operation-rolled-back",
        {
          phase: "rolled-back",
          operationId: operation.id,
          path: operation.target,
        },
        operation.id,
      );
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  transaction.recovery = {
    status: "rolled-back",
    crashBoundaries: uniqueStrings(
      transaction.events.map((event) => event.boundary),
    ),
  };
  try {
    await appendTransactionEvent(
      options.runRoot,
      options.profile,
      transaction,
      "rolling-back",
      { phase: "before-receipt" },
      null,
    );
    const receipt = buildFinalizationReceipt(transaction, "rolled-back");
    await publishReceipt(options.runRoot, options.profile, receipt);
    transaction.receipt = receipt;
    transaction.status = "rolled-back";
    await appendTransactionEvent(
      options.runRoot,
      options.profile,
      transaction,
      "rolled-back",
      { phase: "rolled-back" },
      null,
    );
    const finalReceipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
    );
    return {
      status: "rolled-back",
      transaction,
      receipt: finalReceipt,
    };
  } catch (error) {
    return recoveryBlocked(transaction, error);
  }
}

export async function clearWorkflowFinalizationTransaction(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  baseRoot?: string,
): Promise<boolean> {
  const transaction = await readWorkflowFinalizationTransaction(
    runRoot,
    profile,
  );
  if (!transaction) return false;
  if (
    (transaction.status !== "committed" &&
      transaction.status !== "rolled-back") ||
    !transaction.receipt
  ) {
    throw new WorkflowFinalizationTransactionPendingError(transaction);
  }
  const receipt = transaction.receipt;
  if (baseRoot) {
    await completeFinalizationCleanup(runRoot, baseRoot, profile, transaction);
  }
  if (
    transaction.cleanup.status !== "completed" ||
    transaction.receipt.cleanup.status !== "completed"
  ) {
    throw new WorkflowFinalizationTransactionPendingError(transaction);
  }
  const removed = await removeEngineRunFile(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    "Workflow finalization transaction",
    {
      beforeRemove: async () => {
        const current = await readWorkflowFinalizationTransaction(
          runRoot,
          profile,
        );
        if (
          !current ||
          current.transactionId !== transaction.transactionId ||
          current.status !== transaction.status ||
          !current.receipt ||
          current.receipt.receiptHash !== receipt.receiptHash
        ) {
          throw new WorkflowFinalizationConflictError([
            WORKFLOW_FINALIZATION_TRANSACTION_PATH,
          ]);
        }
      },
    },
  );
  if (removed) await invokeFault({ phase: "cleared" });
  return removed;
}

async function ensureContentFile(
  root: string,
  relative: string,
  content: string,
  profile: WorkflowDurabilityProfile,
): Promise<void> {
  const expected = materialIdentity(content);
  const current = await readMaterial(root, relative, contentMaxBytes(profile));
  if (sameIdentity(current.identity, expected)) return;
  if (current.identity.exists) {
    throw new WorkflowFinalizationConflictError([relative]);
  }
  await writeBaseText(root, relative, content, contentMaxBytes(profile));
  const verified = await readMaterial(root, relative, contentMaxBytes(profile));
  if (!sameIdentity(verified.identity, expected)) {
    throw new WorkflowFinalizationConflictError([relative]);
  }
}

async function currentOperation(
  root: string,
  operation: WorkflowFinalizationTransactionOperation,
  profile: WorkflowDurabilityProfile,
): Promise<OperationMaterial> {
  return operationMaterial(root, operation, contentMaxBytes(profile));
}

function operationCanResume(
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
  allowDurableContent = false,
): boolean {
  return (
    operationStorageUnknownPaths(operation, actual).length === 0 &&
    operationProgress(operation, actual) !== null &&
    operationStorageMissingRequiredPaths(operation, actual, allowDurableContent)
      .length === 0
  );
}

function operationStorageMissingRequiredPaths(
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
  allowDurableContent = false,
): string[] {
  const missing: string[] = [];
  const has = (role: "staged" | "backup" | "quarantine") =>
    actual[role]?.identity.exists === true;
  const progress = operationProgress(operation, actual);
  if (
    operation.kind === "write" &&
    progress === "post" &&
    operation.precondition.target.exists &&
    !has("backup")
  ) {
    if (operation.backupPath) missing.push(operation.backupPath);
  }
  if (
    operation.kind === "remove" &&
    progress === "post" &&
    operation.precondition.target.exists &&
    !has("quarantine")
  ) {
    if (operation.quarantinePath) missing.push(operation.quarantinePath);
  }
  if (
    operation.kind === "move" &&
    progress === "source-quarantined" &&
    !allowDurableContent &&
    !has("quarantine")
  ) {
    if (operation.quarantinePath) missing.push(operation.quarantinePath);
  }
  if (
    operation.kind === "move" &&
    progress === "post" &&
    operation.precondition.target.exists &&
    !has("backup")
  ) {
    if (operation.backupPath) missing.push(operation.backupPath);
  }
  return missing;
}

function operationConflictPaths(
  operation: WorkflowFinalizationTransactionOperation,
  actual: OperationMaterial,
): string[] {
  return uniqueStrings([
    ...operationStorageUnknownPaths(operation, actual),
    ...operationStorageMissingRequiredPaths(operation, actual),
    operation.target,
    ...(operation.source ? [operation.source] : []),
  ]);
}

function hasTransactionEvent(
  transaction: WorkflowFinalizationTransaction,
  type: WorkflowFinalizationEventType,
  operationId: string | null,
  boundary: WorkflowFinalizationBoundaryPhase,
): boolean {
  return transaction.events.some(
    (event) =>
      event.type === type &&
      event.operationId === operationId &&
      event.boundary.startsWith(boundary),
  );
}

function hasTransactionPathEvent(
  transaction: WorkflowFinalizationTransaction,
  type: WorkflowFinalizationEventType,
  operationId: string,
  phase: WorkflowFinalizationBoundaryPhase,
  relativePath: string,
): boolean {
  return transaction.events.some(
    (event) =>
      event.type === type &&
      event.operationId === operationId &&
      event.boundary === `${phase}:${relativePath}`,
  );
}

async function readValidatedOperation(
  baseRoot: string,
  operation: WorkflowFinalizationTransactionOperation,
  profile: WorkflowDurabilityProfile,
): Promise<OperationMaterial> {
  const actual = await currentOperation(baseRoot, operation, profile);
  if (!operationCanResume(operation, actual)) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation, actual),
    );
  }
  return actual;
}

async function appendOperationEvent(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
  operation: WorkflowFinalizationTransactionOperation,
  type: WorkflowFinalizationEventType,
  phase: WorkflowFinalizationBoundaryPhase,
  path: string,
): Promise<void> {
  await appendTransactionEvent(
    runRoot,
    profile,
    transaction,
    type,
    { phase, operationId: operation.id, path },
    operation.id,
  );
}

async function applyTransactionOperation(
  runRoot: string,
  baseRoot: string,
  profile: WorkflowDurabilityProfile,
  transaction: WorkflowFinalizationTransaction,
  operation: WorkflowFinalizationTransactionOperation,
  recovery: boolean,
): Promise<void> {
  let actual = await readValidatedOperation(baseRoot, operation, profile);
  let progress = operationProgress(operation, actual);
  if (progress === null) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation, actual),
    );
  }
  if (progress === "post") {
    operation.status = "verified";
  } else if (
    operation.status === "pending" ||
    operation.status === "applying"
  ) {
    if (
      !hasTransactionEvent(
        transaction,
        "operation-staged",
        operation.id,
        "before-staging",
      )
    ) {
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation,
        "operation-staged",
        "before-staging",
        operation.target,
      );
    }
    if (operation.previousTargetContent !== null && operation.backupPath) {
      await ensureContentFile(
        baseRoot,
        operation.backupPath,
        operation.previousTargetContent,
        profile,
      );
    }
    if (operation.content !== null && operation.stagedPath) {
      await ensureContentFile(
        baseRoot,
        operation.stagedPath,
        operation.content,
        profile,
      );
    }
    operation.status = "staged";
    if (
      !hasTransactionEvent(
        transaction,
        "operation-staged",
        operation.id,
        "staged",
      )
    ) {
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation,
        "operation-staged",
        "staged",
        operation.target,
      );
    }
    actual = await readValidatedOperation(baseRoot, operation, profile);
    progress = operationProgress(operation, actual);
  }
  if (
    !hasTransactionEvent(
      transaction,
      "operation-started",
      operation.id,
      "before-operation",
    )
  ) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation,
      "operation-started",
      "before-operation",
      operation.target,
    );
  }
  actual = await readValidatedOperation(baseRoot, operation, profile);
  progress = operationProgress(operation, actual);
  if (progress === null) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation, actual),
    );
  }
  if (operation.kind === "write" && progress !== "post") {
    if (operation.content === null || !operation.stagedPath) {
      throw new Error("Workflow finalization write staging is missing");
    }
    if (
      !sameIdentity(
        actual.target.identity,
        operationPostTargetExpected(operation),
      )
    ) {
      if (
        !hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation.id,
          "before-target-removal",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-quarantined",
          "before-target-removal",
          operation.target,
        );
      }
      await removeBaseFile(baseRoot, operation.target, async () => {
        const current = await currentOperation(baseRoot, operation, profile);
        if (
          !operationMatches(current, operation.precondition) ||
          !current.staged?.identity.exists ||
          (operation.backupPath &&
            operation.precondition.target.exists &&
            !current.backup?.identity.exists)
        ) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation, current),
          );
        }
      });
      if (
        !hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation.id,
          "target-removed",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-quarantined",
          "target-removed",
          operation.target,
        );
      }
      actual = await readValidatedOperation(baseRoot, operation, profile);
    }
    actual = await readValidatedOperation(baseRoot, operation, profile);
    if (!actual.target.identity.exists && actual.staged?.identity.exists) {
      if (
        !hasTransactionEvent(
          transaction,
          "operation-published",
          operation.id,
          "before-target-publication",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-published",
          "before-target-publication",
          operation.target,
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation.stagedPath,
        operation.target,
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            current.target.identity.exists ||
            !current.staged?.identity.exists ||
            (operation.backupPath &&
              operation.precondition.target.exists &&
              !current.backup?.identity.exists)
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !sameIdentity(
              current.target.identity,
              operationPostTargetExpected(operation),
            ) ||
            !storageMatchesContent(current, "staged", operation.content!) ||
            (operation.backupPath &&
              operation.precondition.target.exists &&
              !storageMatchesContent(
                current,
                "backup",
                operation.previousTargetContent!,
              ))
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation.stagedPath,
          operation.target,
        ]);
      }
      operation.status = "target-published";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation,
        "operation-published",
        "target-published",
        operation.target,
      );
    }
  } else if (operation.kind === "remove" && progress !== "post") {
    if (operation.precondition.target.exists) {
      if (!operation.quarantinePath) {
        throw new Error("Workflow finalization remove quarantine is missing");
      }
      actual = await currentOperation(baseRoot, operation, profile);
      if (!actual.quarantine?.identity.exists) {
        if (
          !hasTransactionEvent(
            transaction,
            "operation-quarantined",
            operation.id,
            "before-quarantine",
          )
        ) {
          await appendOperationEvent(
            runRoot,
            profile,
            transaction,
            operation,
            "operation-quarantined",
            "before-quarantine",
            operation.target,
          );
        }
        const moved = await moveBaseFile(
          baseRoot,
          operation.target,
          operation.quarantinePath,
          async () => {
            const current = await currentOperation(
              baseRoot,
              operation,
              profile,
            );
            if (
              !operationMatches(current, operation.precondition) ||
              current.quarantine?.identity.exists
            ) {
              throw new WorkflowFinalizationConflictError(
                operationConflictPaths(operation, current),
              );
            }
          },
          async () => {
            const current = await currentOperation(
              baseRoot,
              operation,
              profile,
            );
            if (
              !operationMatches(current, operation.precondition) ||
              !storageMatchesContent(
                current,
                "quarantine",
                operation.previousTargetContent!,
              )
            ) {
              throw new WorkflowFinalizationConflictError(
                operationConflictPaths(operation, current),
              );
            }
          },
        );
        if (!moved) {
          throw new WorkflowFinalizationConflictError([
            operation.target,
            operation.quarantinePath,
          ]);
        }
      } else {
        await removeBaseFile(baseRoot, operation.target, async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !operationMatches(current, operation.precondition) ||
            !current.quarantine?.identity.exists
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        });
      }
      operation.status = "target-quarantined";
      if (
        !hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation.id,
          "quarantined",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-quarantined",
          "quarantined",
          operation.target,
        );
      }
    }
  } else if (operation.kind === "move" && progress !== "post") {
    if (
      operation.content === null ||
      !operation.source ||
      !operation.quarantinePath
    ) {
      throw new Error("Workflow finalization move quarantine is missing");
    }
    actual = await currentOperation(baseRoot, operation, profile);
    progress = operationProgress(operation, actual);
    if (progress === "previous") {
      if (actual.quarantine?.identity.exists) {
        await removeBaseFile(baseRoot, operation.quarantinePath, async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !current.quarantine?.identity.exists ||
            !sameIdentity(
              current.quarantine.identity,
              materialIdentity(operation.previousSourceContent!),
            )
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        });
      }
      if (
        !hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation.id,
          "before-source-removal",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-quarantined",
          "before-source-removal",
          operation.source,
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation.source,
        operation.quarantinePath,
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !operationMatches(current, operation.precondition) ||
            current.quarantine?.identity.exists
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !operationMatches(current, operation.precondition) ||
            !storageMatchesContent(
              current,
              "quarantine",
              operation.previousSourceContent!,
            )
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation.source,
          operation.quarantinePath,
        ]);
      }
      operation.status = "source-quarantined";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation,
        "operation-quarantined",
        "source-removed",
        operation.source,
      );
    }
    actual = await currentOperation(baseRoot, operation, profile);
    progress = operationProgress(operation, actual);
    if (progress === "source-quarantined") {
      if (actual.target.identity.exists) {
        if (
          !hasTransactionEvent(
            transaction,
            "operation-quarantined",
            operation.id,
            "before-target-removal",
          )
        ) {
          await appendOperationEvent(
            runRoot,
            profile,
            transaction,
            operation,
            "operation-quarantined",
            "before-target-removal",
            operation.target,
          );
        }
        await removeBaseFile(baseRoot, operation.target, async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !current.source ||
            !sameIdentity(
              current.source.identity,
              operationPostSourceExpected(operation),
            ) ||
            !sameIdentity(
              current.target.identity,
              operationTargetExpected(operation),
            ) ||
            !current.quarantine?.identity.exists ||
            !operation.precondition.target.exists ||
            !current.backup?.identity.exists
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        });
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-quarantined",
          "target-removed",
          operation.target,
        );
        actual = await currentOperation(baseRoot, operation, profile);
      }
      if (
        !hasTransactionEvent(
          transaction,
          "operation-published",
          operation.id,
          "before-target-publication",
        )
      ) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation,
          "operation-published",
          "before-target-publication",
          operation.target,
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation.quarantinePath,
        operation.target,
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !current.source ||
            !sameIdentity(
              current.source.identity,
              operationPostSourceExpected(operation),
            ) ||
            current.target.identity.exists ||
            !current.quarantine?.identity.exists ||
            (operation.precondition.target.exists &&
              !current.backup?.identity.exists)
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation, profile);
          if (
            !current.source ||
            !sameIdentity(
              current.source.identity,
              operationPostSourceExpected(operation),
            ) ||
            !sameIdentity(
              current.target.identity,
              operationPostTargetExpected(operation),
            ) ||
            !storageMatchesContent(
              current,
              "quarantine",
              operation.previousSourceContent!,
            ) ||
            (operation.precondition.target.exists &&
              !storageMatchesContent(
                current,
                "backup",
                operation.previousTargetContent!,
              ))
          ) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation, current),
            );
          }
        },
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation.quarantinePath,
          operation.target,
        ]);
      }
      operation.status = "target-published";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation,
        "operation-published",
        "target-published",
        operation.target,
      );
    }
  }
  actual = await currentOperation(baseRoot, operation, profile);
  progress = operationProgress(operation, actual);
  if (progress !== "post" && operation.kind === "move") {
    if (
      progress === "source-quarantined" &&
      actual.quarantine?.identity.exists &&
      actual.target.identity.exists
    ) {
      throw new WorkflowFinalizationConflictError(
        operationConflictPaths(operation, actual),
      );
    }
  }
  if (
    !hasTransactionEvent(
      transaction,
      "operation-started",
      operation.id,
      "after-operation",
    ) &&
    progress === "post"
  ) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation,
      "operation-started",
      "after-operation",
      operation.target,
    );
  }
  const verified = await currentOperation(baseRoot, operation, profile);
  if (!operationMatches(verified, operation.expectedPostState)) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation, verified),
    );
  }
  operation.status = "verified";
  if (
    !hasTransactionEvent(
      transaction,
      "operation-verified",
      operation.id,
      "operation-verified",
    )
  ) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation,
      "operation-verified",
      "operation-verified",
      operation.target,
    );
  }
  operation.status = "committed";
  if (
    !hasTransactionEvent(
      transaction,
      "operation-completed",
      operation.id,
      "operation-verified",
    )
  ) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation,
      "operation-completed",
      "operation-verified",
      operation.target,
    );
  }
  if (recovery)
    transaction.recovery.crashBoundaries = uniqueStrings([
      ...transaction.recovery.crashBoundaries,
      ...transaction.events.map((event) => event.boundary),
    ]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
