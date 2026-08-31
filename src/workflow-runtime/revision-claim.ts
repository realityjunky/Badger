import { randomUUID } from "node:crypto";
import {
  readOptionalEngineRunText,
  writeEngineRunText,
} from "../engine/protected-run-file.js";
import type { RuntimeIdentity } from "../engine/types.js";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import type { WorkflowDurabilityProfile } from "../types.js";
import { stableValue, sha256 } from "../util.js";
import { parseWorkflowDurabilityProfile } from "./durability.js";

const CLAIM_DIRECTORY = ".comet/revision-claims";
const CLAIM_MAX_IDENTIFIER_LENGTH = 256;
const CLAIM_WAIT_TIMEOUT_MS = 5_000;
const CLAIM_POLL_INTERVAL_MS = 10;

export interface RevisionClaimInput {
  runId: string;
  expectedRevision: number;
  expectedActionId: string;
  intendedRevision: number;
  execution: RuntimeIdentity;
}

export interface WorkflowRevisionClaim {
  schemaVersion: 1;
  kind: "workflow-revision-claim";
  status: "prepared" | "committed";
  operation: "workflow.submit";
  runId: string;
  expectedRevision: number;
  expectedActionId: string;
  intendedRevision: number;
  execution: RuntimeIdentity;
  ownerToken: string;
  createdAt: string;
  committedAt?: string;
}

export interface RevisionClaimHandle {
  readonly claim: WorkflowRevisionClaim;
  readonly acquired: true;
  commit(): Promise<void>;
}

export interface ExistingRevisionClaim {
  readonly claim: WorkflowRevisionClaim;
  readonly acquired: false;
}

export type RevisionClaimResult = RevisionClaimHandle | ExistingRevisionClaim;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}

function requiredText(value: unknown, key: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CLAIM_MAX_IDENTIFIER_LENGTH ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}

function timestamp(value: unknown, key: string, label: string): string {
  const result = requiredText(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}

function nonNegativeInteger(
  value: unknown,
  key: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}

function hash(value: unknown, key: string, label: string): string {
  const result = requiredText(value, key, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}

export function parseExecutionIdentity(value: unknown): RuntimeIdentity {
  const label = "Workflow revision claim execution";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
      "findingCatalogVersion",
      "durabilityProfile",
    ]),
    label,
  );
  if (!isRecord(value.nodeToStep)) {
    throw new Error(`Invalid ${label}: nodeToStep must be an object`);
  }
  const nodeToStep: Record<string, string> = {};
  for (const [nodeId, stepId] of Object.entries(value.nodeToStep)) {
    nodeToStep[requiredText(nodeId, "nodeId", label)] = requiredText(
      stepId,
      `nodeToStep.${nodeId}`,
      label,
    );
  }
  if (value.capabilityVersion !== 3) {
    throw new Error(`Invalid ${label}: capabilityVersion is required`);
  }
  if (
    typeof value.resolverHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.resolverHash)
  ) {
    throw new Error(`Invalid ${label}: resolverHash is required`);
  }
  if (value.findingCatalogVersion !== 1) {
    throw new Error(`Invalid ${label}: findingCatalogVersion is required`);
  }
  if (value.durabilityProfile === undefined) {
    throw new Error(`Invalid ${label}: durabilityProfile is required`);
  }
  const durabilityProfile = parseWorkflowDurabilityProfile(
    value.durabilityProfile,
  );
  return {
    protocolHash: hash(value.protocolHash, "protocolHash", label),
    packageHash: hash(value.packageHash, "packageHash", label),
    snapshotHash: hash(value.snapshotHash, "snapshotHash", label),
    nodeToStep,
    ...(value.capabilityVersion === 3 ? { capabilityVersion: 3 as const } : {}),
    resolverHash: hash(value.resolverHash, "resolverHash", label),
    findingCatalogVersion: 1 as const,
    durabilityProfile,
  };
}

