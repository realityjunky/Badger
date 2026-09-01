import path from "node:path";
import { stableValue } from "../util.js";

export const WORKFLOW_FINDING_CATALOG_VERSION = 1 as const;
export const MAX_WORKFLOW_FINDINGS = 32;
export const MAX_WORKFLOW_FINDING_MESSAGE_LENGTH = 512;
export const MAX_WORKFLOW_FINDING_PATH_LENGTH = 256;
export const MAX_WORKFLOW_FINDING_OPERATION_ARGS = 16;
export const MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH = 256;
export const MAX_WORKFLOW_FINDINGS_ENCODED_BYTES = 16 * 1024;

export type WorkflowFindingCatalogVersion =
  typeof WORKFLOW_FINDING_CATALOG_VERSION;

const WORKFLOW_FINDING_SEVERITIES = ["info", "warning", "error"] as const;
export type WorkflowFindingSeverity =
  (typeof WORKFLOW_FINDING_SEVERITIES)[number];

const WORKFLOW_FINDING_REQUIRED_ACTIONS = [
  "none",
  "execute",
  "decide",
  "repair",
  "retry",
  "stop",
] as const;
export type WorkflowFindingRequiredAction =
  (typeof WORKFLOW_FINDING_REQUIRED_ACTIONS)[number];

const WORKFLOW_FINDING_OPERATION_IDS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit",
  "workflow.recover",
] as const;
export type WorkflowFindingOperationId =
  (typeof WORKFLOW_FINDING_OPERATION_IDS)[number];

export interface WorkflowFindingOperation {
  id: WorkflowFindingOperationId;
  args: string[];
}

const WORKFLOW_FINDING_CODES = [
  "action-available",
  "action-already-pending",
  "adaptive-requires-agent",
  "agent-not-allowed",
  "artifact-capability-required",
  "artifact-content-drift",
  "artifact-failed-submission",
  "artifact-invalid",
  "artifact-oversized",
  "artifact-stale-attempt",
  "artifact-unknown-version",
  "completion-invalid-artifact",
  "completion-missing-artifact",
  "completion-missing-augmentation",
  "completion-missing-evidence",
  "completion-missing-guardrail",
  "completion-missing-required-skill",
  "confirmation-required",
  "checkpoint-history-ambiguous",
  "checkpoint-invalid",
  "catalog-version-unsupported",
  "cycle-budget-exhausted",
  "cycle-invalid",
  "decision-required",
  "evaluation-warning",
  "identity-invalid",
  "iteration-budget-exhausted",
  "no-pending-action",
  "pending-action-invalid",
  "revision-conflict",
  "recovery-required",
  "retry-budget-exhausted",
  "route-ambiguous",
  "route-invalid-value",
  "route-no-match",
  "route-unknown-field",
  "run-not-found",
  "run-lock-active",
  "run-lock-release-conflict",
  "run-lock-stale",
  "run-lock-unknown",
  "run-status",
  "scope-invalid",
  "scope-unavailable",
  "skill-not-allowed",
  "snapshot-incomplete",
  "snapshot-storage-failed",
  "snapshot-unsafe-scope",
  "snapshot-unstable",
  "state-invalid",
  "tool-not-allowed",
  "unknown-current-step",
  "unknown-next-step",
  "verification-receipt-required",
  "verification-receipt-invalid",
  "verification-receipt-stale",
  "verification-receipt-failed",
  "verification-receipt-storage-failed",
] as const;
export type WorkflowFindingCode = (typeof WORKFLOW_FINDING_CODES)[number];

export interface WorkflowFinding {
  catalogVersion: WorkflowFindingCatalogVersion;
  code: WorkflowFindingCode;
  severity: WorkflowFindingSeverity;
  message: string;
  path?: string;
  requiredAction: WorkflowFindingRequiredAction;
  operation?: WorkflowFindingOperation;
  requiresUserDecision: boolean;
  currentRevision?: number;
  currentActionId?: string | null;
}

export interface WorkflowRuntimeError extends Error {
  finding: WorkflowFinding;
}

