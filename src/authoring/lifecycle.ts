import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState } from "../types.js";
import {
  atomicWrite,
  hashDirectory,
  isWithin,
  sha256,
  stableValue,
} from "../util.js";
import { writeState } from "../factory/state.js";
import { AUTHORING_LANE_IDS, AUTHORING_PROTOCOL_HASH } from "./protocol.js";
import { validateAuthoringPlan } from "./plan.js";
import type {
  AuthoringArtifactEvidence,
  AuthoringArtifactInput,
  AuthoringClaimEvidence,
  AuthoringLane,
  AuthoringLaneId,
  AuthoringPlan,
  AuthoringReadiness,
  AuthoringRecord,
  AuthoringRecordInput,
  AuthoringRecordSummary,
  AuthoringSessionStatus,
  AuthoringStatus,
} from "./types.js";
import type { GeneratedPackage } from "../factory/generate.js";

export const AUTHORING_GENERATOR_CONTRACT_VERSION = 1 as const;
const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const COMPLETE_STATUSES: readonly AuthoringStatus[] = ["COMPLETE", "DONE"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAuthoringLane(value: unknown): value is AuthoringLaneId {
  return (
    typeof value === "string" &&
    (AUTHORING_LANE_IDS as readonly string[]).includes(value)
  );
}

function isCompleteStatus(value: unknown): boolean {
  return COMPLETE_STATUSES.includes(value as AuthoringStatus);
}

function sessionRoot(state: CreatorState): string {
  return path.join(state.projectRoot, ".badger", "authoring", state.name);
}

function sessionPlanPath(state: CreatorState): string {
  return (
    (state.authoring
      ? path.join(sessionRoot(state), "plan.json")
      : undefined) ??
    state.generated?.authoringPlanPath ??
    path.join(sessionRoot(state), "plan.json")
  );
}

function recordsRoot(state: CreatorState): string {
  return path.join(sessionRoot(state), "records");
}

function recordFile(state: CreatorState, lane: AuthoringLaneId): string {
  return path.join(recordsRoot(state), `${lane}.json`);
}

function packageRoot(state: CreatorState): string {
  if (!state.generated?.packageRoot)
    throw new Error("Generate the workflow scaffold before authoring");
  return path.resolve(state.generated.packageRoot);
}

function packageLeafPath(root: string, leaf: string): string {
  if (path.isAbsolute(leaf))
    throw new Error(`Authoring content leaf must be relative: ${leaf}`);
  const normalized = leaf.replaceAll("\\", "/");
  const relative = normalized.startsWith("../")
    ? normalized.slice(3)
    : normalized;
  const target = path.resolve(root, relative);
  if (!isWithin(root, target))
    throw new Error(`Authoring content leaf escapes the package: ${leaf}`);
  return target;
}

function expectedClaims(lane: AuthoringLane): string[] {
  return [...lane.claims, ...lane.derivedClaims];
}

function laneDefinition(
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
): AuthoringLane {
  const definition = plan.lanes.find((item) => item.id === lane);
  if (!definition) throw new Error(`Unknown authoring lane: ${lane}`);
  return definition;
}

function authoringInputHash(plan: AuthoringPlan): string {
  return sha256(
    JSON.stringify(
      stableValue({
        authoringPlanHash: plan.authoringPlanHash,
        generatorContractVersion: AUTHORING_GENERATOR_CONTRACT_VERSION,
        planHash: plan.planHash,
        protocolHash: plan.protocolHash,
        sourceEvidenceHash: plan.sourceEvidenceHash,
        workflowProtocolHash: plan.workflowProtocolHash,
      }),
    ),
  );
}

function canonicalRecord(record: AuthoringRecord): unknown {
  return {
    workflow: record.workflow,
    lane: record.lane,
    status: record.status,
    protocolHash: record.protocolHash,
    authoringPlanHash: record.authoringPlanHash,
    workflowProtocolHash: record.workflowProtocolHash,
    sourceEvidenceHash: record.sourceEvidenceHash,
    authoringInputHash: record.authoringInputHash,
    claims: [...record.claims]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((claim) => ({
        id: claim.id,
        status: claim.status,
        evidence: [...claim.evidence],
      })),
    artifacts: [...record.artifacts]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        present: artifact.present,
        contentHash: artifact.contentHash ?? null,
      })),
    review: record.review
      ? {
          decision: record.review.decision,
          reviewer: record.review.reviewer,
          summary: record.review.summary,
          blockingFindings: [...record.review.blockingFindings],
          warnings: [...record.review.warnings],
          contractFit: record.review.contractFit ?? null,
          usability: record.review.usability ?? null,
        }
      : null,
    summary: record.summary ?? null,
  };
}

function recordMaterialHash(record: AuthoringRecord): string {
  return sha256(JSON.stringify(stableValue(canonicalRecord(record))));
}

function recordsMaterialHash(
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): string {
  return sha256(
    JSON.stringify(
      stableValue(
        AUTHORING_LANE_IDS.map((lane) => {
          const record = records[lane];
          return record ? canonicalRecord(record) : { lane, missing: true };
        }),
      ),
    ),
  );
}