function parseClaim(value: unknown): WorkflowRevisionClaim {
  const label = "Workflow revision claim";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "status",
      "operation",
      "runId",
      "expectedRevision",
      "expectedActionId",
      "intendedRevision",
      "execution",
      "ownerToken",
      "createdAt",
      "committedAt",
    ]),
    label,
  );
  if (value.schemaVersion !== 1 || value.kind !== "workflow-revision-claim") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (value.status !== "prepared" && value.status !== "committed") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  if (value.operation !== "workflow.submit") {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  const expectedRevision = nonNegativeInteger(
    value.expectedRevision,
    "expectedRevision",
    label,
  );
  const intendedRevision = nonNegativeInteger(
    value.intendedRevision,
    "intendedRevision",
    label,
  );
  if (intendedRevision !== expectedRevision + 1) {
    throw new Error(`Invalid ${label}: revisions are not consecutive`);
  }
  const committedAt =
    value.committedAt === undefined
      ? undefined
      : requiredText(value.committedAt, "committedAt", label);
  if ((value.status === "committed") !== (committedAt !== undefined)) {
    throw new Error(`Invalid ${label}: committedAt does not match status`);
  }
  const ownerToken = requiredText(value.ownerToken, "ownerToken", label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      ownerToken,
    )
  ) {
    throw new Error(`Invalid ${label}: ownerToken is invalid`);
  }
  return {
    schemaVersion: 1,
    kind: "workflow-revision-claim",
    status: value.status,
    operation: "workflow.submit",
    runId: requiredText(value.runId, "runId", label),
    expectedRevision,
    expectedActionId: requiredText(
      value.expectedActionId,
      "expectedActionId",
      label,
    ),
    intendedRevision,
    execution: parseExecutionIdentity(value.execution),
    ownerToken,
    createdAt: timestamp(value.createdAt, "createdAt", label),
    ...(committedAt
      ? { committedAt: timestamp(committedAt, "committedAt", label) }
      : {}),
  };
}

export function revisionClaimPath(input: RevisionClaimInput): string {
  return `${CLAIM_DIRECTORY}/revision-${input.expectedRevision}-${sha256(input.expectedActionId).slice(0, 24)}-${input.intendedRevision}.json`;
}

function profileForExecution(
  execution: RuntimeIdentity,
): WorkflowDurabilityProfile {
  if (!execution.durabilityProfile) {
    throw new Error("Workflow revision claim requires a durability profile");
  }
  return parseWorkflowDurabilityProfile(execution.durabilityProfile);
}

function claimMatches(
  claim: WorkflowRevisionClaim,
  input: RevisionClaimInput,
): boolean {
  return (
    claim.runId === input.runId &&
    claim.expectedRevision === input.expectedRevision &&
    claim.expectedActionId === input.expectedActionId &&
    claim.intendedRevision === input.intendedRevision &&
    JSON.stringify(stableValue(claim.execution)) ===
      JSON.stringify(stableValue(input.execution))
  );
}

async function readClaim(
  runRoot: string,
  input: RevisionClaimInput,
): Promise<WorkflowRevisionClaim | null> {
  const raw = await readOptionalEngineRunText(
    runRoot,
    revisionClaimPath(input),
    profileForExecution(input.execution).bounds.claimBytes,
    "Workflow revision claim",
  );
  if (raw === null) return null;
  try {
    return parseClaim(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error("Workflow revision claim is malformed", { cause: error });
  }
}

function createClaim(input: RevisionClaimInput): WorkflowRevisionClaim {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.intendedRevision !== input.expectedRevision + 1
  ) {
    throw new Error("Workflow revision claim revisions are invalid");
  }
  return {
    schemaVersion: 1,
    kind: "workflow-revision-claim",
    status: "prepared",
    operation: "workflow.submit",
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    expectedActionId: input.expectedActionId,
    intendedRevision: input.intendedRevision,
    execution: structuredClone(input.execution),
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function serializeClaim(claim: WorkflowRevisionClaim): string {
  return `${JSON.stringify(stableValue(claim), null, 2)}\n`;
}

async function waitForExistingClaim(
  runRoot: string,
  input: RevisionClaimInput,
  existing: WorkflowRevisionClaim,
): Promise<WorkflowRevisionClaim> {
  const deadline = Date.now() + CLAIM_WAIT_TIMEOUT_MS;
  let current = existing;
  while (current.status === "prepared" && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CLAIM_POLL_INTERVAL_MS);
    });
    let next: WorkflowRevisionClaim | null;
    try {
      next = await readClaim(runRoot, input);
    } catch (error) {
      if (error instanceof RaceSafeReadError && error.reason === "changed") {
        continue;
      }
      throw error;
    }
    if (!next) return current;
    if (!claimMatches(next, input)) {
      throw new Error("Workflow revision claim identity changed");
    }
    current = next;
  }
  return current;
}

