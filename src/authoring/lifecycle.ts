import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AuthoringArtifactDefinition,
  AuthoringArtifactEvidence,
  AuthoringClaimEvidence,
  AuthoringLaneDefinition,
  AuthoringLaneId,
  AuthoringReadiness,
  AuthoringRecord,
  AuthoringPlan,
  AuthoringStatus,
  CreatorState,
  WorkflowProtocol,
} from "../types.js";
import { atomicWrite, hashDirectory, isWithin, sha256, slug } from "../util.js";
import { writeState } from "../factory/state.js";

export const AUTHORING_LANES: AuthoringLaneId[] = [
  "script",
  "reference",
  "pause-points",
  "workflow-entry",
  "skill-core",
  "skill-review",
];

function nodeSkillName(workflow: string, node: string): string {
  return `${slug(workflow) || "workflow"}-${slug(node) || "node"}`;
}

export function buildAuthoringPlan(
  protocol: WorkflowProtocol,
  entryName: string,
): AuthoringPlan {
  const activeNodes = protocol.nodes.filter((node) => !node.disabled);
  const nodeArtifacts = activeNodes.map((node) => ({
    id: `node-${node.id}`,
    path: `../${nodeSkillName(protocol.name, node.id)}/SKILL.md`,
    kind: "file" as const,
    required: true,
  }));
  const lanes: AuthoringLaneDefinition[] = [
    {
      lane: "script",
      dependsOn: [],
      claims: [
        {
          id: "script-contract",
          statement:
            "Generated scripts are portable and declare their side effects.",
          required: true,
        },
      ],
      artifacts: [
        { id: "scripts", path: "scripts", kind: "directory", required: true },
      ],
    },
    {
      lane: "reference",
      dependsOn: [],
      claims: [
        {
          id: "reference-contract",
          statement:
            "References preserve resolved Skill evidence and the workflow contract.",
          required: true,
        },
      ],
      artifacts: [
        {
          id: "references",
          path: "reference",
          kind: "directory",
          required: true,
        },
      ],
    },
    {
      lane: "pause-points",
      dependsOn: ["reference"],
      claims: [
        {
          id: "pause-classification",
          statement:
            "Decision points distinguish user choices, automatic handling, stop conditions, and handoffs.",
          required: true,
        },
      ],
      artifacts: [
        {
          id: "decision-points",
          path: "reference/decision-points.md",
          kind: "file",
          required: true,
        },
      ],
    },
    {
      lane: "workflow-entry",
      dependsOn: ["pause-points", "script"],
      claims: [
        {
          id: "entry-decision-core",
          statement:
            "The entry Skill explains routing, pause behavior, recovery, and red flags.",
          required: true,
        },
      ],
      artifacts: [
        { id: "entry-skill", path: "SKILL.md", kind: "file", required: true },
      ],
    },
    {
      lane: "skill-core",
      dependsOn: ["reference", "script"],
      claims: [
        {
          id: "node-guidance",
          statement:
            "Every active internal Node Skill contains substantive guidance and completion reasoning.",
          required: true,
        },
      ],
      artifacts:
        nodeArtifacts.length > 0
          ? nodeArtifacts
          : [
              {
                id: "entry-fallback",
                path: "SKILL.md",
                kind: "file",
                required: true,
              },
            ],
    },
    {
      lane: "skill-review",
      dependsOn: [
        "script",
        "reference",
        "pause-points",
        "workflow-entry",
        "skill-core",
      ],
      claims: [
        {
          id: "review-verdict",
          statement:
            "The authored Bundle has a current, reviewable verdict with no blocking findings.",
          required: true,
        },
      ],
      artifacts: [
        {
          id: "skill-review",
          path: "reference/skill-review.md",
          kind: "file",
          required: true,
        },
      ],
      reviewRequired: true,
    },
  ];
  return {
    schemaVersion: 1,
    kind: "authoring-plan",
    workflow: protocol.name || entryName,
    protocolHash: sha256(JSON.stringify(protocol)),
    lanes,
  };
}