function recordSummary(
  record: AuthoringRecord,
  file: string,
): AuthoringRecordSummary {
  return {
    path: file,
    status: record.status,
    authoringInputHash: record.authoringInputHash,
    authoredMaterialHash: record.authoredMaterialHash,
  };
}

function statusRequiresCompleteEvidence(status: AuthoringStatus): boolean {
  return status === "COMPLETE" || status === "DONE";
}

function validRecordStatuses(): readonly AuthoringStatus[] {
  return [
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "DONE",
    "DONE_WITH_CONCERNS",
    "BLOCKED",
    "NEEDS_CONTEXT",
  ];
}

function validateReview(value: unknown, required: boolean): string[] {
  if (value === undefined || value === null)
    return required ? ["authoring review is required"] : [];
  if (!isRecord(value)) return ["authoring review must be an object"];
  const findings: string[] = [];
  if (
    !["approved", "rejected", "needs_context"].includes(String(value.decision))
  )
    findings.push("authoring review decision is invalid");
  if (typeof value.reviewer !== "string" || !value.reviewer.trim())
    findings.push("authoring review reviewer is required");
  if (typeof value.summary !== "string" || !value.summary.trim())
    findings.push("authoring review summary is required");
  if (!Array.isArray(value.blockingFindings))
    findings.push("authoring review blockingFindings must be an array");
  if (!Array.isArray(value.warnings))
    findings.push("authoring review warnings must be an array");
  if (
    value.decision === "approved" &&
    Array.isArray(value.blockingFindings) &&
    value.blockingFindings.length > 0
  )
    findings.push("approved authoring review cannot contain blocking findings");
  for (const field of ["contractFit", "usability"] as const) {
    if (
      value[field] !== undefined &&
      !["pass", "fail", "needs_context"].includes(String(value[field]))
    )
      findings.push(`authoring review ${field} is invalid`);
  }
  return findings;
}

export function validateAuthoringRecord(
  value: unknown,
  plan: AuthoringPlan,
  expectedLane?: AuthoringLaneId,
): string[] {
  const record = isRecord(value) ? value : null;
  if (!record) return ["authoring record must be an object"];
  const laneValue = expectedLane ?? record.lane;
  if (!isAuthoringLane(laneValue))
    return [`unknown authoring lane: ${String(laneValue)}`];
  const lane = laneDefinition(plan, laneValue);
  const findings: string[] = [];
  if (record.lane !== undefined && record.lane !== laneValue)
    findings.push(`authoring record lane mismatch: ${String(record.lane)}`);
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1)
    findings.push("authoring record schemaVersion must be 1");
  if (record.kind !== undefined && record.kind !== "authoring-record")
    findings.push("authoring record kind is invalid");
  if (record.workflow !== undefined && record.workflow !== plan.name)
    findings.push("authoring record workflow does not match the plan");
  if (
    record.protocolHash !== undefined &&
    record.protocolHash !== plan.protocolHash
  )
    findings.push("authoring record protocolHash is stale");
  for (const [field, expected] of [
    ["authoringPlanHash", plan.authoringPlanHash],
    ["workflowProtocolHash", plan.workflowProtocolHash],
    ["sourceEvidenceHash", plan.sourceEvidenceHash],
  ] as const) {
    if (record[field] !== undefined && record[field] !== expected)
      findings.push(`authoring record ${field} is stale`);
  }
  for (const field of [
    "authoringPlanHash",
    "workflowProtocolHash",
    "sourceEvidenceHash",
    "authoringInputHash",
    "authoredMaterialHash",
  ]) {
    if (
      record[field] !== undefined &&
      !HASH_PATTERN.test(String(record[field]))
    )
      findings.push(`authoring record ${field} must be a SHA-256 hash`);
  }
  const status = record.status as AuthoringStatus;
  if (!validRecordStatuses().includes(status))
    findings.push(`invalid authoring status: ${String(record.status)}`);

  const claims = Array.isArray(record.claims) ? record.claims : [];
  const requiredClaimIds = expectedClaims(lane);
  const claimIds = new Set<string>();
  for (const [index, claimValue] of claims.entries()) {
    if (!isRecord(claimValue)) {
      findings.push(`authoring claim at index ${index} must be an object`);
      continue;
    }
    const id = claimValue.id;
    if (typeof id !== "string" || !id.trim()) {
      findings.push(`authoring claim at index ${index} requires an id`);
    } else if (claimIds.has(id)) {
      findings.push(`duplicate authoring claim: ${id}`);
    } else {
      claimIds.add(id);
      if (!requiredClaimIds.includes(id))
        findings.push(`unknown authoring claim: ${id}`);
    }
    if (
      !["SUPPORTED", "UNSUPPORTED", "NEEDS_CONTEXT"].includes(
        String(claimValue.status),
      )
    )
      findings.push(
        `invalid authoring claim status: ${String(claimValue.status)}`,
      );
    if (
      !Array.isArray(claimValue.evidence) ||
      claimValue.evidence.some((item) => typeof item !== "string")
    )
      findings.push(`invalid evidence for authoring claim: ${String(id)}`);
  }
  if (statusRequiresCompleteEvidence(status)) {
    for (const id of requiredClaimIds) {
      const claim = claims.find((item) => isRecord(item) && item.id === id);
      if (!claim) findings.push(`missing authoring claim: ${id}`);
      else if (claim.status !== "SUPPORTED")
        findings.push(`complete authoring claim is not supported: ${id}`);
      else if (!Array.isArray(claim.evidence) || claim.evidence.length === 0)
        findings.push(`complete authoring claim has no evidence: ${id}`);
    }
  }

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const allowedLeaves = new Set(lane.contentLeaves);
  const artifactPaths = new Set<string>();
  for (const [index, artifactValue] of artifacts.entries()) {
    if (!isRecord(artifactValue)) {
      findings.push(`authoring artifact at index ${index} must be an object`);
      continue;
    }
    const artifactPath = artifactValue.path;
    if (typeof artifactPath !== "string" || !artifactPath.trim()) {
      findings.push(`authoring artifact at index ${index} requires a path`);
      continue;
    }
    if (!allowedLeaves.has(artifactPath))
      findings.push(`unknown authoring artifact path: ${artifactPath}`);
    if (artifactPaths.has(artifactPath))
      findings.push(`duplicate authoring artifact path: ${artifactPath}`);
    artifactPaths.add(artifactPath);
    if (typeof artifactValue.id !== "string" || !artifactValue.id.trim())
      findings.push(`authoring artifact id is required: ${artifactPath}`);
    if (typeof artifactValue.present !== "boolean")
      findings.push(`authoring artifact presence is invalid: ${artifactPath}`);
    if (
      artifactValue.contentHash !== undefined &&
      !HASH_PATTERN.test(String(artifactValue.contentHash))
    )
      findings.push(`authoring artifact hash is invalid: ${artifactPath}`);
  }
  if (statusRequiresCompleteEvidence(status)) {
    for (const leaf of lane.contentLeaves)
      if (!artifactPaths.has(leaf))
        findings.push(`missing authoring artifact: ${leaf}`);
    for (const artifactValue of artifacts) {
      if (isRecord(artifactValue) && artifactValue.present !== true)
        findings.push(
          `complete authoring artifact is missing: ${String(artifactValue.path)}`,
        );
    }
  }
  if (
    ["BLOCKED", "NEEDS_CONTEXT", "DONE_WITH_CONCERNS"].includes(status) &&
    (typeof record.summary !== "string" || !record.summary.trim())
  )
    findings.push(`${status} authoring records require a summary`);
  findings.push(
    ...validateReview(
      record.review,
      lane.id === "skill-review" && statusRequiresCompleteEvidence(status),
    ),
  );
  if (
    lane.id === "skill-review" &&
    statusRequiresCompleteEvidence(status) &&
    (!isRecord(record.review) || record.review.decision !== "approved")
  )
    findings.push("skill-review must have an approved authoring review");
  return findings;
}

