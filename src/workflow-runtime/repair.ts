import type { EngineAction, RuntimeIdentity } from "../engine/types.js";
import type {
  WorkflowRepairChoice,
  WorkflowRepairAutomaticOperation,
  WorkflowRepairDecisionOutcome,
  WorkflowRepairDisposition,
  WorkflowRepairEpisodeState,
  WorkflowRepairFailureRecord,
  WorkflowRepairFailureSignature,
  WorkflowRepairHistoryRecord,
  WorkflowRepairPendingDecision,
  WorkflowRepairPolicy,
  WorkflowRepairOutcome,
  WorkflowReviewerAttestation,
  WorkflowReviewerPolicy,
  WorkflowRationalePolicy,
} from "../types.js";
import { sha256, stableValue } from "../util.js";

export const WORKFLOW_REPAIR_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_REPAIR_MAX_HISTORY_RECORDS = 256;
export const WORKFLOW_REPAIR_MAX_COVERAGE_ENTRIES = 1_024;
export const WORKFLOW_REPAIR_MAX_TEXT_BYTES = 64 * 1024;
export const WORKFLOW_REPAIR_DEFAULT_RATIONALE_BYTES = 4 * 1024;

export interface WorkflowRepairFailureFacts {
  protocolHash?: string;
  contractHash?: string;
  execution?: RuntimeIdentity | string;
  executionIdentity?: RuntimeIdentity | string;
  executionHash?: string;
  action?: string | { id?: string };
  attempt?:
    | string
    | {
        id?: string;
        nodeId?: string | null;
        cycleId?: string | null;
        visitOrdinal?: number | null;
      };
  actionId?: string | null;
  attemptId?: string | null;
  nodeId?: string | null;
  cycleId?: string | null;
  visitOrdinal?: number | null;
  findingCodes?: readonly string[];
  failedFindingCodes?: readonly string[];
  failedCheckIds?: readonly string[];
  failedReceiptCoverage?: readonly string[];
  failedReceiptIds?: readonly string[];
  receiptCoverage?: readonly string[];
  failedAcceptanceCoverage?: readonly string[];
  failedAcceptanceIds?: readonly string[];
  acceptanceCoverage?: readonly string[];
  scopeIdentities?: readonly string[];
  scopeHashes?: readonly string[];
  scopeHash?: string | null;
  implementationScopeHash?: string | null;
  snapshotIdentities?: readonly string[];
  snapshotHashes?: readonly string[];
  snapshotHash?: string | null;
  artifactSnapshotHash?: string | null;
  artifactIdentities?: readonly string[];
  artifactHashes?: readonly string[];
  artifactHash?: string | null;
  summary?: string;
  timestamp?: string;
}

export interface WorkflowRepairOverrideRequest {
  expectedSignatureHash: string;
  rationale?: string;
  hypothesis?: string;
  summary?: string;
}

export interface NormalizedWorkflowRepairPolicy {
  maxFailures: number;
  warningThreshold: number;
  manualStopThreshold: number;
  allowedChoices: WorkflowRepairChoice[];
  allowOneTimeOverride: boolean;
  maxOverrideRationaleBytes: number;
  reviewer: WorkflowReviewerPolicy;
  rationale: WorkflowRationalePolicy;
  automaticRepairs: WorkflowRepairAutomaticOperation[];
}