export function validateAuthoringPlan(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["authoring plan must be an object"];
  const plan = value as Partial<AuthoringPlan>;
  const findings: string[] = [];
  if (plan.schemaVersion !== 1)
    findings.push("authoring plan schemaVersion must be 1");
  if (plan.kind !== "authoring-plan")
    findings.push("authoring plan kind is invalid");
  if (typeof plan.workflow !== "string" || !plan.workflow.trim())
    findings.push("authoring plan workflow is required");
  if (typeof plan.protocolHash !== "string" || !plan.protocolHash.trim())
    findings.push("authoring plan protocolHash is required");
  if (!Array.isArray(plan.lanes))
    return [...findings, "authoring plan lanes are required"];

  const seen = new Set<string>();
  const known = new Set(AUTHORING_LANES);
  for (const [index, lane] of plan.lanes.entries()) {
    if (!lane || typeof lane !== "object") {
      findings.push("authoring lane must be an object");
      continue;
    }
    const laneValue = (lane as { lane?: unknown }).lane;
    if (
      typeof laneValue !== "string" ||
      !known.has(laneValue as AuthoringLaneId)
    ) {
      findings.push(`unknown authoring lane: ${String(laneValue)}`);
      continue;
    }
    if (seen.has(laneValue))
      findings.push(`duplicate authoring lane: ${laneValue}`);
    seen.add(laneValue);
    const definition = lane as AuthoringLaneDefinition;
    if (!Array.isArray(definition.dependsOn))
      findings.push(`${laneValue} must declare dependencies`);
    for (const dependency of definition.dependsOn ?? []) {
      if (!known.has(dependency))
        findings.push(
          `${laneValue} depends on unknown authoring lane: ${dependency}`,
        );
      if (dependency === laneValue)
        findings.push(`${laneValue} cannot depend on itself`);
      const dependencyIndex = plan.lanes.findIndex(
        (candidate) => candidate?.lane === dependency,
      );
      if (dependencyIndex >= index && dependencyIndex !== -1)
        findings.push(
          `${laneValue} dependency must precede the lane: ${dependency}`,
        );
    }
    if (!Array.isArray(definition.claims) || definition.claims.length === 0)
      findings.push(`${laneValue} must declare claims`);
    const claimIds = new Set<string>();
    for (const claim of definition.claims ?? []) {
      if (!claim || typeof claim !== "object") {
        findings.push(`${laneValue} claim must be an object`);
        continue;
      }
      if (typeof claim.id !== "string" || !claim.id.trim())
        findings.push(`${laneValue} claim id is required`);
      else if (claimIds.has(claim.id))
        findings.push(`duplicate authoring claim: ${claim.id}`);
      else claimIds.add(claim.id);
      if (typeof claim.statement !== "string" || !claim.statement.trim())
        findings.push(`${laneValue} claim statement is required`);
      if (typeof claim.required !== "boolean")
        findings.push(`${laneValue} claim required flag is invalid`);
    }
    if (
      !Array.isArray(definition.artifacts) ||
      definition.artifacts.length === 0
    )
      findings.push(`${laneValue} must declare artifacts`);
    const artifactIds = new Set<string>();
    for (const artifact of definition.artifacts ?? []) {
      if (!artifact || typeof artifact !== "object") {
        findings.push(`${laneValue} artifact must be an object`);
        continue;
      }
      if (typeof artifact.id !== "string" || !artifact.id.trim())
        findings.push(`${laneValue} artifact id is required`);
      else if (artifactIds.has(artifact.id))
        findings.push(`duplicate authoring artifact: ${artifact.id}`);
      else artifactIds.add(artifact.id);
      if (typeof artifact.path !== "string" || !artifact.path.trim())
        findings.push(`${laneValue} artifact path is required`);
      if (!["file", "directory"].includes(artifact.kind))
        findings.push(`${laneValue} artifact kind is invalid`);
      if (typeof artifact.required !== "boolean")
        findings.push(`${laneValue} artifact required flag is invalid`);
    }
    if (
      definition.reviewRequired !== undefined &&
      typeof definition.reviewRequired !== "boolean"
    )
      findings.push(`${laneValue} reviewRequired flag is invalid`);
  }
  if (
    JSON.stringify(plan.lanes.map((lane) => lane?.lane)) !==
    JSON.stringify(AUTHORING_LANES)
  )
    findings.push("authoring lanes must use the canonical order");
  for (const lane of AUTHORING_LANES)
    if (!seen.has(lane)) findings.push(`missing authoring lane: ${lane}`);
  return findings;
}