export async function readAuthoringPlan(
  state: CreatorState,
): Promise<AuthoringPlan> {
  if (state.authoring) {
    const expectedRoot = sessionRoot(state);
    if (
      state.authoring.sessionPath !== expectedRoot ||
      state.authoring.planPath !== path.join(expectedRoot, "plan.json") ||
      state.authoring.recordsPath !== path.join(expectedRoot, "records")
    )
      throw new Error("Authoring session paths are invalid");
  }
  const file = sessionPlanPath(state);
  const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const findings = validateAuthoringPlan(value, { requireExtensions: true });
  if (findings.length)
    throw new Error(
      `Invalid authoring plan:\n${findings.map((finding) => finding.message).join("\n")}`,
    );
  return value as AuthoringPlan;
}

async function acquireSessionLock(root: string): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, ".lock");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const handle = await fs.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => {
        await fs.rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Authoring session is busy; retry the same operation");
}

async function withSessionLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireSessionLock(root);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readStoredRecords(
  state: CreatorState,
  plan: AuthoringPlan,
): Promise<{
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
  errors: string[];
}> {
  const records: Partial<Record<AuthoringLaneId, AuthoringRecord>> = {};
  const errors: string[] = [];
  for (const lane of AUTHORING_LANE_IDS) {
    const file = recordFile(state, lane);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const findings = validateAuthoringRecord(value, plan, lane);
      if (findings.length) {
        errors.push(`invalid authoring record ${lane}: ${findings.join("; ")}`);
      } else {
        records[lane] = value as AuthoringRecord;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`cannot read authoring record ${lane}: ${String(error)}`);
    }
  }
  return { records, errors };
}

function summaryStatus(
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): AuthoringSessionStatus {
  if (
    AUTHORING_LANE_IDS.every((lane) => isCompleteStatus(records[lane]?.status))
  )
    return "authored";
  return Object.keys(records).length ? "in-progress" : "pending";
}