export interface WorkflowRepairDecision {
  disposition: WorkflowRepairDisposition;
  reasonCode:
    | "new-failure-signature"
    | "repeated-failure-warning"
    | "repeated-failure-stop"
    | "repair-iteration-limit"
    | "override-accepted"
    | "override-already-used";
  signature: WorkflowRepairFailureSignature;
  consecutiveFailures: number;
  totalFailures: number;
  remainingFailures: number;
  totalRepairFailures: number;
  remainingIterations: number;
  overrideAccepted: boolean;
  automaticRepair: WorkflowRepairAutomaticOperation | null;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[^\u0000\r\n]{1,512}$/u;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const REPAIR_REASON_CODES = [
  "new-failure-signature",
  "repeated-failure-warning",
  "repeated-failure-stop",
  "repair-iteration-limit",
  "override-accepted",
  "override-already-used",
  "repair-decision-accepted",
] as const;

type WorkflowRepairRegisteredOperation =
  WorkflowRepairAutomaticOperation["operation"];

const WORKFLOW_REPAIR_OPERATION_REGISTRY: Record<
  WorkflowRepairRegisteredOperation,
  {
    idempotent: true;
    execute<T>(
      operation: WorkflowRepairAutomaticOperation,
      executionCount: number,
      work: () => Promise<T>,
    ): Promise<T>;
  }
> = {
  "workflow.resume": {
    idempotent: true,
    execute: async <T>(
      operation: WorkflowRepairAutomaticOperation,
      executionCount: number,
      work: () => Promise<T>,
    ): Promise<T> => {
      if (
        operation.operation !== "workflow.resume" ||
        executionCount < 1 ||
        executionCount > operation.maxExecutions
      ) {
        throw new Error(
          "Workflow repair automatic operation exceeded its bound",
        );
      }
      return work();
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function boundedHash(value: unknown, label: string): string {
  const result = boundedText(value, label);
  if (!HASH_PATTERN.test(result))
    throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function hashText(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") > WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return sha256(normalizeWorkflowRepairText(value, label));
}

export function normalizeWorkflowRepairText(
  value: string,
  label = "Workflow repair text",
  maxBytes = WORKFLOW_REPAIR_MAX_TEXT_BYTES,
): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > maxBytes
  ) {
    throw new Error(`${label} is outside its bound`);
  }
  return normalized;
}

export function hashWorkflowRepairText(
  value: string,
  label = "Workflow repair text",
  maxBytes = WORKFLOW_REPAIR_MAX_TEXT_BYTES,
): string {
  return sha256(normalizeWorkflowRepairText(value, label, maxBytes));
}

function hashValue(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function normalizedValues(
  values: readonly unknown[] | undefined,
  label: string,
): string[] {
  if (values === undefined) return [];
  if (
    !Array.isArray(values) ||
    values.length > WORKFLOW_REPAIR_MAX_COVERAGE_ENTRIES
  ) {
    throw new Error(`${label} exceeds its count boundary`);
  }
  const normalized = values.map((value) => {
    if (typeof value === "string") {
      const bounded = boundedText(value, label);
      return SAFE_IDENTITY_PATTERN.test(bounded) ? bounded : hashValue(bounded);
    }
    if (!isRecord(value) && !Array.isArray(value)) {
      throw new Error(`${label} contains an invalid identity`);
    }
    return hashValue(value);
  });
  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function combinedValues(
  values: Array<readonly unknown[] | undefined>,
  label: string,
): string[] {
  return normalizedValues(
    values.flatMap((value) => value ?? []),
    label,
  );
}

function identityHash(
  execution: RuntimeIdentity | string | undefined,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return boundedText(explicit, "executionHash");
  if (typeof execution === "string") return boundedText(execution, "execution");
  if (execution !== undefined) return hashValue(execution);
  return hashValue({ execution: null });
}

export function buildWorkflowRepairSignature(
  facts: WorkflowRepairFailureFacts,
): WorkflowRepairFailureSignature {
  const attempt =
    typeof facts.attempt === "object" && facts.attempt !== null
      ? facts.attempt
      : undefined;
  const attemptId = nullableText(
    facts.attemptId ??
      (typeof facts.attempt === "string" ? facts.attempt : attempt?.id),
    "attemptId",
  );
  const action =
    typeof facts.action === "object" && facts.action !== null
      ? facts.action
      : undefined;
  const actionId =
    facts.actionId ??
    (typeof facts.action === "string" ? facts.action : action?.id);
  const protocolHash = boundedText(
    facts.protocolHash ?? facts.contractHash,
    "protocolHash",
  );
  const content = {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    protocolHash,
    executionHash: identityHash(
      facts.execution ?? facts.executionIdentity,
      facts.executionHash,
    ),
    actionId: attemptId === null ? nullableText(actionId, "actionId") : null,
    attemptId,
    nodeId: nullableText(facts.nodeId ?? attempt?.nodeId, "nodeId"),
    cycleId: nullableText(facts.cycleId ?? attempt?.cycleId, "cycleId"),
    visitOrdinal:
      (facts.visitOrdinal ?? attempt?.visitOrdinal) === undefined ||
      (facts.visitOrdinal ?? attempt?.visitOrdinal) === null
        ? null
        : nonNegativeInteger(
            facts.visitOrdinal ?? attempt?.visitOrdinal,
            "visitOrdinal",
          ),
    findingCodes: combinedValues(
      [facts.findingCodes, facts.failedFindingCodes, facts.failedCheckIds],
      "findingCodes",
    ),
    failedReceiptCoverage: combinedValues(
      [
        facts.failedReceiptCoverage,
        facts.failedReceiptIds,
        facts.receiptCoverage,
      ],
      "failedReceiptCoverage",
    ),
    failedAcceptanceCoverage: combinedValues(
      [
        facts.failedAcceptanceCoverage,
        facts.failedAcceptanceIds,
        facts.acceptanceCoverage,
      ],
      "failedAcceptanceCoverage",
    ),
    scopeIdentities: combinedValues(
      [
        facts.scopeIdentities,
        facts.scopeHashes,
        facts.implementationScopeHash === undefined ||
        facts.implementationScopeHash === null
          ? undefined
          : [facts.implementationScopeHash],
        facts.scopeHash === undefined || facts.scopeHash === null
          ? undefined
          : [facts.scopeHash],
      ],
      "scopeIdentities",
    ),
    snapshotIdentities: combinedValues(
      [
        facts.snapshotIdentities,
        facts.snapshotHashes,
        facts.artifactSnapshotHash === undefined ||
        facts.artifactSnapshotHash === null
          ? undefined
          : [facts.artifactSnapshotHash],
        facts.snapshotHash === undefined || facts.snapshotHash === null
          ? undefined
          : [facts.snapshotHash],
      ],
      "snapshotIdentities",
    ),
    artifactIdentities: combinedValues(
      [
        facts.artifactIdentities,
        facts.artifactHashes,
        facts.artifactHash === undefined || facts.artifactHash === null
          ? undefined
          : [facts.artifactHash],
      ],
      "artifactIdentities",
    ),
  };
  return {
    ...content,
    signatureHash: hashValue(content),
  };
}

function choiceOutcome(value: string): WorkflowRepairOutcome | undefined {
  return {
    retry: "retry",
    "retry-with-new-approach": "retry",
    stop: "stop",
    "contract-change": "contract-change",
    "replace-run": "contract-change",
  }[value] as WorkflowRepairOutcome | undefined;
}

function choiceLabel(id: string): string {
  return (
    {
      retry: "Retry with a new approach",
      "retry-with-new-approach": "Retry with a new approach",
      stop: "Stop",
      "contract-change": "Change the contract",
      "replace-run": "Change the contract",
    }[id] ?? id
  );
}

function normalizeChoice(value: unknown, index: number): WorkflowRepairChoice {
  if (typeof value === "string") {
    const id = boundedText(value, `repair policy choice ${index}`);
    const outcome = choiceOutcome(id);
    if (!outcome) {
      throw new Error(`Repair policy choice has no declared outcome: ${id}`);
    }
    return { id, label: choiceLabel(id), outcome };
  }
  if (!isRecord(value)) {
    throw new Error(
      `Repair policy choice ${index} must be an object or string`,
    );
  }
  const unknown = Object.keys(value).find(
    (key) =>
      ![
        "id",
        "choiceId",
        "label",
        "description",
        "outcome",
        "effect",
        "kind",
      ].includes(key),
  );
  if (unknown)
    throw new Error(`Repair policy choice has unknown field: ${unknown}`);
  const id = boundedText(
    value.id ?? value.choiceId ?? value.kind,
    `repair policy choice ${index}.id`,
  );
  const rawOutcome = value.outcome ?? value.effect ?? choiceOutcome(id);
  if (typeof rawOutcome !== "string") {
    throw new Error(`Repair policy choice ${id} requires an outcome`);
  }
  const outcome =
    choiceOutcome(rawOutcome) ?? (rawOutcome as WorkflowRepairOutcome);
  if (
    outcome !== "retry" &&
    outcome !== "stop" &&
    outcome !== "contract-change"
  ) {
    throw new Error(`Repair policy choice ${id} has an invalid outcome`);
  }
  const label = value.label ?? value.description ?? choiceLabel(id);
  return {
    id,
    label: boundedText(label, `repair policy choice ${index}.label`),
    outcome,
  };
}

function policyNumber(
  policy: Record<string, unknown>,
  names: readonly string[],
  label: string,
): number {
  const values = names
    .map((name) => policy[name])
    .filter((value): value is number => value !== undefined);
  if (values.length === 0)
    throw new Error(`Repair policy ${label} is required`);
  const value = positiveInteger(values[0], `Repair policy ${label}`);
  if (values.some((candidate) => candidate !== value)) {
    throw new Error(`Repair policy ${label} aliases disagree`);
  }
  return value;
}

function normalizeReviewer(value: unknown): WorkflowReviewerPolicy {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error("Repair policy reviewer must be an object");
  const unknown = Object.keys(value).find(
    (key) => key !== "subjects" && key !== "authorities",
  );
  if (unknown)
    throw new Error(`Repair policy reviewer has unknown field: ${unknown}`);
  const result: WorkflowReviewerPolicy = {};
  for (const key of ["subjects", "authorities"] as const) {
    if (value[key] === undefined) continue;
    if (
      !Array.isArray(value[key]) ||
      value[key].some(
        (entry) => typeof entry !== "string" || entry.length === 0,
      )
    ) {
      throw new Error(`Repair policy reviewer ${key} must be a string array`);
    }
    const entries = [...(value[key] as string[])];
    if (new Set(entries).size !== entries.length) {
      throw new Error(
        `Repair policy reviewer ${key} must not contain duplicates`,
      );
    }
    result[key] = entries.sort((left, right) => left.localeCompare(right));
  }
  return result;
}

function normalizeRationale(value: unknown): WorkflowRationalePolicy {
  if (value === undefined) return { required: false };
  if (!isRecord(value))
    throw new Error("Repair policy rationale must be an object");
  const unknown = Object.keys(value).find((key) => key !== "required");
  if (unknown)
    throw new Error(`Repair policy rationale has unknown field: ${unknown}`);
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error("Repair policy rationale required must be a boolean");
  }
  return { required: value.required === true };
}

function overrideSetting(policy: Record<string, unknown>): {
  enabled: boolean;
  maxRationaleBytes: number;
} {
  const raw =
    policy.overridePolicy ?? policy.override ?? policy.oneTimeOverride;
  if (
    (Object.prototype.hasOwnProperty.call(policy, "override") &&
      policy.override === null) ||
    (Object.prototype.hasOwnProperty.call(policy, "oneTimeOverride") &&
      policy.oneTimeOverride === null) ||
    (Object.prototype.hasOwnProperty.call(policy, "overridePolicy") &&
      policy.overridePolicy === null)
  ) {
    throw new Error("Repair policy override must not be null");
  }
  let enabled = policy.allowOneTimeOverride ?? policy.allowOverride;
  let maxRationaleBytes =
    policy.maxOverrideRationaleBytes ??
    policy.maxRationaleBytes ??
    policy.maxOverrideBytes;
  if (typeof raw === "boolean") enabled ??= raw;
  if (
    raw !== undefined &&
    raw !== null &&
    typeof raw !== "boolean" &&
    !isRecord(raw)
  ) {
    throw new Error("Repair policy override must be a boolean or object");
  }
  if (isRecord(raw)) {
    if (raw.enabled !== undefined) enabled ??= raw.enabled;
    maxRationaleBytes ??=
      raw.maxRationaleBytes ?? raw.maxOverrideRationaleBytes ?? raw.maxBytes;
    const unknown = Object.keys(raw).find(
      (key) =>
        ![
          "enabled",
          "maxRationaleBytes",
          "maxOverrideRationaleBytes",
          "maxBytes",
        ].includes(key),
    );
    if (unknown)
      throw new Error(`Repair policy override has unknown field: ${unknown}`);
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Repair policy allowOneTimeOverride must be a boolean");
  }
  if (
    policy.allowOneTimeOverride !== undefined &&
    policy.allowOverride !== undefined &&
    policy.allowOneTimeOverride !== policy.allowOverride
  ) {
    throw new Error("Repair policy override aliases disagree");
  }
  const normalizedEnabled = enabled === true;
  const normalizedBytes =
    maxRationaleBytes === undefined
      ? WORKFLOW_REPAIR_DEFAULT_RATIONALE_BYTES
      : positiveInteger(
          maxRationaleBytes,
          "Repair policy maxOverrideRationaleBytes",
        );
  if (normalizedBytes > WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
    throw new Error(
      "Repair policy maxOverrideRationaleBytes exceeds its bound",
    );
  }
  return { enabled: normalizedEnabled, maxRationaleBytes: normalizedBytes };
}

function normalizeAutomaticRepair(
  value: unknown,
  index: number,
  maxFailures: number,
): WorkflowRepairAutomaticOperation {
  if (!isRecord(value)) {
    throw new Error(`Repair automatic operation ${index} must be an object`);
  }
  const unknown = Object.keys(value).find(
    (key) => !["id", "operation", "idempotent", "maxExecutions"].includes(key),
  );
  if (unknown) {
    throw new Error(
      `Repair automatic operation ${index} has unknown field: ${unknown}`,
    );
  }
  const id = boundedText(value.id, `Repair automatic operation ${index}.id`);
  if (value.operation !== "workflow.resume") {
    throw new Error(
      `Repair automatic operation ${id} must use workflow.resume`,
    );
  }
  if (!Object.hasOwn(WORKFLOW_REPAIR_OPERATION_REGISTRY, value.operation)) {
    throw new Error(`Repair automatic operation ${id} is not registered`);
  }
  if (value.idempotent !== true) {
    throw new Error(`Repair automatic operation ${id} must be idempotent`);
  }
  const maxExecutions =
    value.maxExecutions === undefined
      ? maxFailures
      : positiveInteger(
          value.maxExecutions,
          `Repair automatic operation ${id}.maxExecutions`,
        );
  if (maxExecutions > maxFailures) {
    throw new Error(
      `Repair automatic operation ${id} cannot exceed the repair failure budget`,
    );
  }
  return { id, operation: "workflow.resume", idempotent: true, maxExecutions };
}

export function parseWorkflowRepairAutomaticOperation(
  value: unknown,
): WorkflowRepairAutomaticOperation {
  const maxExecutions =
    isRecord(value) && typeof value.maxExecutions === "number"
      ? value.maxExecutions
      : WORKFLOW_REPAIR_MAX_HISTORY_RECORDS;
  return normalizeAutomaticRepair(value, 0, maxExecutions);
}

function normalizeAutomaticRepairs(
  policy: Record<string, unknown>,
  maxFailures: number,
): WorkflowRepairAutomaticOperation[] {
  const single = policy.automaticRepair;
  const plural = policy.automaticRepairs;
  if (single !== undefined && plural !== undefined) {
    throw new Error(
      "Repair automatic operation aliases cannot both be declared",
    );
  }
  const values =
    plural ??
    (single === undefined
      ? [
          {
            id: "retry",
            operation: "workflow.resume",
            idempotent: true,
            maxExecutions: maxFailures,
          },
        ]
      : [single]);
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw new Error(
      "Repair automatic operations must be a bounded non-empty array",
    );
  }
  const normalized = values.map((value, index) =>
    normalizeAutomaticRepair(value, index, maxFailures),
  );
  if (
    new Set(normalized.map((operation) => operation.id)).size !==
    normalized.length
  ) {
    throw new Error("Repair automatic operation ids must not be duplicated");
  }
  return normalized;
}

export function normalizeWorkflowRepairPolicy(
  value: WorkflowRepairPolicy,
): NormalizedWorkflowRepairPolicy {
  if (!isRecord(value))
    throw new Error("Workflow repair policy must be an object");
  const allowedKeys = new Set([
    "maxFailures",
    "maxRepairFailures",
    "maxVerifyFailures",
    "maxRepairIterations",
    "warningThreshold",
    "warningAtConsecutiveFailures",
    "warningAfter",
    "warnAfter",
    "manualStopThreshold",
    "manualStopAtConsecutiveFailures",
    "stopAfter",
    "manualStopAfter",
    "allowedChoices",
    "choices",
    "allowOneTimeOverride",
    "allowOverride",
    "oneTimeOverride",
    "override",
    "overridePolicy",
    "automaticRepair",
    "automaticRepairs",
    "maxOverrideRationaleBytes",
    "maxRationaleBytes",
    "maxOverrideBytes",
    "reviewer",
    "rationale",
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`Repair policy has unknown field: ${unknown}`);
  const maxFailures = policyNumber(
    value,
    [
      "maxFailures",
      "maxRepairFailures",
      "maxVerifyFailures",
      "maxRepairIterations",
    ],
    "maxFailures",
  );
  const warningThreshold = policyNumber(
    value,
    [
      "warningThreshold",
      "warningAtConsecutiveFailures",
      "warningAfter",
      "warnAfter",
    ],
    "warningThreshold",
  );
  const manualStopThreshold = policyNumber(
    value,
    [
      "manualStopThreshold",
      "manualStopAtConsecutiveFailures",
      "stopAfter",
      "manualStopAfter",
    ],
    "manualStopThreshold",
  );
  if (
    warningThreshold > manualStopThreshold ||
    manualStopThreshold > maxFailures
  ) {
    throw new Error(
      "Repair policy thresholds must be warning <= manual-stop <= maxFailures",
    );
  }
  const rawChoices = value.allowedChoices ?? value.choices;
  if (
    value.allowedChoices !== undefined &&
    value.choices !== undefined &&
    JSON.stringify(stableValue(value.allowedChoices)) !==
      JSON.stringify(stableValue(value.choices))
  ) {
    throw new Error("Repair policy choice aliases disagree");
  }
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
    throw new Error("Repair policy allowedChoices must be a non-empty array");
  }
  const allowedChoices = rawChoices.map(normalizeChoice);
  if (
    new Set(allowedChoices.map((choice) => choice.id)).size !==
    allowedChoices.length
  ) {
    throw new Error("Repair policy allowedChoices must not contain duplicates");
  }
  if (
    !allowedChoices.some(
      (choice) =>
        choice.outcome === "stop" || choice.outcome === "contract-change",
    )
  ) {
    throw new Error(
      "Repair policy allowedChoices must declare a stop or contract-change choice",
    );
  }
  const override = overrideSetting(value);
  const automaticRepairs = normalizeAutomaticRepairs(value, maxFailures);
  return {
    maxFailures,
    warningThreshold,
    manualStopThreshold,
    allowedChoices,
    allowOneTimeOverride: override.enabled,
    maxOverrideRationaleBytes: override.maxRationaleBytes,
    reviewer: normalizeReviewer(value.reviewer),
    rationale: normalizeRationale(value.rationale),
    automaticRepairs,
  };
}

export function workflowRepairAutomaticOperation(
  policy: WorkflowRepairPolicy | NormalizedWorkflowRepairPolicy,
  totalFailures: number,
): WorkflowRepairAutomaticOperation | null {
  const normalized = normalizeWorkflowRepairPolicy(policy);
  const failures = positiveInteger(
    totalFailures,
    "Workflow repair failure count",
  );
  return (
    normalized.automaticRepairs.find(
      (operation) => operation.maxExecutions >= failures,
    ) ?? null
  );
}

export async function executeWorkflowRepairOperation<T>(
  operation: WorkflowRepairAutomaticOperation,
  executionCount: number,
  work: () => Promise<T>,
): Promise<T> {
  const registered = WORKFLOW_REPAIR_OPERATION_REGISTRY[operation.operation];
  if (
    !registered ||
    operation.idempotent !== registered.idempotent ||
    !Number.isSafeInteger(operation.maxExecutions) ||
    operation.maxExecutions < 1
  ) {
    throw new Error("Workflow repair automatic operation is not registered");
  }
  return registered.execute(operation, executionCount, work);
}

function historyArray(
  value: readonly WorkflowRepairHistoryRecord[],
  maxRecords = WORKFLOW_REPAIR_MAX_HISTORY_RECORDS,
): WorkflowRepairHistoryRecord[] {
  if (!Array.isArray(value) || value.length > maxRecords) {
    throw new Error("Workflow repair history exceeds its record boundary");
  }
  let previousRevision = -1;
  return value.map((record, index) => {
    if (!isRecord(record) || typeof record.kind !== "string") {
      throw new Error(`Workflow repair history record ${index} is invalid`);
    }
    const allowedKeys =
      record.kind === "failure"
        ? new Set([
            "kind",
            "revision",
            "actionId",
            "attemptId",
            "signatureHash",
            "findingCodes",
            "failedReceiptCoverage",
            "failedAcceptanceCoverage",
            "scopeIdentities",
            "snapshotIdentities",
            "artifactIdentities",
            "automaticRepair",
            "disposition",
            "reasonCode",
            "consecutiveFailures",
            "totalFailures",
            "remainingFailures",
            "overrideAccepted",
          ])
        : record.kind === "decision"
          ? new Set([
              "kind",
              "revision",
              "actionId",
              "attemptId",
              "signatureHash",
              "decisionId",
              "choiceId",
              "outcome",
              "reviewer",
              "rationaleHash",
              "hypothesisHash",
            ])
          : record.kind === "override"
            ? new Set([
                "kind",
                "revision",
                "actionId",
                "attemptId",
                "signatureHash",
                "decisionId",
                "choiceId",
                "outcome",
                "reviewer",
                "rationaleHash",
                "hypothesisHash",
              ])
            : new Set<string>();
    const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
    if (unknown) {
      throw new Error(
        `Workflow repair history record ${index} has unknown field: ${unknown}`,
      );
    }
    const revision = nonNegativeInteger(
      record.revision,
      `Workflow repair history ${index}.revision`,
    );
    if (revision <= previousRevision) {
      throw new Error("Workflow repair history must be ordered by revision");
    }
    previousRevision = revision;
    const actionId = nullableText(
      record.actionId,
      `Workflow repair history ${index}.actionId`,
    );
    const attemptId = nullableText(
      record.attemptId,
      `Workflow repair history ${index}.attemptId`,
    );
    const signatureHash = boundedHash(
      record.signatureHash,
      `Workflow repair history ${index}.signatureHash`,
    );
    if (!HASH_PATTERN.test(signatureHash)) {
      throw new Error(
        `Workflow repair history ${index} signature hash is invalid`,
      );
    }
    if (record.kind === "failure") {
      const metadata = [
        record.disposition,
        record.reasonCode,
        record.consecutiveFailures,
        record.totalFailures,
        record.remainingFailures,
        record.overrideAccepted,
      ];
      const hasMetadata = metadata.some((value) => value !== undefined);
      if (hasMetadata && metadata.some((value) => value === undefined)) {
        throw new Error(
          `Workflow repair history ${index} failure metadata is incomplete`,
        );
      }
      if (
        record.disposition !== undefined &&
        !["continue", "warning", "manual-stop", "hard-stop"].includes(
          record.disposition as string,
        )
      ) {
        throw new Error(
          `Workflow repair history ${index} failure disposition is invalid`,
        );
      }
      if (
        record.reasonCode !== undefined &&
        !REPAIR_REASON_CODES.includes(
          record.reasonCode as (typeof REPAIR_REASON_CODES)[number],
        )
      ) {
        throw new Error(
          `Workflow repair history ${index} failure reasonCode is invalid`,
        );
      }
      if (
        record.overrideAccepted !== undefined &&
        typeof record.overrideAccepted !== "boolean"
      ) {
        throw new Error(
          `Workflow repair history ${index} overrideAccepted is invalid`,
        );
      }
      const automaticRepair =
        record.automaticRepair === undefined
          ? undefined
          : parseWorkflowRepairAutomaticOperation(record.automaticRepair);
      return {
        kind: "failure",
        revision,
        actionId,
        attemptId,
        signatureHash,
        findingCodes: normalizedValues(
          record.findingCodes as string[] | undefined,
          `Workflow repair history ${index}.findingCodes`,
        ),
        failedReceiptCoverage: normalizedValues(
          record.failedReceiptCoverage as string[] | undefined,
          `Workflow repair history ${index}.failedReceiptCoverage`,
        ),
        failedAcceptanceCoverage: normalizedValues(
          record.failedAcceptanceCoverage as string[] | undefined,
          `Workflow repair history ${index}.failedAcceptanceCoverage`,
        ),
        scopeIdentities: normalizedValues(
          record.scopeIdentities as string[] | undefined,
          `Workflow repair history ${index}.scopeIdentities`,
        ),
        snapshotIdentities: normalizedValues(
          record.snapshotIdentities as string[] | undefined,
          `Workflow repair history ${index}.snapshotIdentities`,
        ),
        artifactIdentities: normalizedValues(
          record.artifactIdentities as string[] | undefined,
          `Workflow repair history ${index}.artifactIdentities`,
        ),
        ...(hasMetadata
          ? {
              disposition: record.disposition as WorkflowRepairDisposition,
              reasonCode: boundedText(
                record.reasonCode,
                `Workflow repair history ${index}.reasonCode`,
              ),
              consecutiveFailures: nonNegativeInteger(
                record.consecutiveFailures,
                `Workflow repair history ${index}.consecutiveFailures`,
              ),
              totalFailures: nonNegativeInteger(
                record.totalFailures,
                `Workflow repair history ${index}.totalFailures`,
              ),
              remainingFailures: nonNegativeInteger(
                record.remainingFailures,
                `Workflow repair history ${index}.remainingFailures`,
              ),
              overrideAccepted: record.overrideAccepted as boolean,
            }
          : {}),
        ...(automaticRepair ? { automaticRepair } : {}),
      } satisfies WorkflowRepairFailureRecord;
    }
    if (record.kind === "decision") {
      const outcome = choiceOutcome(String(record.outcome));
      if (!outcome)
        throw new Error(
          `Workflow repair history ${index} decision outcome is invalid`,
        );
      if (typeof record.reviewer !== "object" || !record.reviewer) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewer = record.reviewer as Record<string, unknown>;
      const unknownReviewer = Object.keys(reviewer).find(
        (key) => key !== "subject" && key !== "authorities",
      );
      if (
        unknownReviewer ||
        typeof reviewer.subject !== "string" ||
        !Array.isArray(reviewer.authorities)
      ) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      return {
        kind: "decision",
        revision,
        actionId: boundedText(
          record.actionId,
          `Workflow repair history ${index}.actionId`,
        ),
        attemptId,
        signatureHash,
        decisionId: boundedText(
          record.decisionId,
          `Workflow repair history ${index}.decisionId`,
        ),
        choiceId: boundedText(
          record.choiceId,
          `Workflow repair history ${index}.choiceId`,
        ),
        outcome,
        reviewer: {
          subject: boundedText(
            reviewer.subject,
            `Workflow repair history ${index}.reviewer.subject`,
          ),
          authorities: normalizedValues(
            reviewer.authorities,
            `Workflow repair history ${index}.reviewer.authorities`,
          ),
        },
        rationaleHash:
          record.rationaleHash === null || record.rationaleHash === undefined
            ? null
            : boundedHash(
                record.rationaleHash,
                `Workflow repair history ${index}.rationaleHash`,
              ),
        hypothesisHash:
          record.hypothesisHash === null || record.hypothesisHash === undefined
            ? null
            : boundedHash(
                record.hypothesisHash,
                `Workflow repair history ${index}.hypothesisHash`,
              ),
      };
    }
    if (record.kind === "override") {
      const overrideOutcome = choiceOutcome(String(record.outcome));
      if (!overrideOutcome) {
        throw new Error(
          `Workflow repair history ${index} override outcome is invalid`,
        );
      }
      if (!isRecord(record.reviewer)) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewerValue = record.reviewer;
      const unknownReviewer = Object.keys(reviewerValue).find(
        (key) => key !== "subject" && key !== "authorities",
      );
      if (
        unknownReviewer ||
        typeof reviewerValue.subject !== "string" ||
        !Array.isArray(reviewerValue.authorities)
      ) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewer: WorkflowReviewerAttestation = {
        subject: boundedText(
          reviewerValue.subject,
          `Workflow repair history ${index}.reviewer.subject`,
        ),
        authorities: normalizedValues(
          reviewerValue.authorities,
          `Workflow repair history ${index}.reviewer.authorities`,
        ),
      };
      return {
        kind: "override",
        revision,
        actionId: boundedText(
          record.actionId,
          `Workflow repair history ${index}.actionId`,
        ),
        attemptId,
        signatureHash,
        decisionId: boundedText(
          record.decisionId,
          `Workflow repair history ${index}.decisionId`,
        ),
        choiceId: boundedText(
          record.choiceId,
          `Workflow repair history ${index}.choiceId`,
        ),
        outcome: overrideOutcome,
        reviewer,
        rationaleHash: boundedHash(
          record.rationaleHash,
          `Workflow repair history ${index}.rationaleHash`,
        ),
        hypothesisHash: boundedHash(
          record.hypothesisHash,
          `Workflow repair history ${index}.hypothesisHash`,
        ),
      };
    }
    throw new Error(`Workflow repair history record ${index} kind is invalid`);
  });
}

export function normalizeWorkflowRepairHistory(
  value: readonly WorkflowRepairHistoryRecord[],
  maxRecords = WORKFLOW_REPAIR_MAX_HISTORY_RECORDS,
): WorkflowRepairHistoryRecord[] {
  return historyArray(value, maxRecords);
}

function parseSignature(value: unknown): WorkflowRepairFailureSignature {
  if (!isRecord(value)) {
    throw new Error("Workflow repair episode signature must be an object");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "protocolHash",
    "executionHash",
    "actionId",
    "attemptId",
    "nodeId",
    "cycleId",
    "visitOrdinal",
    "findingCodes",
    "failedReceiptCoverage",
    "failedAcceptanceCoverage",
    "scopeIdentities",
    "snapshotIdentities",
    "artifactIdentities",
    "signatureHash",
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow repair episode signature has unknown field: ${unknown}`,
    );
  }
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error(
      "Workflow repair episode signature schema version is unsupported",
    );
  }
  const signature = {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    protocolHash: boundedText(
      value.protocolHash,
      "Workflow repair signature protocolHash",
    ),
    executionHash: boundedText(
      value.executionHash,
      "Workflow repair signature executionHash",
    ),
    actionId: nullableText(
      value.actionId,
      "Workflow repair signature actionId",
    ),
    attemptId: nullableText(
      value.attemptId,
      "Workflow repair signature attemptId",
    ),
    nodeId: nullableText(value.nodeId, "Workflow repair signature nodeId"),
    cycleId: nullableText(value.cycleId, "Workflow repair signature cycleId"),
    visitOrdinal:
      value.visitOrdinal === null
        ? null
        : nonNegativeInteger(
            value.visitOrdinal,
            "Workflow repair signature visitOrdinal",
          ),
    findingCodes: normalizedValues(
      value.findingCodes as string[] | undefined,
      "Workflow repair signature findingCodes",
    ),
    failedReceiptCoverage: normalizedValues(
      value.failedReceiptCoverage as string[] | undefined,
      "Workflow repair signature failedReceiptCoverage",
    ),
    failedAcceptanceCoverage: normalizedValues(
      value.failedAcceptanceCoverage as string[] | undefined,
      "Workflow repair signature failedAcceptanceCoverage",
    ),
    scopeIdentities: normalizedValues(
      value.scopeIdentities as string[] | undefined,
      "Workflow repair signature scopeIdentities",
    ),
    snapshotIdentities: normalizedValues(
      value.snapshotIdentities as string[] | undefined,
      "Workflow repair signature snapshotIdentities",
    ),
    artifactIdentities: normalizedValues(
      value.artifactIdentities as string[] | undefined,
      "Workflow repair signature artifactIdentities",
    ),
    signatureHash: boundedText(
      value.signatureHash,
      "Workflow repair signature signatureHash",
    ),
  } satisfies WorkflowRepairFailureSignature;
  if (!HASH_PATTERN.test(signature.signatureHash)) {
    throw new Error("Workflow repair episode signature hash is invalid");
  }
  const expected = buildWorkflowRepairSignature({
    protocolHash: signature.protocolHash,
    executionHash: signature.executionHash,
    actionId: signature.actionId,
    attemptId: signature.attemptId,
    nodeId: signature.nodeId,
    cycleId: signature.cycleId,
    visitOrdinal: signature.visitOrdinal,
    findingCodes: signature.findingCodes,
    failedReceiptCoverage: signature.failedReceiptCoverage,
    failedAcceptanceCoverage: signature.failedAcceptanceCoverage,
    scopeIdentities: signature.scopeIdentities,
    snapshotIdentities: signature.snapshotIdentities,
    artifactIdentities: signature.artifactIdentities,
  });
  if (!sameStableValue(expected, signature)) {
    throw new Error("Workflow repair episode signature is not canonical");
  }
  return signature;
}

export function parseWorkflowRepairPendingDecision(
  value: unknown,
): WorkflowRepairPendingDecision {
  if (!isRecord(value)) {
    throw new Error("Workflow repair pending decision must be an object");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "decisionId",
    "actionId",
    "signatureHash",
    "failureRevision",
    "attemptId",
    "stepId",
    "nodeId",
    "cycleId",
    "visitOrdinal",
    "retryOrdinal",
    "choices",
    "rationale",
    "reviewer",
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow repair pending decision has unknown field: ${unknown}`,
    );
  }
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error(
      "Workflow repair pending decision schema version is unsupported",
    );
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error("Workflow repair pending decision choices are invalid");
  }
  const choices = value.choices.map((entry, index) => {
    const choice = normalizeChoice(entry, index);
    return choice;
  });
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new Error("Workflow repair pending decision choices are duplicated");
  }
  if (
    !isRecord(value.rationale) ||
    typeof value.rationale.required !== "boolean"
  ) {
    throw new Error("Workflow repair pending decision rationale is invalid");
  }
  if (!isRecord(value.reviewer)) {
    throw new Error("Workflow repair pending decision reviewer is invalid");
  }
  const reviewer = normalizeReviewer(value.reviewer);
  const signatureHash = boundedText(
    value.signatureHash,
    "Workflow repair pending decision signatureHash",
  );
  if (!HASH_PATTERN.test(signatureHash)) {
    throw new Error(
      "Workflow repair pending decision signature hash is invalid",
    );
  }
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    decisionId: boundedText(
      value.decisionId,
      "Workflow repair pending decision decisionId",
    ),
    actionId: boundedText(
      value.actionId,
      "Workflow repair pending decision actionId",
    ),
    signatureHash,
    failureRevision: nonNegativeInteger(
      value.failureRevision,
      "Workflow repair pending decision failureRevision",
    ),
    attemptId: boundedText(
      value.attemptId,
      "Workflow repair pending decision attemptId",
    ),
    stepId: boundedText(
      value.stepId,
      "Workflow repair pending decision stepId",
    ),
    nodeId: boundedText(
      value.nodeId,
      "Workflow repair pending decision nodeId",
    ),
    cycleId: nullableText(
      value.cycleId,
      "Workflow repair pending decision cycleId",
    ),
    visitOrdinal: positiveInteger(
      value.visitOrdinal,
      "Workflow repair pending decision visitOrdinal",
    ),
    retryOrdinal: nonNegativeInteger(
      value.retryOrdinal,
      "Workflow repair pending decision retryOrdinal",
    ),
    choices,
    rationale: { required: value.rationale.required },
    reviewer,
  };
}