export interface WorkflowFindingSummary {
  catalogVersion: WorkflowFindingCatalogVersion;
  total: number;
  returned: number;
  omitted: number;
  omittedBySeverity: Record<WorkflowFindingSeverity, number>;
  omittedByCode: Partial<Record<WorkflowFindingCode, number>>;
  omittedRequiresUserDecision: number;
  truncated: boolean;
  encodedBytes: number;
  maxEncodedBytes: number;
}

export interface WorkflowFindingContext {
  actionId?: string;
  nodeId?: string | null;
  path?: string;
}

export interface WorkflowFindingInput {
  code: WorkflowFindingCode;
  severity: WorkflowFindingSeverity;
  message: string;
  path?: string;
  requiredAction: WorkflowFindingRequiredAction;
  operation?: WorkflowFindingOperation;
  requiresUserDecision?: boolean;
  currentRevision?: number;
  currentActionId?: string | null;
}

const severityRank: Record<WorkflowFindingSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const registeredOperations = new Set<WorkflowFindingOperationId>(
  WORKFLOW_FINDING_OPERATION_IDS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  if (new TextEncoder().encode(value).byteLength <= maxLength) return value;
  let result = "";
  for (const character of value) {
    const next = `${result}${character}…`;
    if (new TextEncoder().encode(next).byteLength > maxLength) break;
    result += character;
  }
  return `${result}…`;
}

function redactMessage(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redactedUrls = normalized.replace(
    /\b(?:https?|file):\/\/[^\s,;)]+/giu,
    "[URL]",
  );
  const redactedCredentials = redactedUrls
    .replace(
      /\b(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)["']?\s*[:=]\s*["']?[^\s,;"'}]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;)]+/giu, "Bearer [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*[^\s,;]+/gu, "$1=[REDACTED]");
  const redactedAbsolutePaths = redactedCredentials.replace(
    /(?:[A-Za-z]:[\\/]|\/)[^,;)]*/gu,
    "[PATH]",
  );
  return truncate(redactedAbsolutePaths, MAX_WORKFLOW_FINDING_MESSAGE_LENGTH);
}

export function normalizeWorkflowFindingPath(
  value: string | undefined,
): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength >
      MAX_WORKFLOW_FINDING_PATH_LENGTH
  ) {
    return undefined;
  }
  const normalizedSeparators = value.replaceAll("\\", "/");
  if (
    normalizedSeparators.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalizedSeparators) ||
    /[*?\u0000-\u001f\u007f]/u.test(normalizedSeparators)
  ) {
    return undefined;
  }
  const segments = normalizedSeparators.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(normalizedSeparators);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function operation(value: unknown): WorkflowFindingOperation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Workflow finding operation must be an object");
  }
  const unknown = Object.keys(value).find(
    (key) => key !== "id" && key !== "args",
  );
  if (unknown) {
    throw new Error(`Workflow finding operation has unknown field: ${unknown}`);
  }
  if (
    typeof value.id !== "string" ||
    !registeredOperations.has(value.id as WorkflowFindingOperationId)
  ) {
    throw new Error(`Unknown Workflow finding operation: ${String(value.id)}`);
  }
  if (
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== "string") ||
    value.args.length > MAX_WORKFLOW_FINDING_OPERATION_ARGS ||
    value.args.some(
      (arg) =>
        arg.length === 0 ||
        new TextEncoder().encode(arg).byteLength >
          MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH ||
        /[\u0000\r\n]/u.test(arg),
    )
  ) {
    throw new Error("Workflow finding operation args are invalid");
  }
  const args = (value.args as string[]).map((arg) =>
    truncate(redactMessage(arg), MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH),
  );
  return {
    id: value.id as WorkflowFindingOperationId,
    args,
  };
}

function findingKey(value: WorkflowFinding): string {
  return JSON.stringify([
    value.code,
    value.severity,
    value.message,
    value.path ?? "",
    value.requiredAction,
    value.operation?.id ?? "",
    value.operation?.args ?? [],
    value.requiresUserDecision,
    value.currentRevision ?? null,
    value.currentActionId ?? null,
  ]);
}