async function writeSessionSummary(state: CreatorState): Promise<void> {
  if (!state.authoring) return;
  await atomicWrite(
    path.join(sessionRoot(state), "state.json"),
    JSON.stringify(state.authoring, null, 2) + "\n",
  );
}

export async function initializeAuthoringSession(options: {
  state: CreatorState;
  plan: AuthoringPlan;
  generated: GeneratedPackage;
}): Promise<CreatorState> {
  const planFindings = validateAuthoringPlan(options.plan, {
    requireExtensions: true,
  });
  if (planFindings.length)
    throw new Error(
      `Invalid authoring plan:\n${planFindings.map((finding) => finding.message).join("\n")}`,
    );
  const state = options.state;
  if (state.name !== options.plan.name)
    throw new Error(
      "Authoring plan workflow name does not match Creator state",
    );
  const root = sessionRoot(state);
  const inputHash = authoringInputHash(options.plan);
  return withSessionLock(root, async () => {
    const previous = state.authoring;
    const sameInput = previous?.authoringInputHash === inputHash;
    await fs.mkdir(recordsRoot(state), { recursive: true });
    await atomicWrite(
      path.join(root, "plan.json"),
      JSON.stringify(options.plan, null, 2) + "\n",
    );
    const retainedRecords = previous?.records ?? {};
    const retainedLanes = AUTHORING_LANE_IDS.filter(
      (lane) => retainedRecords[lane] !== undefined,
    );
    const invalidatedLanes = sameInput
      ? previous?.invalidatedLanes
      : retainedLanes.length
        ? retainedLanes
        : undefined;
    const generated: CreatorState["generated"] = {
      ...options.generated,
      authoringPlanPath:
        options.generated.authoringPlanPath ??
        path.join(
          options.generated.packageRoot,
          "reference",
          "authoring-plan.json",
        ),
    };
    state.generated = generated;
    state.authoring = {
      schemaVersion: 1,
      status: sameInput
        ? previous?.status === "assembled"
          ? "in-progress"
          : (previous?.status ?? "pending")
        : previous
          ? "stale"
          : "pending",
      sessionPath: root,
      planPath: path.join(root, "plan.json"),
      recordsPath: recordsRoot(state),
      revision: (previous?.revision ?? 0) + 1,
      generatorContractVersion: AUTHORING_GENERATOR_CONTRACT_VERSION,
      planHash: options.plan.planHash,
      protocolHash: options.plan.protocolHash,
      workflowProtocolHash: options.plan.workflowProtocolHash,
      sourceEvidenceHash: options.plan.sourceEvidenceHash,
      authoringPlanHash: options.plan.authoringPlanHash,
      authoringInputHash: inputHash,
      scaffoldHash:
        options.generated.scaffoldHash ?? previous?.scaffoldHash ?? "",
      authoredMaterialHash: sameInput
        ? (previous?.authoredMaterialHash ?? null)
        : null,
      assembledPackageHash: null,
      records: sameInput ? retainedRecords : retainedRecords,
      ...(invalidatedLanes?.length ? { invalidatedLanes } : {}),
    };
    state.currentHash = null;
    state.eval = undefined;
    state.review = undefined;
    state.status = "generated";
    await writeSessionSummary(state);
    await writeState(state);
    return state;
  });
}

function artifactInput(value: unknown): AuthoringArtifactInput | null {
  if (!isRecord(value)) return null;
  return value as unknown as AuthoringArtifactInput;
}

function claimInput(value: unknown): AuthoringClaimEvidence | null {
  if (!isRecord(value)) return null;
  return value as unknown as AuthoringClaimEvidence;
}

function summaryWithinBounds(summary: unknown): summary is string {
  return (
    typeof summary === "string" &&
    Buffer.byteLength(summary, "utf8") <= MAX_SUMMARY_BYTES
  );
}