export function parseWorkflowRepairEpisode(
  value: unknown,
  maxRecords = WORKFLOW_REPAIR_MAX_HISTORY_RECORDS,
): WorkflowRepairEpisodeState {
  if (!isRecord(value)) {
    throw new Error("Workflow repair episode must be an object");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "history",
    "signature",
    "disposition",
    "reasonCode",
    "consecutiveFailures",
    "totalFailures",
    "remainingFailures",
    "pendingDecision",
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown)
    throw new Error(`Workflow repair episode has unknown field: ${unknown}`);
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error("Workflow repair episode schema version is unsupported");
  }
  if (!Array.isArray(value.history)) {
    throw new Error("Workflow repair episode history must be an array");
  }
  const history = historyArray(
    value.history as WorkflowRepairHistoryRecord[],
    maxRecords,
  );
  const signature =
    value.signature === null ? null : parseSignature(value.signature);
  const dispositions = new Set<WorkflowRepairDisposition>([
    "continue",
    "warning",
    "manual-stop",
    "hard-stop",
  ]);
  if (
    value.disposition !== null &&
    !dispositions.has(value.disposition as WorkflowRepairDisposition)
  ) {
    throw new Error("Workflow repair episode disposition is invalid");
  }
  const reasonCode = nullableText(
    value.reasonCode,
    "Workflow repair episode reasonCode",
  );
  if (
    reasonCode !== null &&
    !REPAIR_REASON_CODES.includes(
      reasonCode as (typeof REPAIR_REASON_CODES)[number],
    )
  ) {
    throw new Error("Workflow repair episode reasonCode is invalid");
  }
  const consecutiveFailures = nonNegativeInteger(
    value.consecutiveFailures,
    "Workflow repair episode consecutiveFailures",
  );
  const totalFailures = nonNegativeInteger(
    value.totalFailures,
    "Workflow repair episode totalFailures",
  );
  const remainingFailures = nonNegativeInteger(
    value.remainingFailures,
    "Workflow repair episode remainingFailures",
  );
  const failureCount = history.filter(
    (record) => record.kind === "failure",
  ).length;
  const automaticExecutionCounts = new Map<string, number>();
  for (const record of history) {
    if (record.kind !== "failure" || !record.automaticRepair) continue;
    const count =
      (automaticExecutionCounts.get(record.automaticRepair.id) ?? 0) + 1;
    if (count > record.automaticRepair.maxExecutions) {
      throw new Error(
        "Workflow repair automatic operation history exceeds its bound",
      );
    }
    automaticExecutionCounts.set(record.automaticRepair.id, count);
  }
  if (
    failureCount !== totalFailures ||
    (totalFailures === 0 && signature !== null)
  ) {
    throw new Error(
      "Workflow repair episode failure counters are inconsistent",
    );
  }
  const latestFailure = [...history]
    .reverse()
    .find(
      (record): record is WorkflowRepairFailureRecord =>
        record.kind === "failure",
    );
  if (
    (latestFailure === undefined && signature !== null) ||
    (latestFailure !== undefined &&
      signature?.signatureHash !== latestFailure.signatureHash)
  ) {
    throw new Error(
      "Workflow repair episode signature is inconsistent with history",
    );
  }
  const pendingDecision =
    value.pendingDecision === undefined
      ? undefined
      : parseWorkflowRepairPendingDecision(value.pendingDecision);
  if (
    pendingDecision &&
    signature?.signatureHash !== pendingDecision.signatureHash
  ) {
    throw new Error(
      "Workflow repair pending decision signature is inconsistent",
    );
  }
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    history,
    signature,
    disposition:
      (value.disposition as WorkflowRepairDisposition | null) ?? null,
    reasonCode,
    consecutiveFailures,
    totalFailures,
    remainingFailures,
    ...(pendingDecision ? { pendingDecision } : {}),
  };
}