export function authoringPlanHash(plan: AuthoringPlan): string {
  return sha256(JSON.stringify(plan));
}

function isAuthoringLane(value: unknown): value is AuthoringLaneId {
  return (
    typeof value === "string" &&
    AUTHORING_LANES.includes(value as AuthoringLaneId)
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function laneDefinition(
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
): AuthoringLaneDefinition {
  const definition = plan.lanes.find((item) => item.lane === lane);
  if (!definition) throw new Error(`Unknown authoring lane: ${lane}`);
  return definition;
}

function bundleRoot(state: CreatorState): string {
  const root = state.generated?.bundleRoot ?? state.generated?.packageRoot;
  if (!root) throw new Error("Generate the workflow package before authoring");
  return path.resolve(root);
}

function packageRoot(state: CreatorState): string {
  if (!state.generated?.packageRoot)
    throw new Error("Generate the workflow package before authoring");
  return path.resolve(state.generated.packageRoot);
}

function planPath(state: CreatorState): string {
  if (!state.generated)
    throw new Error("Generate the workflow package before authoring");
  return path.resolve(
    state.generated.authoringPlanPath ??
      path.join(
        state.generated.packageRoot,
        "reference",
        "authoring-plan.json",
      ),
  );
}

function recordsRoot(state: CreatorState): string {
  return path.join(state.projectRoot, ".comet-any", "authoring", state.name);
}

function recordPath(state: CreatorState, lane: AuthoringLaneId): string {
  return path.join(recordsRoot(state), `${lane}.json`);
}

export async function readAuthoringPlan(
  state: CreatorState,
): Promise<AuthoringPlan> {
  const file = planPath(state);
  const plan = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const findings = validateAuthoringPlan(plan);
  if (findings.length)
    throw new Error(`Invalid authoring plan:\n${findings.join("\n")}`);
  return plan as AuthoringPlan;
}

function validStatuses(): AuthoringStatus[] {
  return ["PENDING", "IN_PROGRESS", "COMPLETE", "BLOCKED", "NEEDS_CONTEXT"];
}

function validateReviewOutput(value: unknown, required: boolean): string[] {
  const review = objectValue(value);
  if (!review) return required ? ["review output is required"] : [];
  const findings: string[] = [];
  if (
    !["approved", "rejected", "needs_context"].includes(String(review.decision))
  )
    findings.push("review decision is invalid");
  if (typeof review.reviewer !== "string" || !review.reviewer.trim())
    findings.push("review reviewer is required");
  if (typeof review.summary !== "string" || !review.summary.trim())
    findings.push("review summary is required");
  if (!Array.isArray(review.blockingFindings))
    findings.push("review blockingFindings must be an array");
  if (!Array.isArray(review.warnings))
    findings.push("review warnings must be an array");
  if (
    review.decision === "approved" &&
    Array.isArray(review.blockingFindings) &&
    review.blockingFindings.length > 0
  )
    findings.push("approved review output cannot contain blocking findings");
  return findings;
}

export function validateAuthoringRecord(
  value: unknown,
  plan: AuthoringPlan,
  expectedLane?: AuthoringLaneId,
): string[] {
  const record = objectValue(value);
  if (!record) return ["authoring record must be an object"];
  const laneValue = record.lane;
  const lane = expectedLane ?? laneValue;
  const findings: string[] = [];
  if (!isAuthoringLane(lane)) {
    findings.push(`unknown authoring lane: ${String(lane)}`);
    return findings;
  }
  if (laneValue !== undefined && laneValue !== lane)
    findings.push(`authoring record lane mismatch: ${String(laneValue)}`);
  const definition = laneDefinition(plan, lane);
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1)
    findings.push("authoring record schemaVersion must be 1");
  if (record.kind !== undefined && record.kind !== "authoring-record")
    findings.push("authoring record kind is invalid");
  if (
    typeof record.workflow !== "undefined" &&
    record.workflow !== plan.workflow
  )
    findings.push("authoring record workflow does not match the plan");
  if (
    typeof record.protocolHash !== "undefined" &&
    record.protocolHash !== plan.protocolHash
  )
    findings.push("authoring record protocolHash is stale");
  if (!validStatuses().includes(record.status as AuthoringStatus))
    findings.push(`invalid authoring status: ${String(record.status)}`);

  const claims = Array.isArray(record.claims) ? record.claims : [];
  const expectedClaimIds = definition.claims.map((claim) => claim.id);
  const actualClaimIds = claims.map((claim) => objectValue(claim)?.id);
  for (const claimId of expectedClaimIds)
    if (!actualClaimIds.includes(claimId))
      findings.push(`missing authoring claim: ${claimId}`);
  for (const claimId of actualClaimIds)
    if (typeof claimId !== "string" || !expectedClaimIds.includes(claimId))
      findings.push(`unknown authoring claim: ${String(claimId)}`);
  for (const claim of claims) {
    const item = objectValue(claim);
    if (!item) {
      findings.push("authoring claim must be an object");
      continue;
    }
    if (
      !["SUPPORTED", "UNSUPPORTED", "NEEDS_CONTEXT"].includes(
        String(item.status),
      )
    )
      findings.push(`invalid authoring claim status: ${String(item.status)}`);
    if (
      !Array.isArray(item.evidence) ||
      item.evidence.some((entry) => typeof entry !== "string")
    )
      findings.push(`invalid evidence for authoring claim: ${String(item.id)}`);
  }

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const expectedArtifactIds = definition.artifacts.map(
    (artifact) => artifact.id,
  );
  const actualArtifactIds = artifacts.map(
    (artifact) => objectValue(artifact)?.id,
  );
  for (const artifactId of expectedArtifactIds)
    if (!actualArtifactIds.includes(artifactId))
      findings.push(`missing authoring artifact: ${artifactId}`);
  for (const artifactId of actualArtifactIds)
    if (
      typeof artifactId !== "string" ||
      !expectedArtifactIds.includes(artifactId)
    )
      findings.push(`unknown authoring artifact: ${String(artifactId)}`);
  for (const artifact of artifacts) {
    const item = objectValue(artifact);
    if (!item) {
      findings.push("authoring artifact must be an object");
      continue;
    }
    const definitionArtifact = definition.artifacts.find(
      (candidate) => candidate.id === item.id,
    );
    if (definitionArtifact && item.path !== definitionArtifact.path)
      findings.push(`authoring artifact path mismatch: ${String(item.id)}`);
    if (typeof item.present !== "boolean")
      findings.push(
        `authoring artifact presence is invalid: ${String(item.id)}`,
      );
    if (item.contentHash !== undefined && typeof item.contentHash !== "string")
      findings.push(`authoring artifact hash is invalid: ${String(item.id)}`);
  }

  if (record.status === "COMPLETE") {
    for (const claim of claims) {
      const item = objectValue(claim);
      if (item?.status !== "SUPPORTED")
        findings.push(
          `complete authoring record has unsupported claim: ${String(item?.id)}`,
        );
      if (item && Array.isArray(item.evidence) && item.evidence.length === 0)
        findings.push(
          `complete authoring claim has no evidence: ${String(item.id)}`,
        );
    }
    for (const artifact of artifacts) {
      const item = objectValue(artifact);
      if (item?.present !== true)
        findings.push(
          `complete authoring record is missing artifact: ${String(item?.id)}`,
        );
    }
  }
  if (
    (record.status === "BLOCKED" || record.status === "NEEDS_CONTEXT") &&
    (typeof record.summary !== "string" || !record.summary.trim())
  )
    findings.push(`${record.status} authoring records require a summary`);
  findings.push(
    ...validateReviewOutput(
      record.review,
      definition.reviewRequired === true && record.status === "COMPLETE",
    ),
  );
  if (
    definition.reviewRequired &&
    record.status === "COMPLETE" &&
    objectValue(record.review)?.decision !== "approved"
  )
    findings.push("skill-review must have an approved review output");
  return findings;
}

async function artifactEvidence(
  state: CreatorState,
  definition: AuthoringArtifactDefinition,
  supplied: unknown,
): Promise<AuthoringArtifactEvidence> {
  const root = bundleRoot(state);
  const packageDirectory = packageRoot(state);
  if (path.isAbsolute(definition.path))
    throw new Error(
      `Authoring artifact path must be relative: ${definition.path}`,
    );
  const target = path.resolve(packageDirectory, definition.path);
  if (!isWithin(root, target))
    throw new Error(
      `Authoring artifact escapes the Bundle: ${definition.path}`,
    );
  let present = false;
  let contentHash: string | undefined;
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink())
      throw new Error("symbolic links are not valid authoring artifacts");
    present =
      definition.kind === "directory" ? stats.isDirectory() : stats.isFile();
    if (present)
      contentHash =
        definition.kind === "directory"
          ? await hashDirectory(target)
          : sha256(await fs.readFile(target));
  } catch (error) {
    if (error instanceof Error && error.message.includes("symbolic links"))
      throw error;
    present = false;
  }
  const provided = objectValue(supplied);
  if (provided?.present !== undefined && provided.present !== present)
    throw new Error(`Authoring artifact presence changed: ${definition.id}`);
  if (
    provided?.contentHash !== undefined &&
    provided.contentHash !== contentHash
  )
    throw new Error(`Authoring artifact hash changed: ${definition.id}`);
  return {
    id: definition.id,
    path: definition.path,
    present,
    ...(contentHash ? { contentHash } : {}),
  };
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
  for (const lane of plan.lanes) {
    const file = recordPath(state, lane.lane);
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const findings = validateAuthoringRecord(record, plan, lane.lane);
      if (findings.length)
        errors.push(
          `invalid authoring record ${lane.lane}: ${findings.join("; ")}`,
        );
      else records[lane.lane] = record as AuthoringRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(
          `cannot read authoring record ${lane.lane}: ${String(error)}`,
        );
    }
  }
  return { records, errors };
}