async function materializeArtifact(
  state: CreatorState,
  lane: AuthoringLaneId,
  input: AuthoringArtifactInput,
): Promise<{ artifact: AuthoringArtifactEvidence; content?: string }> {
  if (typeof input.path !== "string" || !input.path.trim())
    throw new Error("Authoring artifact path is required");
  if (typeof input.id !== "string" || !input.id.trim())
    throw new Error(`Authoring artifact id is required: ${input.path}`);
  if (typeof input.present !== "boolean")
    throw new Error(`Authoring artifact presence is invalid: ${input.path}`);
  let contentHash = input.contentHash;
  let contentPath: string | undefined;
  let content: string | undefined;
  if (input.content !== undefined) {
    if (typeof input.content !== "string")
      throw new Error(`Authoring artifact content is invalid: ${input.path}`);
    if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES)
      throw new Error(`Authoring artifact content is too large: ${input.path}`);
    if (!input.content.trim())
      throw new Error(`Authoring artifact content is empty: ${input.path}`);
    if (input.content.includes("AUTHORING PENDING"))
      throw new Error(
        `Authoring artifact contains a pending marker: ${input.path}`,
      );
    if (/^---\s*$/mu.test(input.content))
      throw new Error(
        `Authoring artifact cannot replace package frontmatter: ${input.path}`,
      );
    content = input.content;
    contentHash = sha256(input.content);
    contentPath = path.join(
      sessionRoot(state),
      "artifacts",
      lane,
      `${sha256(input.path)}.md`,
    );
  } else if (input.contentPath !== undefined) {
    const suppliedPath = path.resolve(state.projectRoot, input.contentPath);
    if (!isWithin(state.projectRoot, suppliedPath))
      throw new Error(
        `Authoring artifact content path escapes the project: ${input.path}`,
      );
    const suppliedContent = await fs.readFile(suppliedPath, "utf8");
    if (Buffer.byteLength(suppliedContent, "utf8") > MAX_ARTIFACT_BYTES)
      throw new Error(`Authoring artifact content is too large: ${input.path}`);
    if (!suppliedContent.trim())
      throw new Error(`Authoring artifact content is empty: ${input.path}`);
    if (suppliedContent.includes("AUTHORING PENDING"))
      throw new Error(
        `Authoring artifact contains a pending marker: ${input.path}`,
      );
    if (/^---\s*$/mu.test(suppliedContent))
      throw new Error(
        `Authoring artifact cannot replace package frontmatter: ${input.path}`,
      );
    contentHash = sha256(suppliedContent);
    contentPath = path.join(
      sessionRoot(state),
      "artifacts",
      lane,
      `${sha256(input.path)}.md`,
    );
    content = suppliedContent;
  }
  if (input.contentHash !== undefined && input.contentHash !== contentHash)
    throw new Error(
      `Authoring artifact hash does not match content: ${input.path}`,
    );
  if (contentHash !== undefined && !HASH_PATTERN.test(contentHash))
    throw new Error(`Authoring artifact hash is invalid: ${input.path}`);
  return {
    artifact: {
      id: input.id,
      path: input.path,
      present: input.present,
      ...(contentHash ? { contentHash } : {}),
      ...(contentPath ? { contentPath } : {}),
    },
    ...(content !== undefined ? { content } : {}),
  };
}