export function workflowRepairFailureRecord(
  revision: number,
  signature: WorkflowRepairFailureSignature,
): WorkflowRepairFailureRecord {
  return {
    kind: "failure",
    revision: nonNegativeInteger(revision, "Workflow repair failure revision"),
    actionId: signature.actionId,
    attemptId: signature.attemptId,
    signatureHash: signature.signatureHash,
    findingCodes: [...signature.findingCodes],
    failedReceiptCoverage: [...signature.failedReceiptCoverage],
    failedAcceptanceCoverage: [...signature.failedAcceptanceCoverage],
    scopeIdentities: [...signature.scopeIdentities],
    snapshotIdentities: [...signature.snapshotIdentities],
    artifactIdentities: [...signature.artifactIdentities],
  };
}

function isStrictSubset(
  current: readonly string[],
  previous: readonly string[],
): boolean {
  const previousSet = new Set(previous);
  return (
    current.length < previous.length &&
    current.every((value) => previousSet.has(value))
  );
}

function semanticProgress(
  current: WorkflowRepairFailureRecord,
  previous: WorkflowRepairFailureRecord,
): boolean {
  const failingSets = [
    [current.findingCodes, previous.findingCodes],
    [current.failedReceiptCoverage, previous.failedReceiptCoverage],
    [current.failedAcceptanceCoverage, previous.failedAcceptanceCoverage],
  ] as const;
  const reducedFailureSet =
    failingSets.every(([now, before]) =>
      now.every((value) => before.includes(value)),
    ) && failingSets.some(([now, before]) => isStrictSubset(now, before));
  const previousScope = new Set([
    ...previous.scopeIdentities,
    ...previous.snapshotIdentities,
    ...previous.artifactIdentities,
  ]);
  const newlyVerifiedScope = [
    ...current.scopeIdentities,
    ...current.snapshotIdentities,
    ...current.artifactIdentities,
  ].some((value) => !previousScope.has(value));
  return reducedFailureSet || newlyVerifiedScope;
}