export async function acquireRevisionClaim(
  runRoot: string,
  input: RevisionClaimInput,
): Promise<RevisionClaimResult> {
  const candidate = createClaim(input);
  const relativePath = revisionClaimPath(input);
  const maxBytes = profileForExecution(input.execution).bounds.claimBytes;
  for (;;) {
    const existing = await readClaim(runRoot, input);
    if (existing) {
      if (!claimMatches(existing, input)) {
        throw new Error("Workflow revision claim identity changed");
      }
      return {
        acquired: false,
        claim: await waitForExistingClaim(runRoot, input, existing),
      };
    }
    try {
      await writeEngineRunText(
        runRoot,
        relativePath,
        serializeClaim(candidate),
        maxBytes,
        "Workflow revision claim",
        { exclusive: true },
      );
      return {
        acquired: true,
        claim: candidate,
        async commit() {
          const current = await readClaim(runRoot, input);
          if (!current) {
            throw new Error(
              "Workflow revision claim disappeared before commit",
            );
          }
          if (current.status === "committed") {
            if (!claimMatches(current, input)) {
              throw new Error("Workflow revision claim identity changed");
            }
            return;
          }
          const committed: WorkflowRevisionClaim = {
            ...candidate,
            status: "committed",
            committedAt: new Date().toISOString(),
          };
          await writeEngineRunText(
            runRoot,
            relativePath,
            serializeClaim(committed),
            maxBytes,
            "Workflow revision claim",
            {
              beforeCommit: async () => {
                const current = await readClaim(runRoot, input);
                if (
                  !current ||
                  current.status !== "prepared" ||
                  current.ownerToken !== candidate.ownerToken
                ) {
                  throw new Error(
                    "Workflow revision claim changed before commit",
                  );
                }
              },
            },
          );
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function commitExistingRevisionClaim(
  runRoot: string,
  input: RevisionClaimInput,
): Promise<void> {
  const existing = await readClaim(runRoot, input);
  if (!existing) return;
  if (existing.status === "committed") return;
  const committed: WorkflowRevisionClaim = {
    ...existing,
    status: "committed",
    committedAt: new Date().toISOString(),
  };
  const maxBytes = profileForExecution(input.execution).bounds.claimBytes;
  await writeEngineRunText(
    runRoot,
    revisionClaimPath(input),
    serializeClaim(committed),
    maxBytes,
    "Workflow revision claim",
    {
      beforeCommit: async () => {
        const current = await readClaim(runRoot, input);
        if (
          !current ||
          current.status !== "prepared" ||
          current.ownerToken !== existing.ownerToken
        ) {
          throw new Error("Workflow revision claim changed before commit");
        }
      },
    },
  );
}

export function committedRevisionClaimText(raw: string): string {
  let claim: WorkflowRevisionClaim;
  try {
    claim = parseClaim(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error("Workflow revision claim is malformed", { cause: error });
  }
  if (claim.status === "committed") return serializeClaim(claim);
  return serializeClaim({
    ...claim,
    status: "committed",
    committedAt: new Date().toISOString(),
  });
}