export async function recordAuthoring(options: {
  state: CreatorState;
  lane: AuthoringLaneId;
  record: unknown;
}): Promise<AuthoringRecord> {
  if (!isAuthoringLane(options.lane))
    throw new Error(`Unknown authoring lane: ${String(options.lane)}`);
  if (!options.state.generated)
    throw new Error("Generate the workflow package before recording authoring");
  const plan = await readAuthoringPlan(options.state);
  const definition = laneDefinition(plan, options.lane);
  const input = objectValue(options.record);
  if (!input) throw new Error("Authoring record must be an object");
  if (input.lane !== undefined && input.lane !== options.lane)
    throw new Error(`Authoring record lane mismatch: ${String(input.lane)}`);
  const currentHash = await hashDirectory(bundleRoot(options.state));
  if (input.bundleHash !== undefined && input.bundleHash !== currentHash)
    throw new Error("Authoring record Bundle hash is stale");
  if (input.workflow !== undefined && input.workflow !== plan.workflow)
    throw new Error("Authoring record workflow does not match the plan");
  if (
    input.protocolHash !== undefined &&
    input.protocolHash !== plan.protocolHash
  )
    throw new Error("Authoring record protocolHash is stale");

  const stored = await readStoredRecords(options.state, plan);
  for (const dependency of definition.dependsOn) {
    const dependencyRecord = stored.records[dependency];
    if (!dependencyRecord || dependencyRecord.status !== "COMPLETE")
      throw new Error(
        `Authoring lane ${options.lane} is blocked by ${dependency}`,
      );
    if (dependencyRecord.bundleHash !== currentHash)
      throw new Error(
        `Authoring lane ${options.lane} is blocked by stale ${dependency} evidence`,
      );
  }

  const rawStatus = input.status;
  if (!validStatuses().includes(rawStatus as AuthoringStatus))
    throw new Error(`Invalid authoring status: ${String(rawStatus)}`);
  const suppliedArtifacts = Array.isArray(input.artifacts)
    ? input.artifacts
    : [];
  const expectedArtifactIds = new Set(
    definition.artifacts.map((artifact) => artifact.id),
  );
  for (const suppliedArtifact of suppliedArtifacts) {
    const suppliedId = objectValue(suppliedArtifact)?.id;
    if (typeof suppliedId !== "string" || !expectedArtifactIds.has(suppliedId))
      throw new Error(`Unknown authoring artifact: ${String(suppliedId)}`);
  }
  const artifacts: AuthoringArtifactEvidence[] = [];
  for (const artifact of definition.artifacts)
    artifacts.push(
      await artifactEvidence(
        options.state,
        artifact,
        suppliedArtifacts.find((item) => objectValue(item)?.id === artifact.id),
      ),
    );
  const record: AuthoringRecord = {
    schemaVersion: 1,
    kind: "authoring-record",
    workflow: plan.workflow,
    lane: options.lane,
    status: rawStatus as AuthoringStatus,
    protocolHash: plan.protocolHash,
    bundleHash: currentHash,
    claims: (Array.isArray(input.claims)
      ? input.claims
      : []) as AuthoringClaimEvidence[],
    artifacts,
    ...(input.review
      ? { review: input.review as AuthoringRecord["review"] }
      : {}),
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
    at: new Date().toISOString(),
  };
  const findings = validateAuthoringRecord(record, plan, options.lane);
  if (findings.length)
    throw new Error(`Invalid authoring record:\n${findings.join("\n")}`);

  await atomicWrite(
    recordPath(options.state, options.lane),
    JSON.stringify(record, null, 2) + "\n",
  );
  const summaries = { ...(options.state.authoring?.records ?? {}) };
  summaries[options.lane] = {
    path: recordPath(options.state, options.lane),
    status: record.status,
    bundleHash: record.bundleHash,
  };
  options.state.authoring = {
    planPath: planPath(options.state),
    recordsPath: recordsRoot(options.state),
    records: summaries,
  };
  if (options.state.eval && options.state.eval.hash !== currentHash) {
    options.state.currentHash = null;
    options.state.eval = undefined;
    options.state.review = undefined;
    options.state.status = "generated";
  }
  await writeState(options.state);
  return record;
}