export function workflowRepairConsecutiveFailures(
  current: WorkflowRepairFailureRecord,
  history: readonly WorkflowRepairHistoryRecord[],
): number {
  const failures = history.filter(
    (record): record is WorkflowRepairFailureRecord =>
      record.kind === "failure",
  );
  let consecutive = 1;
  let later = current;
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const previous = failures[index];
    if (
      later.signatureHash !== previous.signatureHash ||
      semanticProgress(later, previous)
    ) {
      break;
    }
    consecutive += 1;
    later = previous;
  }
  return consecutive;
}

function validateOverride(
  request: WorkflowRepairOverrideRequest,
  signature: WorkflowRepairFailureSignature,
  policy: NormalizedWorkflowRepairPolicy,
  history: readonly WorkflowRepairHistoryRecord[],
): { alreadyUsed: boolean; rationale: string; hypothesis: string } {
  if (!policy.allowOneTimeOverride) {
    throw new Error("Workflow repair override is not allowed by policy");
  }
  if (request.expectedSignatureHash !== signature.signatureHash) {
    throw new Error(
      "Workflow repair override does not match the current failure signature",
    );
  }
  const rationale = (request.rationale ?? request.summary ?? "").trim();
  const hypothesis = (request.hypothesis ?? request.summary ?? "").trim();
  if (
    rationale.length === 0 ||
    hypothesis.length === 0 ||
    Buffer.byteLength(rationale, "utf8") > policy.maxOverrideRationaleBytes ||
    Buffer.byteLength(hypothesis, "utf8") > policy.maxOverrideRationaleBytes
  ) {
    throw new Error(
      "Workflow repair override rationale and hypothesis are outside their bounds",
    );
  }
  return {
    alreadyUsed: history.some(
      (record) =>
        record.kind === "override" &&
        record.signatureHash === signature.signatureHash,
    ),
    rationale,
    hypothesis,
  };
}