function compareFindings(
  left: WorkflowFinding,
  right: WorkflowFinding,
): number {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;
  if (left.requiresUserDecision !== right.requiresUserDecision) {
    return left.requiresUserDecision ? -1 : 1;
  }
  const code = left.code.localeCompare(right.code);
  if (code !== 0) return code;
  const pathComparison = (left.path ?? "").localeCompare(right.path ?? "");
  if (pathComparison !== 0) return pathComparison;
  const message = left.message.localeCompare(right.message);
  if (message !== 0) return message;
  const revision = (left.currentRevision ?? -1) - (right.currentRevision ?? -1);
  if (revision !== 0) return revision;
  return (left.currentActionId ?? "").localeCompare(
    right.currentActionId ?? "",
  );
}

function findingBytes(value: readonly WorkflowFinding[]): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const findingCodes = new Set<WorkflowFindingCode>(WORKFLOW_FINDING_CODES);

const findingSeverities = new Set<WorkflowFindingSeverity>(
  WORKFLOW_FINDING_SEVERITIES,
);

const findingActions = new Set<WorkflowFindingRequiredAction>(
  WORKFLOW_FINDING_REQUIRED_ACTIONS,
);

export function createWorkflowFinding(
  input: WorkflowFindingInput,
): WorkflowFinding {
  if (!findingCodes.has(input.code)) {
    throw new Error(`Unknown Workflow finding code: ${input.code}`);
  }
  if (!findingSeverities.has(input.severity)) {
    throw new Error(`Unknown Workflow finding severity: ${input.severity}`);
  }
  if (!findingActions.has(input.requiredAction)) {
    throw new Error(
      `Unknown Workflow finding required action: ${input.requiredAction}`,
    );
  }
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new Error("Workflow finding message must be non-empty");
  }
  if (
    input.currentRevision !== undefined &&
    (!Number.isSafeInteger(input.currentRevision) || input.currentRevision < 0)
  ) {
    throw new Error("Workflow finding current revision must be non-negative");
  }
  if (
    input.currentActionId !== undefined &&
    input.currentActionId !== null &&
    (typeof input.currentActionId !== "string" ||
      input.currentActionId.length === 0 ||
      input.currentActionId.length >
        MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH ||
      /[\u0000\r\n]/u.test(input.currentActionId))
  ) {
    throw new Error("Workflow finding current action id is invalid");
  }
  const safePath = normalizeWorkflowFindingPath(input.path);
  const safeOperation = operation(input.operation);
  const allowedOperations: Partial<
    Record<WorkflowFindingRequiredAction, readonly WorkflowFindingOperationId[]>
  > = {
    execute: ["workflow.start", "workflow.resume"],
    decide: ["workflow.submit"],
    repair: ["workflow.submit", "workflow.recover"],
    retry: [
      "workflow.start",
      "workflow.resume",
      "workflow.submit",
      "workflow.recover",
    ],
  };
  const expectedOperations = allowedOperations[input.requiredAction];
  if (
    expectedOperations &&
    (!safeOperation || !expectedOperations.includes(safeOperation.id))
  ) {
    throw new Error(
      `Workflow finding ${input.code} has an invalid operation for ${input.requiredAction}`,
    );
  }
  return {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    code: input.code,
    severity: input.severity,
    message: redactMessage(input.message),
    ...(safePath ? { path: safePath } : {}),
    requiredAction: input.requiredAction,
    ...(safeOperation ? { operation: safeOperation } : {}),
    requiresUserDecision: input.requiresUserDecision ?? false,
    ...(input.currentRevision !== undefined
      ? { currentRevision: input.currentRevision }
      : {}),
    ...(input.currentActionId !== undefined
      ? { currentActionId: input.currentActionId }
      : {}),
  };
}

export function snapshotIncompleteFinding(
  message: string,
  path?: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "snapshot-incomplete",
    severity: "error",
    message,
    ...(path ? { path } : {}),
    requiredAction: "stop",
  });
}