export async function recordAuthoring(options: {
  state: CreatorState;
  lane: AuthoringLaneId;
  record: unknown;
}): Promise<AuthoringRecord> {
  if (!isAuthoringLane(options.lane))
    throw new Error(`Unknown authoring lane: ${String(options.lane)}`);
  if (!options.state.generated)
    throw new Error(
      "Generate the workflow scaffold before recording authoring",
    );
  const plan = await readAuthoringPlan(options.state);
  if (!options.state.authoring) {
    await initializeAuthoringSession({
      state: options.state,
      plan,
      generated: options.state.generated as GeneratedPackage,
    });
  }
  const root = sessionRoot(options.state);
  return withSessionLock(root, async () => {
    const input = isRecord(options.record)
      ? (options.record as unknown as AuthoringRecordInput)
      : null;
    if (!input) throw new Error("Authoring record must be an object");
    if (input.lane !== undefined && input.lane !== options.lane)
      throw new Error(`Authoring record lane mismatch: ${String(input.lane)}`);
    if (!validRecordStatuses().includes(input.status))
      throw new Error(`Invalid authoring status: ${String(input.status)}`);
    const lane = laneDefinition(plan, options.lane);
    const currentInputHash = authoringInputHash(plan);
    if (options.state.authoring!.authoringInputHash !== currentInputHash)
      throw new Error("Authoring session input evidence is stale");
    for (const [field, expected] of [
      ["protocolHash", plan.protocolHash],
      ["authoringPlanHash", plan.authoringPlanHash],
      ["workflowProtocolHash", plan.workflowProtocolHash],
      ["sourceEvidenceHash", plan.sourceEvidenceHash],
      ["authoringInputHash", options.state.authoring?.authoringInputHash],
    ] as const) {
      if (input[field] !== undefined && input[field] !== expected)
        throw new Error(`Authoring record ${field} is stale`);
    }
    const stored = await readStoredRecords(options.state, plan);
    for (const dependency of lane.dependencies) {
      const dependencyRecord = stored.records[dependency];
      if (!dependencyRecord || !isCompleteStatus(dependencyRecord.status))
        throw new Error(
          `Authoring lane ${options.lane} is blocked by ${dependency}`,
        );
      if (
        dependencyRecord.authoringInputHash !==
        options.state.authoring!.authoringInputHash
      )
        throw new Error(
          `Authoring lane ${options.lane} is blocked by stale ${dependency} evidence`,
        );
    }
    const claims = (input.claims ?? []).map(claimInput);
    if (claims.some((claim) => claim === null))
      throw new Error("Authoring claims must be objects");
    const artifacts = (input.artifacts ?? []).map(artifactInput);
    if (artifacts.some((artifact) => artifact === null))
      throw new Error("Authoring artifacts must be objects");
    const allowedLeaves = new Set(lane.contentLeaves);
    const artifactPaths = new Set<string>();
    for (const artifact of artifacts) {
      if (!artifact) continue;
      if (!allowedLeaves.has(artifact.path))
        throw new Error(`Unknown authoring artifact path: ${artifact.path}`);
      if (artifactPaths.has(artifact.path))
        throw new Error(`Duplicate authoring artifact path: ${artifact.path}`);
      artifactPaths.add(artifact.path);
    }
    const normalizedArtifacts: AuthoringArtifactEvidence[] = [];
    const pendingArtifacts: Array<{ path: string; content: string }> = [];
    for (const artifact of artifacts) {
      if (!artifact) continue;
      const materialized = await materializeArtifact(
        options.state,
        options.lane,
        artifact,
      );
      normalizedArtifacts.push(materialized.artifact);
      if (
        materialized.content !== undefined &&
        materialized.artifact.contentPath
      )
        pendingArtifacts.push({
          path: materialized.artifact.contentPath,
          content: materialized.content,
        });
    }
    const summary = input.summary;
    if (
      summary !== undefined &&
      (typeof summary !== "string" || !summaryWithinBounds(summary))
    )
      throw new Error("Authoring record summary is missing or too large");
    const record: AuthoringRecord = {
      schemaVersion: 1,
      kind: "authoring-record",
      workflow: plan.name,
      lane: options.lane,
      status: input.status,
      protocolHash: plan.protocolHash,
      authoringPlanHash: plan.authoringPlanHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
      authoringInputHash: currentInputHash,
      authoredMaterialHash: "0".repeat(64),
      claims: claims as AuthoringClaimEvidence[],
      artifacts: normalizedArtifacts,
      ...(input.review ? { review: input.review } : {}),
      ...(summary !== undefined ? { summary } : {}),
      at: new Date().toISOString(),
    };
    record.authoredMaterialHash = recordMaterialHash(record);
    const findings = validateAuthoringRecord(record, plan, options.lane);
    if (findings.length)
      throw new Error(`Invalid authoring record:\n${findings.join("\n")}`);
    for (const artifact of pendingArtifacts)
      await atomicWrite(artifact.path, artifact.content);
    await atomicWrite(
      recordFile(options.state, options.lane),
      JSON.stringify(record, null, 2) + "\n",
    );
    stored.records[options.lane] = record;
    const prior = options.state.authoring!;
    const remainingInvalidated = prior.invalidatedLanes?.filter(
      (laneId) => laneId !== options.lane,
    );
    options.state.authoring = {
      ...prior,
      status: remainingInvalidated?.length
        ? "stale"
        : summaryStatus(stored.records),
      revision: prior.revision + 1,
      authoredMaterialHash: recordsMaterialHash(stored.records),
      assembledPackageHash: null,
      records: {
        ...prior.records,
        [options.lane]: recordSummary(
          record,
          recordFile(options.state, options.lane),
        ),
      },
      ...(remainingInvalidated?.length
        ? {
            invalidatedLanes: remainingInvalidated,
          }
        : { invalidatedLanes: undefined }),
    };
    options.state.generated = {
      ...options.state.generated!,
      assembledPackageHash: undefined,
    };
    options.state.currentHash = null;
    options.state.eval = undefined;
    options.state.review = undefined;
    options.state.status = "generated";
    await writeSessionSummary(options.state);
    await writeState(options.state);
    return record;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sectionBody(content: string, heading: string): string {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mu");
  const match = headingPattern.exec(content);
  if (!match) return content.trim();
  const bodyStart = match.index + match[0].length;
  const nextHeading = /^##\s+/mu.exec(content.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : content.length;
  return content.slice(bodyStart, bodyEnd).trim();
}

async function readArtifactContent(
  state: CreatorState,
  artifact: AuthoringArtifactEvidence,
): Promise<string> {
  if (!artifact.contentPath)
    throw new Error(`Authoring artifact content is missing: ${artifact.path}`);
  const target = path.resolve(artifact.contentPath);
  if (!isWithin(sessionRoot(state), target))
    throw new Error(
      `Authoring artifact content path escapes the session: ${artifact.path}`,
    );
  const content = await fs.readFile(target, "utf8");
  if (sha256(content) !== artifact.contentHash)
    throw new Error(`Authoring artifact content is stale: ${artifact.path}`);
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES)
    throw new Error(
      `Authoring artifact content is too large: ${artifact.path}`,
    );
  if (content.includes("AUTHORING PENDING"))
    throw new Error(
      `Authoring artifact contains a pending marker: ${artifact.path}`,
    );
  if (/^---\s*$/mu.test(content))
    throw new Error(
      `Authoring artifact cannot replace package frontmatter: ${artifact.path}`,
    );
  return content;
}

function replaceSection(
  original: string,
  heading: string,
  authoredContent: string,
): string {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mu");
  const match = headingPattern.exec(original);
  if (!match) throw new Error(`Generated package is missing ## ${heading}`);
  const bodyStart = match.index + match[0].length;
  const nextHeading = /^##\s+/mu.exec(original.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : original.length;
  const body = sectionBody(authoredContent, heading);
  if (!body) throw new Error(`Authored ${heading} content is empty`);
  return `${original.slice(0, bodyStart)}\n\n${body}\n\n${original.slice(bodyEnd).replace(/^\n+/u, "")}`;
}

function authoringLanesDocument(
  plan: AuthoringPlan,
  state: CreatorState,
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        authoringProtocolHash: AUTHORING_PROTOCOL_HASH,
        authoringPlanHash: plan.authoringPlanHash,
        workflowProtocolHash: plan.workflowProtocolHash,
        sourceEvidenceHash: plan.sourceEvidenceHash,
        authoringInputHash: state.authoring?.authoringInputHash,
        status: "assembled",
        lanes: AUTHORING_LANE_IDS.map((lane) => ({
          id: lane,
          status: records[lane]?.status ?? "PENDING",
          authoringMaterialHash: records[lane]?.authoredMaterialHash ?? null,
        })),
        review: records["skill-review"]?.review ?? null,
      },
      null,
      2,
    ) + "\n"
  );
}