async function scaffoldBlockers(state: CreatorState): Promise<string[]> {
  const packageDirectory = packageRoot(state);
  const protocol = JSON.parse(
    await fs.readFile(state.generated!.protocolPath, "utf8"),
  ) as WorkflowProtocol;
  const files = [
    path.join(packageDirectory, "SKILL.md"),
    path.join(packageDirectory, "reference", "decision-points.md"),
    path.join(packageDirectory, "reference", "skill-review.md"),
    ...protocol.nodes
      .filter((node) => !node.disabled)
      .map((node) =>
        path.join(
          packageDirectory,
          "..",
          nodeSkillName(protocol.name, node.id),
          "SKILL.md",
        ),
      ),
  ];
  const markers = [
    "<!-- AUTHORING PENDING -->",
    "Not yet authored.",
    "No decision points have been authored.",
    "No LLM authoring review has been recorded",
  ];
  const blockers: string[] = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      if (markers.some((marker) => content.includes(marker)))
        blockers.push(`Authoring scaffold content remains: ${file}`);
    } catch {
      blockers.push(`Authoring artifact is missing: ${file}`);
    }
  }
  return blockers;
}

export async function authoringReadiness(
  state: CreatorState,
): Promise<AuthoringReadiness> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const records: Partial<Record<AuthoringLaneId, AuthoringRecord>> = {};
  if (!state.generated)
    return {
      state: "blocked",
      blockers: ["Generated package is missing"],
      warnings,
      evidence: { draft: state.draftPath },
      records,
    };
  let plan: AuthoringPlan;
  try {
    plan = await readAuthoringPlan(state);
  } catch (error) {
    return {
      state: "blocked",
      blockers: [String(error)],
      warnings,
      evidence: { draft: state.draftPath },
      records,
    };
  }
  let currentHash: string;
  try {
    currentHash = await hashDirectory(bundleRoot(state));
    const protocol = JSON.parse(
      await fs.readFile(state.generated.protocolPath, "utf8"),
    ) as WorkflowProtocol;
    if (sha256(JSON.stringify(protocol)) !== plan.protocolHash)
      blockers.push("Authoring plan protocol hash is stale");
  } catch (error) {
    blockers.push(`Unable to inspect generated Bundle: ${String(error)}`);
    currentHash = "";
  }
  const stored = await readStoredRecords(state, plan);
  blockers.push(...stored.errors);
  for (const lane of plan.lanes) {
    const record = stored.records[lane.lane];
    if (!record) {
      blockers.push(`missing authoring record: ${lane.lane}`);
      continue;
    }
    records[lane.lane] = record;
    if (record.bundleHash !== currentHash)
      blockers.push(`stale authoring record: ${lane.lane}`);
    for (const artifact of lane.artifacts) {
      try {
        await artifactEvidence(
          state,
          artifact,
          record.artifacts.find((item) => item.id === artifact.id),
        );
      } catch (error) {
        blockers.push(
          `Authoring artifact changed: ${lane.lane}.${artifact.id} (${String(error)})`,
        );
      }
    }
    if (record.status === "BLOCKED")
      blockers.push(`Authoring lane is BLOCKED: ${lane.lane}`);
    if (record.status === "NEEDS_CONTEXT")
      blockers.push(`Authoring lane NEEDS_CONTEXT: ${lane.lane}`);
    if (
      record.status !== "COMPLETE" &&
      record.status !== "BLOCKED" &&
      record.status !== "NEEDS_CONTEXT"
    )
      blockers.push(`Authoring lane is not complete: ${lane.lane}`);
    for (const dependency of lane.dependsOn) {
      const dependencyRecord = stored.records[dependency];
      if (!dependencyRecord || dependencyRecord.status !== "COMPLETE")
        blockers.push(
          `Authoring lane ${lane.lane} is blocked by ${dependency}`,
        );
    }
  }
  try {
    blockers.push(...(await scaffoldBlockers(state)));
  } catch (error) {
    blockers.push(`Unable to inspect authoring scaffold: ${String(error)}`);
  }
  const hasContext = plan.lanes.some(
    (lane) => records[lane.lane]?.status === "NEEDS_CONTEXT",
  );
  const hasBlockedStatus = plan.lanes.some(
    (lane) => records[lane.lane]?.status === "BLOCKED",
  );
  return {
    state: hasBlockedStatus
      ? "blocked"
      : hasContext
        ? "needs-context"
        : blockers.length
          ? "blocked"
          : "ready",
    blockers,
    warnings,
    evidence: {
      draft: state.draftPath,
      plan: planPath(state),
      records: recordsRoot(state),
      ...(currentHash ? { bundleHash: currentHash } : {}),
    },
    records,
  };
}