export function decideWorkflowRepair(options: {
  facts: WorkflowRepairFailureFacts;
  history: readonly WorkflowRepairHistoryRecord[];
  policy: WorkflowRepairPolicy | NormalizedWorkflowRepairPolicy;
  override?: WorkflowRepairOverrideRequest | null;
  maxHistoryRecords?: number;
}): WorkflowRepairDecision {
  const signature = buildWorkflowRepairSignature(options.facts);
  const policy = normalizeWorkflowRepairPolicy(options.policy);
  const history = historyArray(options.history, options.maxHistoryRecords);
  const current = workflowRepairFailureRecord(
    (history.at(-1)?.revision ?? 0) + 1,
    signature,
  );
  const failures = history.filter(
    (record): record is WorkflowRepairFailureRecord =>
      record.kind === "failure",
  );
  const totalFailures = failures.length + 1;
  const consecutiveFailures = workflowRepairConsecutiveFailures(
    current,
    history,
  );
  const automaticLimit = Math.min(
    ...policy.automaticRepairs.map((operation) => operation.maxExecutions),
  );
  const effectiveMaxFailures = Math.min(policy.maxFailures, automaticLimit);
  const remainingFailures = Math.max(0, effectiveMaxFailures - totalFailures);
  const automaticRepair =
    totalFailures < effectiveMaxFailures &&
    consecutiveFailures < policy.manualStopThreshold
      ? (policy.automaticRepairs[0] ?? null)
      : null;
  const base = {
    signature,
    consecutiveFailures,
    totalFailures,
    remainingFailures,
    totalRepairFailures: totalFailures,
    remainingIterations: remainingFailures,
    automaticRepair,
  };
  if (totalFailures >= effectiveMaxFailures) {
    return {
      disposition: "hard-stop",
      reasonCode: "repair-iteration-limit",
      ...base,
      overrideAccepted: false,
    };
  }
  if (consecutiveFailures < policy.warningThreshold) {
    return {
      disposition: "continue",
      reasonCode: "new-failure-signature",
      ...base,
      overrideAccepted: false,
    };
  }
  if (consecutiveFailures < policy.manualStopThreshold) {
    return {
      disposition: "warning",
      reasonCode: "repeated-failure-warning",
      ...base,
      overrideAccepted: false,
    };
  }
  const alreadyUsed = history.some(
    (record) =>
      record.kind === "override" &&
      record.signatureHash === signature.signatureHash,
  );
  if (options.override) {
    const validated = validateOverride(
      options.override,
      signature,
      policy,
      history,
    );
    return {
      disposition: validated.alreadyUsed ? "manual-stop" : "continue",
      reasonCode: validated.alreadyUsed
        ? "override-already-used"
        : "override-accepted",
      ...base,
      overrideAccepted: !validated.alreadyUsed,
    };
  }
  return {
    disposition: "manual-stop",
    reasonCode: alreadyUsed ? "override-already-used" : "repeated-failure-stop",
    ...base,
    overrideAccepted: false,
  };
}