function compositionReport(plan: AuthoringPlan, state: CreatorState): string {
  const selected = plan.sourceEvidence
    .map((candidate) => {
      const sources = candidate.sources
        .map((source) => `- ${source.name}: ${source.hash}`)
        .join("\n");
      return `### ${candidate.query}\n${sources || "- No source selected"}`;
    })
    .join("\n\n");
  return `# Composition Report

This deterministic report records the source and protocol identities used to assemble the package. It is audit evidence, not user guidance.

- Authoring Protocol: \`${plan.protocolHash}\`
- Workflow Protocol: \`${plan.workflowProtocolHash}\`
- Source evidence: \`${plan.sourceEvidenceHash}\`
- Authoring input: \`${state.authoring?.authoringInputHash ?? "(missing)"}\`

## Resolved Skills

${selected || "- None"}
`;
}

export async function authoringReadiness(
  state: CreatorState,
): Promise<AuthoringReadiness> {
  const emptyRecords: Partial<Record<AuthoringLaneId, AuthoringRecord>> = {};
  if (!state.generated || !state.authoring)
    return {
      state: "blocked",
      status: "pending",
      blockers: ["Authoring session is missing; generate a confirmed scaffold"],
      warnings: [],
      evidence: { draft: state.draftPath },
      records: emptyRecords,
      nextLanes: [],
    };
  let plan: AuthoringPlan;
  try {
    plan = await readAuthoringPlan(state);
  } catch (error) {
    return {
      state: "blocked",
      status: "stale",
      blockers: [String(error)],
      warnings: [],
      evidence: { session: sessionRoot(state), plan: sessionPlanPath(state) },
      records: emptyRecords,
      nextLanes: [],
    };
  }
  const blockers: string[] = [];
  const warnings: string[] = [];
  const stored = await readStoredRecords(state, plan);
  blockers.push(...stored.errors);
  const currentInputHash = authoringInputHash(plan);
  if (state.authoring.authoringInputHash !== currentInputHash)
    blockers.push("Authoring input evidence is stale; regenerate the scaffold");
  if (!HASH_PATTERN.test(state.authoring.scaffoldHash))
    blockers.push("Authoring scaffold hash is invalid");
  if (state.authoring.invalidatedLanes?.length)
    blockers.push(
      `Authoring records were invalidated for changed inputs: ${state.authoring.invalidatedLanes.join(", ")}`,
    );
  let hasContext = false;
  for (const laneId of AUTHORING_LANE_IDS) {
    const lane = laneDefinition(plan, laneId);
    const record = stored.records[laneId];
    if (!record) {
      blockers.push(`missing authoring record: ${laneId}`);
      continue;
    }
    if (record.authoringInputHash !== currentInputHash)
      blockers.push(`stale authoring record: ${laneId}`);
    if (record.status === "BLOCKED")
      blockers.push(`Authoring lane is BLOCKED: ${laneId}`);
    if (record.status === "NEEDS_CONTEXT") {
      hasContext = true;
      blockers.push(`Authoring lane NEEDS_CONTEXT: ${laneId}`);
    }
    if (record.status === "DONE_WITH_CONCERNS") {
      warnings.push(`Authoring lane has concerns: ${laneId}`);
      blockers.push(`Authoring lane requires review of concerns: ${laneId}`);
    }
    if (!isCompleteStatus(record.status))
      blockers.push(`Authoring lane is not complete: ${laneId}`);
    for (const dependency of lane.dependencies) {
      const dependencyRecord = stored.records[dependency];
      if (!dependencyRecord || !isCompleteStatus(dependencyRecord.status))
        blockers.push(`Authoring lane ${laneId} is blocked by ${dependency}`);
    }
    for (const artifact of record.artifacts) {
      if (artifact.present !== true) continue;
      try {
        const target = packageLeafPath(packageRoot(state), artifact.path);
        const stats = await fs.stat(target);
        if (!stats.isFile())
          blockers.push(`Authoring artifact is not a file: ${artifact.path}`);
      } catch {
        blockers.push(`Authoring artifact is missing: ${artifact.path}`);
      }
      if (artifact.contentPath) {
        try {
          await readArtifactContent(state, artifact);
        } catch (error) {
          blockers.push(String(error));
        }
      } else if (lane.contentLeaves.includes(artifact.path)) {
        blockers.push(
          `Authoring artifact content is missing: ${artifact.path}`,
        );
      }
    }
  }
  if (
    state.authoring.status === "assembled" &&
    state.authoring.assembledPackageHash
  ) {
    try {
      const currentPackageHash = await hashDirectory(packageRoot(state));
      if (currentPackageHash !== state.authoring.assembledPackageHash)
        blockers.push(
          "Assembled package changed outside the deterministic assembler",
        );
    } catch (error) {
      blockers.push(`Unable to hash assembled package: ${String(error)}`);
    }
  }
  const allRecordsComplete = AUTHORING_LANE_IDS.every((lane) =>
    isCompleteStatus(stored.records[lane]?.status),
  );
  const pendingMarkers = allRecordsComplete
    ? []
    : ["Generated scaffold contains authoring-pending content"];
  blockers.push(...pendingMarkers);
  const nextLanes = AUTHORING_LANE_IDS.filter((lane) => {
    if (stored.records[lane] && isCompleteStatus(stored.records[lane]!.status))
      return false;
    return laneDefinition(plan, lane).dependencies.every((dependency) =>
      isCompleteStatus(stored.records[dependency]?.status),
    );
  });
  const ready = blockers.length === 0 && allRecordsComplete;
  const status: AuthoringSessionStatus =
    state.authoring.status === "assembled" &&
    state.authoring.assembledPackageHash
      ? "assembled"
      : state.authoring.status === "stale" ||
          blockers.some(
            (blocker) =>
              blocker.includes("stale") || blocker.includes("invalidated"),
          )
        ? "stale"
        : ready
          ? "authored"
          : Object.keys(stored.records).length
            ? "in-progress"
            : "pending";
  return {
    state: ready ? "ready" : hasContext ? "needs-context" : "blocked",
    status,
    blockers,
    warnings,
    evidence: {
      session: sessionRoot(state),
      plan: sessionPlanPath(state),
      records: recordsRoot(state),
      scaffold: state.authoring.scaffoldHash,
      ...(state.authoring.authoredMaterialHash
        ? { authoredMaterial: state.authoring.authoredMaterialHash }
        : {}),
      ...(state.authoring.assembledPackageHash
        ? { assembledPackage: state.authoring.assembledPackageHash }
        : {}),
    },
    records: stored.records,
    nextLanes,
  };
}