export function snapshotStorageFailedFinding(
  message: string,
  path?: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "snapshot-storage-failed",
    severity: "error",
    message,
    ...(path ? { path } : {}),
    requiredAction: "stop",
  });
}

export function snapshotUnsafeScopeFinding(
  message: string,
  path?: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "snapshot-unsafe-scope",
    severity: "error",
    message,
    ...(path ? { path } : {}),
    requiredAction: "stop",
  });
}

export function snapshotUnstableFinding(
  message: string,
  path?: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "snapshot-unstable",
    severity: "error",
    message,
    ...(path ? { path } : {}),
    requiredAction: "stop",
  });
}

export function parseWorkflowFinding(value: unknown): WorkflowFinding {
  if (!isRecord(value)) {
    throw new Error("Workflow finding must be an object");
  }
  if (value.catalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unknown Workflow finding catalog version: ${String(value.catalogVersion)}`,
    );
  }
  const keys = new Set([
    "catalogVersion",
    "code",
    "severity",
    "message",
    "path",
    "requiredAction",
    "operation",
    "requiresUserDecision",
    "currentRevision",
    "currentActionId",
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Workflow finding has unknown field: ${unknown}`);
  }
  if (
    typeof value.code !== "string" ||
    typeof value.severity !== "string" ||
    typeof value.message !== "string" ||
    typeof value.requiredAction !== "string" ||
    typeof value.requiresUserDecision !== "boolean"
  ) {
    throw new Error("Workflow finding fields are invalid");
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    throw new Error("Workflow finding path must be a string");
  }
  if (
    value.currentRevision !== undefined &&
    (typeof value.currentRevision !== "number" ||
      !Number.isSafeInteger(value.currentRevision) ||
      value.currentRevision < 0)
  ) {
    throw new Error("Workflow finding current revision is invalid");
  }
  if (
    value.currentActionId !== undefined &&
    value.currentActionId !== null &&
    typeof value.currentActionId !== "string"
  ) {
    throw new Error("Workflow finding current action id is invalid");
  }
  const finding = createWorkflowFinding({
    code: value.code as WorkflowFindingCode,
    severity: value.severity as WorkflowFindingSeverity,
    message: value.message,
    ...(value.path !== undefined ? { path: value.path } : {}),
    requiredAction: value.requiredAction as WorkflowFindingRequiredAction,
    ...(value.operation !== undefined
      ? { operation: value.operation as WorkflowFindingOperation }
      : {}),
    requiresUserDecision: value.requiresUserDecision,
    ...(value.currentRevision !== undefined
      ? { currentRevision: value.currentRevision as number }
      : {}),
    ...(value.currentActionId !== undefined
      ? { currentActionId: value.currentActionId as string | null }
      : {}),
  });
  if (
    JSON.stringify(stableValue(finding)) !== JSON.stringify(stableValue(value))
  ) {
    throw new Error("Workflow finding is not canonical");
  }
  return finding;
}

export function boundWorkflowFindings(values: readonly WorkflowFinding[]): {
  findings: WorkflowFinding[];
  summary: WorkflowFindingSummary;
} {
  const unique = new Map<string, WorkflowFinding>();
  for (const value of values) {
    const finding = parseWorkflowFinding(value);
    unique.set(findingKey(finding), finding);
  }
  const candidates = [...unique.values()].sort(compareFindings);
  const findings: WorkflowFinding[] = [];
  let encodedBytes = findingBytes(findings);
  for (const candidate of candidates) {
    if (findings.length >= MAX_WORKFLOW_FINDINGS) break;
    const next = [...findings, candidate];
    const nextBytes = findingBytes(next);
    if (nextBytes > MAX_WORKFLOW_FINDINGS_ENCODED_BYTES) continue;
    findings.push(candidate);
    encodedBytes = nextBytes;
  }
  const omittedValues = candidates.filter(
    (candidate) =>
      !findings.some((value) => findingKey(value) === findingKey(candidate)),
  );
  const omittedBySeverity: Record<WorkflowFindingSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  };
  const omittedByCode: Partial<Record<WorkflowFindingCode, number>> = {};
  for (const omitted of omittedValues) {
    omittedBySeverity[omitted.severity] += 1;
    omittedByCode[omitted.code] = (omittedByCode[omitted.code] ?? 0) + 1;
  }
  const summary: WorkflowFindingSummary = {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    total: candidates.length,
    returned: findings.length,
    omitted: omittedValues.length,
    omittedBySeverity,
    omittedByCode,
    omittedRequiresUserDecision: omittedValues.filter(
      (finding) => finding.requiresUserDecision,
    ).length,
    truncated: omittedValues.length > 0,
    encodedBytes,
    maxEncodedBytes: MAX_WORKFLOW_FINDINGS_ENCODED_BYTES,
  };
  return { findings: structuredClone(findings), summary };
}