export function workflowRepairDecisionRecord(options: {
  revision: number;
  actionId: string;
  attemptId: string | null;
  signatureHash: string;
  decision: WorkflowRepairDecisionOutcome;
  maxRationaleBytes: number;
}): WorkflowRepairHistoryRecord {
  const rationale = options.decision.rationale?.trim() ?? "";
  const hypothesis = options.decision.hypothesis?.trim() ?? "";
  if (
    rationale.length > 0 &&
    Buffer.byteLength(rationale, "utf8") > options.maxRationaleBytes
  ) {
    throw new Error("Workflow repair decision rationale exceeds its bound");
  }
  if (
    hypothesis.length > 0 &&
    Buffer.byteLength(hypothesis, "utf8") > options.maxRationaleBytes
  ) {
    throw new Error("Workflow repair decision hypothesis exceeds its bound");
  }
  const isOverride = hypothesis.length > 0;
  if (isOverride) {
    return {
      kind: "override",
      revision: options.revision,
      actionId: options.actionId,
      attemptId: options.attemptId,
      signatureHash: options.signatureHash,
      decisionId: options.decision.decisionId,
      choiceId: options.decision.choiceId,
      outcome: options.decision.outcome,
      reviewer: {
        subject: options.decision.reviewer.subject,
        authorities: [...options.decision.reviewer.authorities].sort(
          (left, right) => left.localeCompare(right),
        ),
      },
      rationaleHash: hashText(rationale, "Workflow repair rationale"),
      hypothesisHash: hashText(hypothesis, "Workflow repair hypothesis"),
    };
  }
  return {
    kind: "decision",
    revision: options.revision,
    actionId: options.actionId,
    attemptId: options.attemptId,
    signatureHash: options.signatureHash,
    decisionId: options.decision.decisionId,
    choiceId: options.decision.choiceId,
    outcome: options.decision.outcome,
    reviewer: {
      subject: options.decision.reviewer.subject,
      authorities: [...options.decision.reviewer.authorities].sort(
        (left, right) => left.localeCompare(right),
      ),
    },
    rationaleHash:
      rationale.length > 0
        ? hashText(rationale, "Workflow repair rationale")
        : null,
    hypothesisHash: null,
  };
}