export const readAuthoringStatus = authoringReadiness;

export async function assemblePackage(
  state: CreatorState,
): Promise<CreatorState> {
  if (!state.generated || !state.authoring)
    throw new Error("Generate the workflow scaffold before assembly");
  const root = sessionRoot(state);
  return withSessionLock(root, async () => {
    const readiness = await authoringReadiness(state);
    if (readiness.state !== "ready")
      throw new Error(
        `Cannot assemble blocked authoring session:\n${readiness.blockers.join("\n")}`,
      );
    const plan = await readAuthoringPlan(state);
    const stored = await readStoredRecords(state, plan);
    if (stored.errors.length)
      throw new Error(
        `Cannot assemble invalid authoring records:\n${stored.errors.join("\n")}`,
      );
    const packageDirectory = packageRoot(state);
    for (const laneId of AUTHORING_LANE_IDS) {
      const record = stored.records[laneId]!;
      for (const artifact of record.artifacts) {
        const content = await readArtifactContent(state, artifact);
        const target = packageLeafPath(packageDirectory, artifact.path);
        if (artifact.path === "SKILL.md") {
          const original = await fs.readFile(target, "utf8");
          await atomicWrite(
            target,
            replaceSection(original, "Decision Core", content),
          );
        } else if (artifact.path.endsWith("/SKILL.md")) {
          const original = await fs.readFile(target, "utf8");
          await atomicWrite(
            target,
            replaceSection(original, "Guidance", content),
          );
        } else {
          await atomicWrite(
            target,
            content.endsWith("\n") ? content : `${content}\n`,
          );
        }
      }
    }
    await atomicWrite(
      path.join(packageDirectory, "reference", "authoring-lanes.json"),
      authoringLanesDocument(plan, state, stored.records),
    );
    await atomicWrite(
      path.join(packageDirectory, "reference", "composition-report.md"),
      compositionReport(plan, state),
    );
    const assembledPackageHash = await hashDirectory(packageDirectory);
    const authoredMaterialHash = recordsMaterialHash(stored.records);
    const authoring = state.authoring;
    const generated = state.generated;
    if (!authoring || !generated)
      throw new Error("Authoring session disappeared during assembly");
    state.authoring = {
      ...authoring,
      status: "assembled",
      revision: authoring.revision + 1,
      authoredMaterialHash,
      assembledPackageHash,
      invalidatedLanes: undefined,
    };
    state.generated = {
      ...generated,
      assembledPackageHash,
    };
    state.currentHash = null;
    state.eval = undefined;
    state.review = undefined;
    state.status = "generated";
    await writeSessionSummary(state);
    await writeState(state);
    return state;
  });
}