export function parseWorkflowFindingSummary(
  value: unknown,
): WorkflowFindingSummary {
  if (!isRecord(value)) {
    throw new Error("Workflow finding summary must be an object");
  }
  const keys = new Set([
    "catalogVersion",
    "total",
    "returned",
    "omitted",
    "omittedBySeverity",
    "omittedByCode",
    "omittedRequiresUserDecision",
    "truncated",
    "encodedBytes",
    "maxEncodedBytes",
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Workflow finding summary has unknown field: ${unknown}`);
  }
  if (value.catalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unknown Workflow finding catalog version: ${String(value.catalogVersion)}`,
    );
  }
  const integerFields = [
    "total",
    "returned",
    "omitted",
    "omittedRequiresUserDecision",
    "encodedBytes",
    "maxEncodedBytes",
  ];
  for (const field of integerFields) {
    const entry = value[field];
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0
    ) {
      throw new Error(`Workflow finding summary field is invalid: ${field}`);
    }
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error("Workflow finding summary truncated field is invalid");
  }
  if (!isRecord(value.omittedBySeverity)) {
    throw new Error("Workflow finding summary severities are invalid");
  }
  const omittedBySeverity: Record<WorkflowFindingSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  };
  const unknownSeverity = Object.keys(value.omittedBySeverity).find(
    (severity) => !(severity in omittedBySeverity),
  );
  if (unknownSeverity) {
    throw new Error(
      `Workflow finding summary has unknown severity: ${unknownSeverity}`,
    );
  }
  for (const severity of Object.keys(
    omittedBySeverity,
  ) as WorkflowFindingSeverity[]) {
    const entry = value.omittedBySeverity[severity];
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0
    ) {
      throw new Error(
        `Workflow finding summary severity count is invalid: ${severity}`,
      );
    }
    omittedBySeverity[severity] = entry;
  }
  if (!isRecord(value.omittedByCode)) {
    throw new Error("Workflow finding summary codes are invalid");
  }
  const omittedByCode: Partial<Record<WorkflowFindingCode, number>> = {};
  for (const [code, entry] of Object.entries(value.omittedByCode)) {
    if (!findingCodes.has(code as WorkflowFindingCode)) {
      throw new Error(`Unknown Workflow finding code: ${code}`);
    }
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry <= 0
    ) {
      throw new Error(
        `Workflow finding summary code count is invalid: ${code}`,
      );
    }
    omittedByCode[code as WorkflowFindingCode] = entry;
  }
  const total = value.total as number;
  const returned = value.returned as number;
  const omitted = value.omitted as number;
  if (
    returned > total ||
    returned > MAX_WORKFLOW_FINDINGS ||
    omitted !== total - returned ||
    value.truncated !== omitted > 0 ||
    Object.values(omittedBySeverity).reduce((sum, count) => sum + count, 0) !==
      omitted ||
    Object.values(omittedByCode).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    ) !== omitted ||
    (value.omittedRequiresUserDecision as number) > omitted ||
    (value.maxEncodedBytes as number) !== MAX_WORKFLOW_FINDINGS_ENCODED_BYTES ||
    (value.encodedBytes as number) > (value.maxEncodedBytes as number)
  ) {
    throw new Error("Workflow finding summary counts are inconsistent");
  }
  return {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    total,
    returned,
    omitted,
    omittedBySeverity,
    omittedByCode,
    omittedRequiresUserDecision: value.omittedRequiresUserDecision as number,
    truncated: value.truncated,
    encodedBytes: value.encodedBytes as number,
    maxEncodedBytes: value.maxEncodedBytes as number,
  };
}