export function workflowRepairAction(
  pending: WorkflowRepairPendingDecision,
): EngineAction {
  return {
    id: pending.actionId,
    stepId: pending.stepId,
    type: "ask_user",
    decisionId: pending.decisionId,
    question: "The repair episode requires an explicit continuation decision.",
    choices: pending.choices.map(({ id, label }) => ({ id, label })),
    requiredInputs: { type: "object", fields: [] },
    rationale: structuredClone(pending.rationale),
    reviewer: structuredClone(pending.reviewer),
    attemptId: pending.attemptId,
    cycleId: pending.cycleId,
    visitOrdinal: pending.visitOrdinal,
    retryOrdinal: pending.retryOrdinal,
    repair: structuredClone(pending),
  };
}

export function isWorkflowRepairAction(
  action: EngineAction | null,
): action is EngineAction & { repair: WorkflowRepairPendingDecision } {
  return Boolean(action?.type === "ask_user" && action.repair);
}

export function repairEpisodeForFailure(options: {
  previous?: WorkflowRepairEpisodeState;
  decision: WorkflowRepairDecision;
  failure: WorkflowRepairFailureRecord;
  pendingDecision?: WorkflowRepairPendingDecision;
}): WorkflowRepairEpisodeState {
  const previous = options.previous;
  const history = [
    ...(previous?.history ?? []),
    {
      ...options.failure,
      disposition: options.decision.disposition,
      reasonCode: options.decision.reasonCode,
      consecutiveFailures: options.decision.consecutiveFailures,
      totalFailures: options.decision.totalFailures,
      remainingFailures: options.decision.remainingFailures,
      overrideAccepted: options.decision.overrideAccepted,
      ...(options.decision.automaticRepair
        ? { automaticRepair: structuredClone(options.decision.automaticRepair) }
        : {}),
    },
  ];
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    history,
    signature: structuredClone(options.decision.signature),
    disposition: options.decision.disposition,
    reasonCode: options.decision.reasonCode,
    consecutiveFailures: options.decision.consecutiveFailures,
    totalFailures: options.decision.totalFailures,
    remainingFailures: options.decision.remainingFailures,
    ...(options.pendingDecision
      ? { pendingDecision: structuredClone(options.pendingDecision) }
      : {}),
  };
}

export function repairEpisodeForDecision(options: {
  previous: WorkflowRepairEpisodeState;
  record: WorkflowRepairHistoryRecord;
  disposition: WorkflowRepairDisposition;
  reasonCode: string;
  pendingDecision?: undefined;
}): WorkflowRepairEpisodeState {
  const episode = structuredClone(options.previous);
  delete episode.pendingDecision;
  return {
    ...episode,
    history: [...options.previous.history, structuredClone(options.record)],
    disposition: options.disposition,
    reasonCode: options.reasonCode,
  };
}

export function workflowRepairProjection(
  episode: WorkflowRepairEpisodeState | undefined,
): WorkflowRepairEpisodeState | undefined {
  return episode ? structuredClone(episode) : undefined;
}