interface BlockerCatalogEntry {
  code: WorkflowFindingCode;
  severity: WorkflowFindingSeverity;
  requiredAction: WorkflowFindingRequiredAction;
  requiresUserDecision?: boolean;
  operationId?: WorkflowFindingOperationId;
}

const blockerCatalog: Array<{
  match: RegExp;
  entry: BlockerCatalogEntry;
}> = [
  {
    match: /^No Comet Run found:/u,
    entry: {
      code: "run-not-found",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow Run lock is active/u,
    entry: {
      code: "run-lock-active",
      severity: "error",
      requiredAction: "retry",
    },
  },
  {
    match: /^Workflow Run lock owner is absent/u,
    entry: {
      code: "run-lock-stale",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.recover",
    },
  },
  {
    match: /^Workflow Run lock ownership or file identity changed/u,
    entry: {
      code: "run-lock-release-conflict",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow Run lock/u,
    entry: {
      code: "run-lock-unknown",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow checkpoint history is ambiguous/u,
    entry: {
      code: "checkpoint-history-ambiguous",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow checkpoint/u,
    entry: {
      code: "checkpoint-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^WorkflowRuntime recovery is required/u,
    entry: {
      code: "recovery-required",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.recover",
    },
  },
  {
    match: /^Unknown Workflow finding catalog version:/u,
    entry: {
      code: "catalog-version-unsupported",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Decision is pending/u,
    entry: {
      code: "decision-required",
      severity: "info",
      requiredAction: "decide",
      requiresUserDecision: true,
      operationId: "workflow.submit",
    },
  },
  {
    match: /^Missing Output Schema artifacts:/u,
    entry: {
      code: "completion-missing-artifact",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Missing Output Schema evidence:/u,
    entry: {
      code: "completion-missing-evidence",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /exceeds \d+ bytes/iu,
    entry: {
      code: "artifact-oversized",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Invalid Output Schema artifact/u,
    entry: {
      code: "completion-invalid-artifact",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Missing required Skill evidence:/u,
    entry: {
      code: "completion-missing-required-skill",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Missing augmentation evidence:/u,
    entry: {
      code: "completion-missing-augmentation",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Missing guardrail evidence:/u,
    entry: {
      code: "completion-missing-guardrail",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Route blocker: unknown routing field:/u,
    entry: {
      code: "route-unknown-field",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Route blocker: invalid routing value/u,
    entry: {
      code: "route-invalid-value",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Route blocker: ambiguous/u,
    entry: {
      code: "route-ambiguous",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Route blocker: no matching/u,
    entry: {
      code: "route-no-match",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Cycle budget exhausted:/u,
    entry: {
      code: "cycle-budget-exhausted",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Cycle /u,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /Workflow Protocol Cycle|WorkflowRuntime .*Cycle/iu,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match:
      /^Workflow artifact selections require versioned-artifacts capability$/u,
    entry: {
      code: "artifact-capability-required",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Failed submissions cannot update versioned artifacts$/u,
    entry: {
      code: "artifact-failed-submission",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /artifact content drift detected/iu,
    entry: {
      code: "artifact-content-drift",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /artifact version is unknown/iu,
    entry: {
      code: "artifact-unknown-version",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /stale for this Attempt/iu,
    entry: {
      code: "artifact-stale-attempt",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Workflow Verification Receipt is required:/u,
    entry: {
      code: "verification-receipt-required",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit",
    },
  },
  {
    match:
      /^Workflow Verification Receipt (?:is stale:|content snapshot is stale:|artifact scope is stale:|candidate artifact is stale:)/u,
    entry: {
      code: "verification-receipt-stale",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit",
    },
  },
  {
    match: /^Workflow Verification Receipt does not pass requirement:/u,
    entry: {
      code: "verification-receipt-failed",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit",
    },
  },
  {
    match:
      /^Workflow Verification Receipt (?:is missing:|identity is invalid:|duplicate identity conflicts|is not valid JSON|record exceeds)/u,
    entry: {
      code: "verification-receipt-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow Verification Receipt persistence/u,
    entry: {
      code: "verification-receipt-storage-failed",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /verification receipt|verificationReceipts/iu,
    entry: {
      code: "verification-receipt-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /scope is unavailable/iu,
    entry: {
      code: "scope-unavailable",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /scope/iu,
    entry: {
      code: "scope-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match:
      /WorkflowRuntime .*identity|execution identity|Skill snapshot is invalid or missing/iu,
    entry: {
      code: "identity-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match:
      /Decision response revision|Decision response execution identity|Decision response .* identity/iu,
    entry: {
      code: "identity-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match:
      /Outcome does not match pending action|Submission Node does not match pending Node|Decision response required|Decision response cannot satisfy|Decision choice|pending decision identity/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match:
      /WorkflowRuntime pending action|pending action file|current Node does not match pending action/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match:
      /WorkflowRuntime current (?:Cycle|Attempt)|Cycle identity|Cycle position is invalid/iu,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /WorkflowRuntime current Node is not in the compiled route/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Run has no pending action$/u,
    entry: {
      code: "no-pending-action",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Workflow artifact/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Required Workflow artifact needs an explicit update or version:/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Cycle-persistent artifact update requires a current Cycle$/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Attempt artifact path must include the current Attempt id:/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Versioned artifact submission requires revisioned Run state$/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair",
    },
  },
  {
    match: /^Retry budget exhausted for action:/u,
    entry: {
      code: "retry-budget-exhausted",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Iteration budget exhausted:/u,
    entry: {
      code: "iteration-budget-exhausted",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Skill is not allowed:/u,
    entry: {
      code: "skill-not-allowed",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Tool is not allowed:/u,
    entry: {
      code: "tool-not-allowed",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Agent is not allowed:/u,
    entry: {
      code: "agent-not-allowed",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^User confirmation required for:/u,
    entry: {
      code: "confirmation-required",
      severity: "warning",
      requiredAction: "execute",
      requiresUserDecision: true,
    },
  },
  {
    match: /^Action already pending:/u,
    entry: {
      code: "action-already-pending",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^No pending action accepts an outcome$/u,
    entry: {
      code: "no-pending-action",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Adaptive orchestration requires an Agent candidate$/u,
    entry: {
      code: "adaptive-requires-agent",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Unknown current step:/u,
    entry: {
      code: "unknown-current-step",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Resolver returned unknown next step:/u,
    entry: {
      code: "unknown-next-step",
      severity: "error",
      requiredAction: "stop",
    },
  },
  {
    match: /^Run is /u,
    entry: {
      code: "run-status",
      severity: "error",
      requiredAction: "stop",
    },
  },
];

function operationFor(
  requiredAction: WorkflowFindingRequiredAction,
  context: WorkflowFindingContext,
  operationId?: WorkflowFindingOperationId,
): WorkflowFindingOperation | undefined {
  const args = context.actionId ? [context.actionId] : [];
  if (operationId) return { id: operationId, args };
  if (requiredAction === "repair") {
    return { id: "workflow.submit", args };
  }
  if (requiredAction === "retry") {
    return { id: "workflow.resume", args };
  }
  if (requiredAction === "decide") {
    return { id: "workflow.submit", args };
  }
  if (requiredAction === "execute") {
    return { id: "workflow.resume", args };
  }
  return undefined;
}

export function findingFromBlocker(
  message: string,
  context: WorkflowFindingContext = {},
): WorkflowFinding {
  const catalog = blockerCatalog.find((entry) => entry.match.test(message));
  const entry =
    catalog?.entry ??
    ({
      code: "state-invalid",
      severity: "error",
      requiredAction: "stop",
    } satisfies BlockerCatalogEntry);
  return createWorkflowFinding({
    ...entry,
    message,
    path: context.path,
    operation: operationFor(entry.requiredAction, context, entry.operationId),
  });
}

export function attachWorkflowFinding(error: unknown): Error {
  if (error instanceof Error && "finding" in error) return error;
  const message = error instanceof Error ? error.message : String(error);
  const finding = findingFromBlocker(message);
  if (error instanceof Error) {
    Object.defineProperty(error, "finding", {
      configurable: true,
      enumerable: true,
      value: finding,
      writable: false,
    });
    return error;
  }
  const wrapped = new Error(message, { cause: error });
  Object.defineProperty(wrapped, "finding", {
    configurable: true,
    enumerable: true,
    value: finding,
    writable: false,
  });
  return wrapped;
}

export function actionAvailableFinding(
  actionId: string,
  retry = false,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "action-available",
    severity: "info",
    message: "Executable workflow action is available.",
    requiredAction: retry ? "retry" : "execute",
    operation: { id: "workflow.resume", args: [actionId] },
  });
}

export function decisionRequiredFinding(actionId: string): WorkflowFinding {
  return createWorkflowFinding({
    code: "decision-required",
    severity: "info",
    message: "A persisted workflow decision requires user input.",
    requiredAction: "decide",
    operation: { id: "workflow.submit", args: [actionId] },
    requiresUserDecision: true,
  });
}

export function revisionConflictFinding(
  currentRevision: number,
  currentActionId: string | null,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "revision-conflict",
    severity: "error",
    message: `Workflow submission conflicts with the current Run revision ${currentRevision} and action ${currentActionId ?? "(none)"}. Refresh the authoritative continuation before retrying.`,
    requiredAction: "retry",
    operation: {
      id: "workflow.resume",
      args: currentActionId ? [currentActionId] : [],
    },
    currentRevision,
    currentActionId,
  });
}

export function recoveryRequiredFinding(
  currentRevision?: number,
  currentActionId?: string | null,
  recoveryPath = ".comet/transition-journal.json",
): WorkflowFinding {
  return createWorkflowFinding({
    code: "recovery-required",
    severity: "error",
    message:
      recoveryPath === ".comet/transition-journal.json"
        ? "WorkflowRuntime has an unfinished transition journal. Run explicit recovery before resuming or submitting."
        : "WorkflowRuntime has unfinished checkpoint recovery evidence. Run explicit recovery before resuming or submitting.",
    requiredAction: "repair",
    operation: { id: "workflow.recover", args: [] },
    path: recoveryPath,
    ...(currentRevision === undefined ? {} : { currentRevision }),
    ...(currentActionId === undefined ? {} : { currentActionId }),
  });
}

export function checkpointInvalidFinding(
  message: string,
  path?: string,
  severity: "warning" | "error" = "error",
): WorkflowFinding {
  return createWorkflowFinding({
    code: "checkpoint-invalid",
    severity,
    message,
    path,
    requiredAction: severity === "warning" ? "none" : "stop",
  });
}

export function checkpointHistoryAmbiguousFinding(
  message: string,
  path?: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "checkpoint-history-ambiguous",
    severity: "error",
    message,
    path,
    requiredAction: "stop",
  });
}

export function evaluationWarningFinding(
  evalId: string,
  evidence: string,
): WorkflowFinding {
  return createWorkflowFinding({
    code: "evaluation-warning",
    severity: "warning",
    message: `Terminal evaluation ${evalId} did not pass: ${evidence}`,
    requiredAction: "none",
  });
}

export function legacyBlockersFromFindings(
  disposition: "continue" | "await-user" | "blocked" | "done",
  findings: readonly WorkflowFinding[],
): string[] {
  return disposition === "blocked"
    ? findings.map((finding) => finding.message)
    : [];
}
