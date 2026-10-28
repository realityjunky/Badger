import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState, WorkflowProtocol } from "../types.js";
import {
  atomicWrite,
  hashDirectory,
  isWithin,
  listFiles,
  packageRelativePath,
  sha256,
  slug,
  stableValue,
} from "../util.js";
import { readState, writeState } from "../factory/state.js";
import {
  mapAuthoringPlanPaths,
  mapAuthoringRecordPaths,
  mapAuthoringSummaryPaths,
  toResolvedPaths,
  toStoredPaths,
} from "../factory/project-paths.js";
import { readPlan } from "../factory/proposal.js";
import {
  generatePackage,
  inventoryPackage,
  writePackageInventory,
} from "../factory/generate.js";
import {
  AUTHORING_PROTOCOL_HASH,
  authoringAffectedLanes,
  authoringContentLeafOwners,
  authoringDependentLanes,
  authoringLaneClaimIds,
  authoringLaneDependencies,
  authoringLaneIds,
  authoringLanesForWave,
  authoringProtocolProjection,
} from "./protocol.js";
import { deriveAuthoringPlan, validateAuthoringPlan } from "./plan.js";
import {
  AUTHORING_REVIEW_LENSES,
  buildAuthoringReview,
  validateAuthoringReviewInput,
} from "./review.js";
import type {
  AuthoringArtifactEvidence,
  AuthoringArtifactInput,
  AuthoringClaimEvidence,
  AuthoringLaneFinding,
  AuthoringLaneReadiness,
  AuthoringLaneOutputStatus,
  AuthoringLane,
  AuthoringLaneId,
  AuthoringPlan,
  AuthoringReadiness,
  AuthoringRecoveryInfo,
  AuthoringRecord,
  AuthoringRecordInput,
  AuthoringRecordSummary,
  AuthoringReviewFinding,
  AuthoringReviewOutput,
  AuthoringReviewResult,
  AuthoringReviewVoterEvidence,
  AuthoringRevisionConflict,
  AuthoringInvalidation,
  AuthoringInvalidationOptions,
  AuthoringSessionDecision,
  AuthoringSessionDecisionOptions,
  AuthoringSessionIdentity,
  AuthoringSessionLock,
  AuthoringSessionOperation,
  AuthoringSessionRecordOptions,
  AuthoringSessionStatus,
  AuthoringStateSummary,
  AuthoringStatus,
  AuthoringWaveReadiness,
  AuthoringWriteGate,
  AuthoringWriteGateOptions,
} from "./types.js";
import type { GeneratedPackage } from "../factory/generate.js";

export const AUTHORING_GENERATOR_CONTRACT_VERSION = 2 as const;
const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ARRAY_LENGTH = 128;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_PATH_BYTES = 512;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const COMPLETE_STATUSES: readonly AuthoringStatus[] = ["COMPLETE", "DONE"];
const LANE_OUTPUT_STATUSES: readonly AuthoringLaneOutputStatus[] = [
  "DONE",
  "DONE_WITH_CONCERNS",
  "BLOCKED",
  "NEEDS_CONTEXT",
];
const FINDING_SEVERITIES = ["critical", "important", "minor"] as const;
const EVIDENCE_SOURCES = [
  "deterministic-check-only",
  "llm-single",
  "llm-multivote",
] as const;

export class AuthoringRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly conflict: AuthoringRevisionConflict;

  constructor(
    lane: AuthoringLaneId,
    expectedRevision: number,
    actualRevision: number,
  ) {
    super(
      `Authoring session revision conflict for ${lane}: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "AuthoringRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.conflict = {
      lane,
      expectedRevision,
      actualRevision,
      at: new Date().toISOString(),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAuthoringLane(value: unknown): value is AuthoringLaneId {
  return (
    typeof value === "string" &&
    (authoringLaneIds() as readonly string[]).includes(value)
  );
}

function isCompleteStatus(value: unknown): boolean {
  return COMPLETE_STATUSES.includes(value as AuthoringStatus);
}

function sessionRoot(state: CreatorState): string {
  return path.join(state.projectRoot, ".badger", "authoring", state.name);
}

export function authoringSessionPath(state: CreatorState): string {
  return sessionRoot(state);
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

export function authoringPlanPath(state: CreatorState): string {
  return sessionPlanPath(state);
}

function recordsRoot(state: CreatorState): string {
  return path.join(sessionRoot(state), "records");
}

export function authoringRecordsPath(state: CreatorState): string {
  return recordsRoot(state);
}

function sessionIdentityHash(value: {
  sessionPath: string;
  workflow: string;
  planHash: string;
  protocolHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  authoringInputHash: string;
  semanticDossierHash?: string;
  scaffoldHash: string;
}): string {
  return sha256(
    JSON.stringify(
      stableValue({
        ...value,
      }),
    ),
  );
}

// The session identity must survive moving the project, so it hashes the
// project-relative session location rather than the absolute path it resolves
// to on this host.
function portableSessionPath(workflow: string): string {
  return [".badger", "authoring", workflow].join("/");
}

function sessionIdentityFields(
  summary: AuthoringStateSummary,
  workflow: string,
): {
  workflow: string;
  planHash: string;
  protocolHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  authoringInputHash: string;
  semanticDossierHash?: string;
  scaffoldHash: string;
} {
  return {
    workflow,
    planHash: summary.planHash,
    protocolHash: summary.protocolHash,
    workflowProtocolHash: summary.workflowProtocolHash,
    sourceEvidenceHash: summary.sourceEvidenceHash,
    authoringPlanHash: summary.authoringPlanHash,
    authoringInputHash: summary.authoringInputHash,
    ...(summary.semanticDossierHash
      ? { semanticDossierHash: summary.semanticDossierHash }
      : {}),
    scaffoldHash: summary.scaffoldHash,
  };
}

export function authoringSessionIdentity(
  value: CreatorState | AuthoringStateSummary,
): AuthoringSessionIdentity | undefined {
  const summary: AuthoringStateSummary | undefined =
    "sessionPath" in value ? value : value.authoring;
  if (!summary) return undefined;
  const workflow = summary.workflow ?? path.basename(summary.sessionPath);
  const fields = sessionIdentityFields(summary, workflow);
  return {
    schemaVersion: 1,
    sessionId: sessionIdentityHash({
      sessionPath: portableSessionPath(workflow),
      ...fields,
    }),
    sessionPath: summary.sessionPath,
    revision: summary.revision,
    ...fields,
  };
}

// Sessions written before project-relative storage hashed the absolute session
// path. Accept their identity once so an existing checkout upgrades in place.
function legacyAuthoringSessionId(summary: AuthoringStateSummary): string {
  const workflow = summary.workflow ?? path.basename(summary.sessionPath);
  return sessionIdentityHash({
    sessionPath: summary.sessionPath,
    ...sessionIdentityFields(summary, workflow),
  });
}

function normalizeAuthoringSummary(
  summary: AuthoringStateSummary,
): AuthoringStateSummary {
  const workflow = summary.workflow ?? path.basename(summary.sessionPath);
  const normalized = {
    ...summary,
    workflow,
  };
  const identity = authoringSessionIdentity(normalized);
  if (!identity) throw new Error("Authoring session identity is missing");
  if (
    summary.sessionId &&
    summary.sessionId !== identity.sessionId &&
    summary.sessionId !== legacyAuthoringSessionId(normalized)
  ) {
    throw new Error("Authoring session identity is stale");
  }
  return {
    ...normalized,
    sessionId: identity.sessionId,
  };
}

function recordFile(state: CreatorState, lane: AuthoringLaneId): string {
  return path.join(recordsRoot(state), `${lane}.json`);
}

function packageRoot(state: CreatorState): string {
  if (!state.generated?.packageRoot)
    throw new Error("Generate the workflow scaffold before authoring");
  const root = path.resolve(state.generated.packageRoot);
  if (!isWithin(state.projectRoot, root))
    throw new Error("Generated package must remain inside the project root");
  return root;
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
  return [
    ...authoringLaneClaimIds(lane.id, {
      derivedClaims: lane.derivedClaims,
    }),
  ];
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
        semanticDossierHash: plan.semanticDossierHash,
      }),
    ),
  );
}

export const hashAuthoringSessionInput = authoringInputHash;

function canonicalRecord(record: AuthoringRecord): unknown {
  return {
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    workflow: record.workflow,
    lane: record.lane,
    status: record.status,
    protocolHash: record.protocolHash,
    authoringPlanHash: record.authoringPlanHash,
    workflowProtocolHash: record.workflowProtocolHash,
    sourceEvidenceHash: record.sourceEvidenceHash,
    authoringInputHash: record.authoringInputHash,
    ...(record.semanticDossierHash
      ? { semanticDossierHash: record.semanticDossierHash }
      : {}),
    ...(record.action ? { action: record.action } : {}),
    claims: [...record.claims]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((claim) => ({
        id: claim.id,
        status: claim.status,
        evidence: [...claim.evidence],
        ...(claim.kind ? { kind: claim.kind } : {}),
        ...(claim.paths ? { paths: [...claim.paths] } : {}),
        ...(claim.summary ? { summary: claim.summary } : {}),
      })),
    artifacts: [...record.artifacts]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        present: artifact.present,
        contentHash: artifact.contentHash ?? null,
        ...(artifact.kind ? { kind: artifact.kind } : {}),
      })),
    ...(record.findings
      ? {
          findings: record.findings.map((finding) => ({
            severity: finding.severity,
            ...(finding.path ? { path: finding.path } : {}),
            ...(finding.claim ? { claim: finding.claim } : {}),
            problem: finding.problem,
            ...(finding.impact ? { impact: finding.impact } : {}),
            ...(finding.fix ? { fix: finding.fix } : {}),
          })),
        }
      : {}),
    ...(record.dispatchMode ? { dispatchMode: record.dispatchMode } : {}),
    ...(record.model ? { model: record.model } : {}),
    review: record.review
      ? {
          decision: record.review.decision,
          reviewer: record.review.reviewer,
          summary: record.review.summary,
          blockingFindings: [...record.review.blockingFindings],
          warnings: [...record.review.warnings],
          ...(record.review.passed !== undefined
            ? { passed: record.review.passed }
            : {}),
          ...(record.review.evidenceSource
            ? { evidenceSource: record.review.evidenceSource }
            : {}),
          ...(record.review.voters !== undefined
            ? { voters: record.review.voters }
            : {}),
          ...(record.review.lenses
            ? { lenses: [...record.review.lenses] }
            : {}),
          ...(record.review.rounds !== undefined
            ? { rounds: record.review.rounds }
            : {}),
          ...(record.review.dryRounds !== undefined
            ? { dryRounds: record.review.dryRounds }
            : {}),
          ...(record.review.findings
            ? { findings: [...record.review.findings] }
            : {}),
          ...(record.review.reviewedAt
            ? { reviewedAt: record.review.reviewedAt }
            : {}),
          ...(record.review.mode ? { mode: record.review.mode } : {}),
          ...(record.review.inputHash
            ? { inputHash: record.review.inputHash }
            : {}),
          ...(record.review.voterEvidence
            ? { voterEvidence: [...record.review.voterEvidence] }
            : {}),
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
        authoringLaneIds().map((lane) => {
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
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    status: record.status,
    authoringInputHash: record.authoringInputHash,
    authoredMaterialHash: record.authoredMaterialHash,
    claims: record.claims.map((claim) => claim.id),
    artifacts: record.artifacts.map((artifact) => artifact.path),
    findingCount: record.findings?.length ?? 0,
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

function validOutputStatus(value: unknown): value is AuthoringLaneOutputStatus {
  return LANE_OUTPUT_STATUSES.includes(value as AuthoringLaneOutputStatus);
}

function boundedText(
  value: unknown,
  maximum = MAX_TEXT_BYTES,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function safeRelativePath(value: unknown): value is string {
  if (!boundedText(value, MAX_PATH_BYTES)) return false;
  const pathValue = value as string;
  if (path.isAbsolute(pathValue) || pathValue.includes("\0")) return false;
  const normalized = pathValue.replaceAll("\\", "/");
  return (
    normalized === path.posix.normalize(normalized) &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../../") &&
    !normalized.includes("//")
  );
}

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
]);

function authoredHeading(artifactPath: string): string | undefined {
  if (artifactPath.startsWith("source/")) return undefined;
  if (artifactPath === "SKILL.md") return "Decision Core";
  if (artifactPath.endsWith("/SKILL.md")) return "Guidance";
  return undefined;
}

type AuthoredContentTarget =
  "entry" | "node" | "decision-points" | "recovery" | "review" | undefined;

function authoredContentTarget(artifactPath: string): AuthoredContentTarget {
  if (artifactPath === "SKILL.md") return "entry";
  if (artifactPath.endsWith("/SKILL.md")) return "node";
  if (artifactPath === "reference/decision-points.md") {
    return "decision-points";
  }
  if (artifactPath === "reference/recovery.md") return "recovery";
  if (artifactPath === "reference/skill-review.md") return "review";
  return undefined;
}

function normalizedHeadingTitle(title: string): string {
  return title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function hasHeading(
  headings: Array<{ level: number; title: string }>,
  aliases: readonly string[],
): boolean {
  const normalizedAliases = aliases.map(normalizedHeadingTitle);
  return headings.some((heading) =>
    normalizedAliases.includes(normalizedHeadingTitle(heading.title)),
  );
}

function generatedNodeSkillPath(workflowName: string, nodeId: string): string {
  return `../${slug(workflowName) || "workflow"}-${slug(nodeId) || "node"}/SKILL.md`;
}

function containsToken(content: string, token: string): boolean {
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?:$|[^A-Za-z0-9_-])`,
    "iu",
  ).test(content);
}

function declaredReferenceFindings(
  content: string,
  artifactPath: string,
  workflow: WorkflowProtocol | undefined,
): string[] {
  if (!workflow) return [];
  const choiceIds = new Set(
    workflow.nodes.flatMap(
      (node) => node.decision?.choices.map((choice) => choice.id) ?? [],
    ),
  );
  const routeIds = declaredRouteIds(workflow);
  const findings: string[] = [];
  for (const match of content.matchAll(
    /\bchoice\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?/giu,
  )) {
    const choiceId = match[1]!;
    if (!choiceIds.has(choiceId)) {
      findings.push(
        `authored content references undeclared choice ${choiceId}: ${artifactPath}`,
      );
    }
  }
  for (const match of content.matchAll(
    /\broute\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?/giu,
  )) {
    const routeId = match[1]!;
    if (!routeIds.has(routeId)) {
      findings.push(
        `authored content references undeclared route ${routeId}: ${artifactPath}`,
      );
    }
  }
  return findings;
}

function declaredRouteIds(workflow: WorkflowProtocol): Set<string> {
  return new Set([
    ...(workflow.routing?.routes ?? []).map((route) => route.id),
    ...workflow.evals.flatMap(
      (evaluation) => evaluation.expectedRoutes?.map((route) => route.id) ?? [],
    ),
  ]);
}

function declaredRuntimeReferenceFindings(
  content: string,
  artifactPath: string,
  workflow: WorkflowProtocol | undefined,
): string[] {
  if (!workflow) return [];
  const activeNodes = workflow.nodes.filter((node) => !node.disabled);
  const routeIds = declaredRouteIds(workflow);
  const allowedNextTargets = new Set([
    "auto",
    "manual",
    "done",
    ...activeNodes.map((node) => node.id),
    ...routeIds,
  ]);
  const findings: string[] = [];
  for (const match of content.matchAll(
    /\bNEXT\s*:\s*`?([A-Za-z0-9][A-Za-z0-9._/-]*)`?/gu,
  )) {
    const nextTarget = match[1]!;
    if (!allowedNextTargets.has(nextTarget)) {
      findings.push(
        `authored content references undeclared NEXT target ${nextTarget}: ${artifactPath}`,
      );
    }
  }
  const allowedSkillTargets = new Set(
    activeNodes.flatMap((node) => [
      node.id,
      generatedNodeSkillPath(workflow.name, node.id).slice(
        3,
        -"/SKILL.md".length,
      ),
    ]),
  );
  for (const match of content.matchAll(
    /\bSKILL\s*:\s*`?([A-Za-z0-9][A-Za-z0-9._/-]*)`?/gu,
  )) {
    const skillTarget = match[1]!;
    if (!allowedSkillTargets.has(skillTarget)) {
      findings.push(
        `authored content references undeclared SKILL target ${skillTarget}: ${artifactPath}`,
      );
    }
  }
  return findings;
}

function containsImplicitLatestSelection(content: string): boolean {
  const pattern =
    /\b(?:latest|newest|most recent)\s+(?:artifact|version|output|result)\b/giu;
  for (const match of content.matchAll(pattern)) {
    const before = content.slice(
      Math.max(0, (match.index ?? 0) - 80),
      match.index,
    );
    if (
      /\b(?:not|never|cannot|must not|do not)\b[^.!?\n]{0,70}$/iu.test(before)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function sourceBody(content: string): string {
  const frontmatter =
    /^\uFEFF?---[ \t]*(?:\r?\n|$)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(
      content,
    );
  return (frontmatter ? content.slice(frontmatter[0].length) : content).trim();
}

async function copiesCompleteSourceSkillBody(
  state: CreatorState,
  content: string,
): Promise<boolean> {
  const normalizedContent = content.trim();
  if (
    state.confirmedProposal?.candidates.some((candidate) =>
      candidate.sources.some((source) => {
        const normalizedSource = sourceBody(source.skillMd);
        return (
          normalizedSource.length > 0 && normalizedSource === normalizedContent
        );
      }),
    )
  ) {
    return true;
  }
  const sourceRoots = [
    state.generated?.sourceRoot,
    state.generated?.packageRoot
      ? path.join(state.generated.packageRoot, "source")
      : undefined,
  ].filter((root): root is string => root !== undefined);
  for (const sourceRoot of sourceRoots) {
    try {
      const sourceContent = await fs.readFile(
        path.join(sourceRoot, "SKILL.md"),
        "utf8",
      );
      const normalizedSource = sourceBody(sourceContent);
      if (
        normalizedSource.length > 0 &&
        normalizedSource === normalizedContent
      ) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

function substantiveContentFindings(
  content: string,
  artifactPath: string,
  workflow?: WorkflowProtocol,
): string[] {
  const target = authoredContentTarget(artifactPath);
  if (!target) return [];
  const headings = markdownHeadings(content);
  const findings: string[] = [];
  const minimumWords =
    target === "node" || target === "entry"
      ? 45
      : target === "review"
        ? 30
        : 24;
  const wordCount = content.match(/[A-Za-z0-9][A-Za-z0-9'-]*/gu)?.length ?? 0;
  if (wordCount < minimumWords) {
    findings.push(`authored content is not substantive: ${artifactPath}`);
  }
  const requiredHeadings: Record<
    Exclude<AuthoredContentTarget, undefined>,
    readonly (readonly string[])[]
  > = {
    entry: [
      ["Automatic Node Detection"],
      ["Resume And Drift", "Resume Rules", "Error Handling And Resume Rules"],
      ["Decision Classification And Decision Points", "Decision Points"],
      ["Red Flags"],
    ],
    node: [
      ["Prerequisites"],
      ["Steps"],
      ["Required Skill Calls", "Required Bindings"],
      ["Evidence"],
      ["Completion Reasoning"],
      ["Red Flags"],
      ["Recovery"],
    ],
    "decision-points": [
      ["Classification"],
      ["Genuine User Decisions"],
      ["Automatic Handling"],
      ["Stop Conditions"],
      ["Manual Handoffs"],
    ],
    recovery: [
      ["State First", "State"],
      ["Resume Procedure", "Resume"],
      ["Drift Handling", "Drift"],
    ],
    review: [["Contract Fit"], ["Usability"], ["Strengths"], ["Findings"]],
  };
  for (const aliases of requiredHeadings[target]) {
    if (!hasHeading(headings, aliases)) {
      findings.push(
        `authored content missing substantive section ${aliases[0]}: ${artifactPath}`,
      );
    }
  }
  if (target === "entry") {
    const requiredPhrases = [
      ["current Node", /current\s+Node/iu],
      ["persisted state", /persisted[\s\w-]{0,30}state/iu],
      ["conversation history", /conversation\s+history/iu],
      ["topic change", /topic[\s\w-]{0,30}(?:change|shift|different)/iu],
      ["automatic handling", /automatic\s+handling/iu],
      ["manual handoff", /manual\s+handoff/iu],
      ["user decision", /user\s+decision/iu],
    ] as const;
    for (const [label, pattern] of requiredPhrases) {
      if (!pattern.test(content)) {
        findings.push(
          `authored entry content missing ${label}: ${artifactPath}`,
        );
      }
    }
  }
  if (target === "node") {
    const orderedSteps = content.match(/^\s*\d+[.)]\s+\S/gmu)?.length ?? 0;
    if (orderedSteps < 2) {
      findings.push(
        `authored Node guidance needs ordered domain steps: ${artifactPath}`,
      );
    }
    if (workflow) {
      const node = workflow.nodes.find(
        (candidate) =>
          !candidate.disabled &&
          (generatedNodeSkillPath(workflow.name, candidate.id) ===
            artifactPath ||
            artifactPath.endsWith(
              "-" + (slug(candidate.id) || "node") + "/SKILL.md",
            )),
      );
      const requiredSkillCalls = node?.requiredSkillCalls ?? [];
      if (requiredSkillCalls.length === 0) {
        if (
          !/no\s+(?:additional\s+)?Skill\s+Calls|no\s+required\s+Skill\s+Calls|none/iu.test(
            content,
          )
        ) {
          findings.push(
            `authored Node guidance must classify required Skill Calls: ${artifactPath}`,
          );
        }
      } else {
        for (const binding of requiredSkillCalls) {
          if (!containsToken(content, binding.skill)) {
            findings.push(
              `authored Node guidance omits required Skill Call ${binding.skill}: ${artifactPath}`,
            );
          }
        }
      }
      for (const schemaId of node?.outputSchemas ?? []) {
        if (!containsToken(content, schemaId)) {
          findings.push(
            `authored Node guidance omits output evidence ${schemaId}: ${artifactPath}`,
          );
        }
      }
    }
    if (
      !/\b(?:record|capture|submit|verify)\b[\s\w-]{0,50}\bevidence\b/iu.test(
        content,
      )
    ) {
      findings.push(
        `authored Node guidance must explain evidence handling: ${artifactPath}`,
      );
    }
    if (!/\b(?:persisted|resume|recover|re-enter)\b/iu.test(content)) {
      findings.push(
        `authored Node guidance must explain recovery: ${artifactPath}`,
      );
    }
  }
  if (target === "decision-points") {
    for (const category of [
      "genuine user decision",
      "automatic handling",
      "stop condition",
      "manual handoff",
    ]) {
      if (!content.toLocaleLowerCase().includes(category)) {
        findings.push(
          `decision-point content missing ${category}: ${artifactPath}`,
        );
      }
    }
  }
  if (target === "recovery") {
    const requiredPhrases = [
      ["fresh process", /fresh\s+process/iu],
      ["current Node", /current\s+Node/iu],
      ["blocked reason", /blocked[\s\w-]{0,30}(?:reason|condition)/iu],
      ["next step", /next\s+step/iu],
      ["persisted state", /persisted[\s\w-]{0,30}state/iu],
    ] as const;
    for (const [label, pattern] of requiredPhrases) {
      if (!pattern.test(content)) {
        findings.push(`recovery content missing ${label}: ${artifactPath}`);
      }
    }
  }
  if (target === "review") {
    if (!/\b(?:approved|passed|rejected|blocked)\b/iu.test(content)) {
      findings.push(`review content must record a verdict: ${artifactPath}`);
    }
    if (!/\bblocking\b/iu.test(content)) {
      findings.push(
        `review content must classify blocking findings: ${artifactPath}`,
      );
    }
  }
  if (containsImplicitLatestSelection(content)) {
    findings.push(
      `authored content cannot select an implicit latest artifact or version: ${artifactPath}`,
    );
  }
  findings.push(...declaredReferenceFindings(content, artifactPath, workflow));
  findings.push(
    ...declaredRuntimeReferenceFindings(content, artifactPath, workflow),
  );
  return findings;
}

function startsWithFrontmatter(content: string): boolean {
  return /^\uFEFF?---[ \t]*(?:\r?\n|$)/u.test(content);
}

function markdownHeadings(
  content: string,
): Array<{ level: number; title: string }> {
  const headings: Array<{ level: number; title: string }> = [];
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  for (const line of content.split(/\r?\n/u)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      const character = fence[1]![0] as "`" | "~";
      if (!fenceCharacter) {
        fenceCharacter = character;
        fenceLength = fence[1]!.length;
      } else if (
        character === fenceCharacter &&
        fence[1]!.length >= fenceLength
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (heading) {
      headings.push({
        level: heading[1]!.length,
        title: heading[2]!.trim(),
      });
    }
  }
  return headings;
}

function fencedCodeBlocks(content: string): Array<{
  language: string;
  body: string;
}> {
  const blocks: Array<{ language: string; body: string }> = [];
  let language: string | undefined;
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  let body: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      const character = fence[1]![0] as "`" | "~";
      if (!fenceCharacter) {
        fenceCharacter = character;
        fenceLength = fence[1]!.length;
        language =
          fence[2]!
            .trim()
            .split(/[ \t]+/u)[0]
            ?.toLowerCase() || "";
        body = [];
      } else if (
        character === fenceCharacter &&
        fence[1]!.length >= fenceLength
      ) {
        blocks.push({ language: language ?? "", body: body.join("\n") });
        language = undefined;
        fenceCharacter = undefined;
        fenceLength = 0;
        body = [];
      }
      continue;
    }
    if (fenceCharacter) body.push(line);
  }
  return blocks;
}

function declaredRuntimeCommand(line: string): boolean {
  const normalized = line.replace(/^\s*(?:[-*]|\$|>)\s*/u, "").trim();
  return /^node scripts\/(?:workflow-state|workflow-guard|workflow-handoff|badger-plan|badger-check|badger-hook-guard)\.mjs(?:\s|$)/u.test(
    normalized,
  );
}

const EXECUTABLE_COMMAND =
  /^(?:[-*]\s*)?(?:rm|rmdir|del|erase|mv|cp|install|curl|wget|sudo|chmod|chown|docker|podman|npm|npx|git|python|perl|ruby|make|tee|bash|sh|zsh|fish|pwsh|powershell)\b/iu;
const NODE_COMMAND = /^(?:[-*]\s*)?node\s+(?:-[A-Za-z]|scripts\/|\S+)/u;
const RUNTIME_CODE =
  /(?:child_process|execSync|spawnSync|process\.exit|<script\b|javascript:)/iu;

function isExecutableCommand(value: string): boolean {
  const normalized = value.replace(/^\s*(?:[-*]|\$|>)\s*/u, "").trim();
  return EXECUTABLE_COMMAND.test(normalized) || NODE_COMMAND.test(normalized);
}

function placeholderFinding(
  content: string,
  artifactPath: string,
): string | undefined {
  const patterns = [
    /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/iu,
    /\b(?:not yet authored|to be completed|fill in|insert (?:text|content|guidance))\b/iu,
    /\{\{[^}\r\n]{1,256}\}\}|\$\{[^}\r\n]{1,256}\}/u,
    /\[[ \t]*(?:TODO|TBD|FIXME|INSERT|PLACEHOLDER)[^\]\r\n]*\]/iu,
    /\b(?:NEXT|SKILL|route|choice)\s*:\s*<[^>\r\n]{1,256}>/iu,
  ];
  return patterns.some((pattern) => pattern.test(content))
    ? `authored content contains a placeholder: ${artifactPath}`
    : undefined;
}

function executableContentFindings(
  content: string,
  artifactPath: string,
): string[] {
  const findings: string[] = [];
  for (const block of fencedCodeBlocks(content)) {
    const code = block.body.trim();
    if (!code) continue;
    const lines = block.body
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*#.*$/u, "").trim())
      .filter(Boolean);
    const executableLanguage = new Set([
      "javascript",
      "js",
      "typescript",
      "ts",
      "jsx",
      "tsx",
    ]).has(block.language);
    if (
      SHELL_LANGUAGES.has(block.language) ||
      executableLanguage ||
      lines.some((line) => isExecutableCommand(line)) ||
      RUNTIME_CODE.test(code)
    ) {
      if (
        executableLanguage ||
        !SHELL_LANGUAGES.has(block.language) ||
        lines.some(
          (line) =>
            !declaredRuntimeCommand(line) || /[;&|<>`]|\$\(/u.test(line),
        )
      )
        findings.push(
          `authored content contains an undeclared executable command: ${artifactPath}`,
        );
    }
  }
  let inFence = false;
  for (const line of content.split(/\r?\n/u)) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && isExecutableCommand(line) && !declaredRuntimeCommand(line))
      findings.push(
        `authored content contains an undeclared executable command: ${artifactPath}`,
      );
  }
  for (const match of content.matchAll(/(?<!`)`([^`\n]+)`(?!`)/gu)) {
    const code = match[1]!.trim();
    if (
      (isExecutableCommand(code) && !declaredRuntimeCommand(code)) ||
      RUNTIME_CODE.test(code)
    )
      findings.push(
        `authored content contains an undeclared inline command: ${artifactPath}`,
      );
  }
  if (
    /^\s*#!\s*\/|\b(?:child_process|execSync|spawnSync|process\.exit)\b/imu.test(
      content,
    )
  )
    findings.push(
      `authored content contains executable runtime code: ${artifactPath}`,
    );
  return findings;
}

function authoredContentFindings(
  content: string,
  artifactPath: string,
  workflow?: WorkflowProtocol,
): string[] {
  const findings: string[] = [];
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES)
    findings.push(`authored content is too large: ${artifactPath}`);
  if (!content.trim())
    findings.push(`authored content is empty: ${artifactPath}`);
  if (content.includes("AUTHORING PENDING"))
    findings.push(
      `authored content contains a pending marker: ${artifactPath}`,
    );
  const placeholder = placeholderFinding(content, artifactPath);
  if (placeholder) findings.push(placeholder);
  if (startsWithFrontmatter(content))
    findings.push(
      `authored content cannot replace package frontmatter: ${artifactPath}`,
    );
  const headings = markdownHeadings(content);
  const seenHeadings = new Set<string>();
  for (const heading of headings) {
    const key = `${heading.level}:${heading.title.toLocaleLowerCase()}`;
    if (seenHeadings.has(key))
      findings.push(`duplicate authored section: ${heading.title}`);
    seenHeadings.add(key);
  }
  const expectedHeading = authoredHeading(artifactPath);
  if (expectedHeading) {
    const levelTwoHeadings = headings.filter((heading) => heading.level === 2);
    const expectedCount = levelTwoHeadings.filter(
      (heading) =>
        heading.title.toLocaleLowerCase() ===
        expectedHeading.toLocaleLowerCase(),
    ).length;
    if (expectedCount > 1)
      findings.push(`duplicate authored section: ${expectedHeading}`);
    for (const heading of headings) {
      if (heading.level === 1)
        findings.push(
          `authored ${artifactPath} cannot add a top-level heading`,
        );
      if (
        heading.level === 2 &&
        heading.title.toLocaleLowerCase() !==
          expectedHeading.toLocaleLowerCase()
      )
        findings.push(
          `authored ${artifactPath} cannot replace the generated ${heading.title} section`,
        );
    }
  }
  findings.push(...executableContentFindings(content, artifactPath));
  findings.push(...substantiveContentFindings(content, artifactPath, workflow));
  return [...new Set(findings)];
}

function assertAuthoredContent(
  content: string,
  artifactPath: string,
  workflow?: WorkflowProtocol,
): void {
  const findings = authoredContentFindings(content, artifactPath, workflow);
  if (findings.length) throw new Error(findings.join("; "));
}

function validateFindingList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${label} must be an array`];
  const findings: string[] = [];
  if (value.length > MAX_ARRAY_LENGTH)
    findings.push(`${label} exceeds its maximum length`);
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      findings.push(`${label}[${index}] must be an object`);
      continue;
    }
    if (!FINDING_SEVERITIES.includes(item.severity as never))
      findings.push(`${label}[${index}].severity is invalid`);
    if (!boundedText(item.problem))
      findings.push(`${label}[${index}].problem is invalid`);
    for (const field of ["path", "claim"] as const) {
      if (item[field] !== undefined && !safeRelativePath(item[field]))
        findings.push(`${label}[${index}].${field} is invalid`);
    }
    for (const field of ["impact", "fix"] as const) {
      if (item[field] !== undefined && !boundedText(item[field]))
        findings.push(`${label}[${index}].${field} is invalid`);
    }
  }
  return findings;
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label} must be an array`];
  const findings: string[] = [];
  if (value.length > MAX_ARRAY_LENGTH)
    findings.push(`${label} exceeds its maximum length`);
  for (const [index, item] of value.entries())
    if (!boundedText(item)) findings.push(`${label}[${index}] is invalid`);
  return findings;
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
  if (!boundedText(value.reviewer))
    findings.push("authoring review reviewer is required");
  if (!boundedText(value.summary))
    findings.push("authoring review summary is required");
  findings.push(
    ...validateStringList(
      value.blockingFindings,
      "authoring review blockingFindings",
    ),
    ...validateStringList(value.warnings, "authoring review warnings"),
    ...validateFindingList(value.findings, "authoring review findings"),
  );
  if (
    value.decision === "approved" &&
    Array.isArray(value.blockingFindings) &&
    value.blockingFindings.length > 0
  )
    findings.push("approved authoring review cannot contain blocking findings");
  if (value.passed !== undefined && typeof value.passed !== "boolean")
    findings.push("authoring review passed is invalid");
  if (
    value.evidenceSource !== undefined &&
    !EVIDENCE_SOURCES.includes(value.evidenceSource as never)
  )
    findings.push("authoring review evidenceSource is invalid");
  for (const field of ["voters", "rounds"] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isInteger(value[field]) ||
        Number(value[field]) < 0 ||
        Number(value[field]) > MAX_ARRAY_LENGTH)
    )
      findings.push(`authoring review ${field} is invalid`);
  }
  if (value.lenses !== undefined)
    findings.push(
      ...validateStringList(value.lenses, "authoring review lenses"),
    );
  if (value.reviewedAt !== undefined && !boundedText(value.reviewedAt))
    findings.push("authoring review reviewedAt is invalid");
  if (
    value.passed === true &&
    Array.isArray(value.blockingFindings) &&
    value.blockingFindings.length > 0
  )
    findings.push("passed authoring review cannot contain blocking findings");
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
  if (record.lane !== laneValue)
    findings.push(`authoring record lane mismatch: ${String(record.lane)}`);
  if (record.schemaVersion !== 1)
    findings.push("authoring record schemaVersion must be 1");
  if (record.kind !== "authoring-record")
    findings.push("authoring record kind is invalid");
  if (record.workflow !== plan.name)
    findings.push("authoring record workflow does not match the plan");
  if (
    record.revision !== undefined &&
    (!Number.isInteger(record.revision) || Number(record.revision) < 1)
  )
    findings.push("authoring record revision is invalid");
  if (record.protocolHash !== plan.protocolHash)
    findings.push("authoring record protocolHash is stale");
  for (const [field, expected] of [
    ["authoringPlanHash", plan.authoringPlanHash],
    ["workflowProtocolHash", plan.workflowProtocolHash],
    ["sourceEvidenceHash", plan.sourceEvidenceHash],
    ["authoringInputHash", authoringInputHash(plan)],
  ] as const) {
    if (record[field] !== expected)
      findings.push(`authoring record ${field} is stale`);
  }
  if (
    plan.semanticDossierHash &&
    record.semanticDossierHash !== plan.semanticDossierHash
  )
    findings.push(
      "Authoring lane output semanticDossierHash is stale or missing",
    );
  for (const field of [
    "protocolHash",
    "authoringPlanHash",
    "workflowProtocolHash",
    "sourceEvidenceHash",
    "authoringInputHash",
    "authoredMaterialHash",
  ]) {
    if (!HASH_PATTERN.test(String(record[field])))
      findings.push(`authoring record ${field} must be a SHA-256 hash`);
  }
  if (!boundedText(record.at)) findings.push("authoring record at is invalid");
  if (record.summary !== undefined && !summaryWithinBounds(record.summary))
    findings.push("authoring record summary is missing or too large");
  const status = record.status as AuthoringStatus;
  try {
    normalizeLaneAction(record.action, status, plan, laneValue);
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
  }
  if (!validRecordStatuses().includes(status))
    findings.push(`invalid authoring status: ${String(record.status)}`);
  if (status === "PENDING" || status === "IN_PROGRESS")
    findings.push(`authoring status is not a lane output: ${status}`);

  findings.push(
    ...validateFindingList(record.findings, "authoring record findings"),
  );
  for (const field of ["dispatchMode", "model"] as const) {
    if (record[field] !== undefined && !boundedText(record[field]))
      findings.push(`authoring record ${field} is invalid`);
  }

  const claims = Array.isArray(record.claims) ? record.claims : [];
  if (!Array.isArray(record.claims))
    findings.push("authoring record claims must be an array");
  if (claims.length > MAX_ARRAY_LENGTH)
    findings.push("authoring record claims exceeds its maximum length");
  const requiredClaimIds = authoringLaneClaimIds(lane.id, {
    derivedClaims: lane.derivedClaims,
  });
  const claimIds = new Set<string>();
  for (const [index, claimValue] of claims.entries()) {
    if (!isRecord(claimValue)) {
      findings.push(`authoring claim at index ${index} must be an object`);
      continue;
    }
    const id = claimValue.id;
    if (!boundedText(id)) {
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
      claimValue.evidence.length > MAX_ARRAY_LENGTH ||
      claimValue.evidence.some((item) => !boundedText(item))
    )
      findings.push(`invalid evidence for authoring claim: ${String(id)}`);
    if (claimValue.kind !== undefined && !boundedText(claimValue.kind))
      findings.push(`invalid kind for authoring claim: ${String(id)}`);
    if (claimValue.paths !== undefined) {
      findings.push(
        ...validateStringList(
          claimValue.paths,
          `paths for authoring claim ${String(id)}`,
        ),
      );
      for (const pathValue of claimValue.paths as unknown[])
        if (!safeRelativePath(pathValue))
          findings.push(`invalid path for authoring claim: ${String(id)}`);
    }
    if (claimValue.summary !== undefined && !boundedText(claimValue.summary))
      findings.push(`invalid summary for authoring claim: ${String(id)}`);
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
  if (!Array.isArray(record.artifacts))
    findings.push("authoring record artifacts must be an array");
  if (artifacts.length > MAX_ARRAY_LENGTH)
    findings.push("authoring record artifacts exceeds its maximum length");
  const allowedLeaves = new Set(lane.contentLeaves);
  const artifactPaths = new Set<string>();
  for (const [index, artifactValue] of artifacts.entries()) {
    if (!isRecord(artifactValue)) {
      findings.push(`authoring artifact at index ${index} must be an object`);
      continue;
    }
    const artifactPath = artifactValue.path;
    if (!safeRelativePath(artifactPath)) {
      findings.push(`authoring artifact at index ${index} requires a path`);
      continue;
    }
    if (!allowedLeaves.has(artifactPath))
      findings.push(`unknown authoring artifact path: ${artifactPath}`);
    if (artifactPaths.has(artifactPath))
      findings.push(`duplicate authoring artifact path: ${artifactPath}`);
    artifactPaths.add(artifactPath);
    if (!boundedText(artifactValue.id))
      findings.push(`authoring artifact id is required: ${artifactPath}`);
    if (typeof artifactValue.present !== "boolean")
      findings.push(`authoring artifact presence is invalid: ${artifactPath}`);
    if (
      artifactValue.contentHash !== undefined &&
      !HASH_PATTERN.test(String(artifactValue.contentHash))
    )
      findings.push(`authoring artifact hash is invalid: ${artifactPath}`);
    if (
      artifactValue.contentPath !== undefined &&
      !boundedText(artifactValue.contentPath, MAX_PATH_BYTES)
    )
      findings.push(
        `authoring artifact content path is invalid: ${artifactPath}`,
      );
    if (artifactValue.kind !== undefined && !boundedText(artifactValue.kind))
      findings.push(`authoring artifact kind is invalid: ${artifactPath}`);
    if (
      statusRequiresCompleteEvidence(status) &&
      allowedLeaves.has(artifactPath) &&
      artifactValue.present === true &&
      !HASH_PATTERN.test(String(artifactValue.contentHash))
    )
      findings.push(
        `complete authoring artifact has no content hash: ${artifactPath}`,
      );
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
    isRecord(record.review) &&
    statusRequiresCompleteEvidence(status)
  ) {
    findings.push(
      ...validateAuthoringReviewInput(
        record.review,
        plan,
        authoringInputHash(plan),
      ),
    );
  }
  if (isRecord(record.review)) {
    if (
      Array.isArray(record.review.lenses) &&
      (record.review.lenses.length !== plan.verify.lenses.length ||
        record.review.lenses.some(
          (lens, index) => lens !== plan.verify.lenses[index],
        ))
    )
      findings.push("authoring review lenses do not match the AuthoringPlan");
    if (
      record.review.evidenceSource === "llm-single" &&
      record.review.voters !== undefined &&
      record.review.voters !== plan.verify.voters
    )
      findings.push("single-vote authoring review voter count is invalid");
    if (
      record.review.evidenceSource === "llm-multivote" &&
      record.review.voters !== undefined &&
      record.review.voters !== plan.verify.voters
    )
      findings.push("multi-vote authoring review voter count is invalid");
    if (
      record.review.rounds !== undefined &&
      (typeof record.review.rounds !== "number" ||
        record.review.rounds < 1 ||
        record.review.rounds > plan.verify.maxRounds)
    )
      findings.push("authoring review round count is invalid");
    if (record.review.passed === true && record.review.decision !== "approved")
      findings.push("passed authoring review must be approved");
  }
  if (
    lane.id === "skill-review" &&
    statusRequiresCompleteEvidence(status) &&
    (!isRecord(record.review) || record.review.decision !== "approved")
  )
    findings.push("skill-review must have an approved authoring review");
  if (
    isRecord(record.review) &&
    record.review.passed === false &&
    statusRequiresCompleteEvidence(status)
  )
    findings.push("complete authoring record cannot have a failed review");
  if (HASH_PATTERN.test(String(record.authoredMaterialHash))) {
    try {
      if (
        record.authoredMaterialHash !==
        recordMaterialHash(record as unknown as AuthoringRecord)
      )
        findings.push("authoring record authoredMaterialHash is inconsistent");
    } catch {
      findings.push("authoring record authoredMaterialHash cannot be verified");
    }
  }
  return findings;
}

function normalizedFinding(
  value: unknown,
  label: string,
): AuthoringLaneFinding {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const findings = validateFindingList([value], label);
  if (findings.length) throw new Error(findings.join("; "));
  return {
    severity: value.severity as AuthoringLaneFinding["severity"],
    ...(value.path !== undefined ? { path: value.path as string } : {}),
    ...(value.claim !== undefined ? { claim: value.claim as string } : {}),
    problem: value.problem as string,
    ...(value.impact !== undefined ? { impact: value.impact as string } : {}),
    ...(value.fix !== undefined ? { fix: value.fix as string } : {}),
  };
}

function normalizedFindings(
  value: unknown,
  label: string,
): AuthoringLaneFinding[] {
  if (value === undefined) return [];
  const findings = validateFindingList(value, label);
  if (findings.length) throw new Error(findings.join("; "));
  return (value as unknown[]).map((item, index) =>
    normalizedFinding(item, `${label}[${index}]`),
  );
}

function normalizedReviewFindings(
  value: unknown,
  label: string,
): AuthoringReviewFinding[] {
  if (value === undefined) return [];
  const findings = validateFindingList(value, label);
  if (findings.length) throw new Error(findings.join("; "));
  return (value as unknown[]).map((item, index) => {
    const finding = normalizedFinding(
      item,
      `${label}[${index}]`,
    ) as AuthoringReviewFinding;
    if (!isRecord(item)) return finding;
    if (
      item.lens !== undefined &&
      !AUTHORING_REVIEW_LENSES.includes(
        item.lens as (typeof AUTHORING_REVIEW_LENSES)[number],
      )
    ) {
      throw new Error(`${label}[${index}].lens is invalid`);
    }
    if (
      item.source !== undefined &&
      !["provider", "deterministic"].includes(String(item.source))
    ) {
      throw new Error(`${label}[${index}].source is invalid`);
    }
    if (item.voterIds !== undefined) {
      if (
        !Array.isArray(item.voterIds) ||
        item.voterIds.some((voterId) => !boundedText(voterId))
      ) {
        throw new Error(`${label}[${index}].voterIds is invalid`);
      }
    }
    return {
      ...finding,
      ...(item.lens
        ? { lens: item.lens as AuthoringReviewFinding["lens"] }
        : {}),
      ...(item.source
        ? { source: item.source as AuthoringReviewFinding["source"] }
        : {}),
      ...(item.voterIds ? { voterIds: [...(item.voterIds as string[])] } : {}),
    };
  });
}

function normalizedClaim(
  value: unknown,
  label: string,
): AuthoringClaimEvidence {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (!boundedText(value.id)) throw new Error(`${label}.id is invalid`);
  const evidence =
    value.evidence === undefined
      ? [
          ...(boundedText(value.summary) ? [value.summary as string] : []),
          ...(Array.isArray(value.paths) ? (value.paths as string[]) : []),
        ]
      : value.evidence;
  if (!Array.isArray(evidence) || evidence.some((item) => !boundedText(item)))
    throw new Error(`${label}.evidence is invalid`);
  if (evidence.length > MAX_ARRAY_LENGTH)
    throw new Error(`${label}.evidence exceeds its maximum length`);
  const status = value.status ?? "SUPPORTED";
  if (!["SUPPORTED", "UNSUPPORTED", "NEEDS_CONTEXT"].includes(String(status)))
    throw new Error(`${label}.status is invalid`);
  let paths: string[] | undefined;
  if (value.paths !== undefined) {
    if (
      !Array.isArray(value.paths) ||
      value.paths.some((item) => !safeRelativePath(item))
    )
      throw new Error(`${label}.paths is invalid`);
    paths = [...(value.paths as string[])];
  }
  if (value.kind !== undefined && !boundedText(value.kind))
    throw new Error(`${label}.kind is invalid`);
  if (value.summary !== undefined && !boundedText(value.summary))
    throw new Error(`${label}.summary is invalid`);
  return {
    id: value.id as string,
    status: status as AuthoringClaimEvidence["status"],
    evidence: [...(evidence as string[])],
    ...(value.kind !== undefined ? { kind: value.kind as string } : {}),
    ...(paths ? { paths } : {}),
    ...(value.summary !== undefined
      ? { summary: value.summary as string }
      : {}),
  };
}

function normalizedArtifact(
  value: unknown,
  lane: AuthoringLane,
  label: string,
): AuthoringArtifactInput {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (!safeRelativePath(value.path))
    throw new Error(`${label}.path is invalid`);
  if (!lane.contentLeaves.includes(value.path as string))
    throw new Error(`Unknown authoring artifact path: ${String(value.path)}`);
  const result: AuthoringArtifactInput = {
    id: (value.id ?? value.path) as string,
    path: value.path as string,
    present: value.present === undefined ? true : (value.present as boolean),
    ...(value.content !== undefined
      ? { content: value.content as string }
      : {}),
    ...(value.contentPath !== undefined
      ? { contentPath: value.contentPath as string }
      : {}),
    ...(value.contentHash !== undefined
      ? { contentHash: value.contentHash as string }
      : {}),
    ...(value.kind !== undefined ? { kind: value.kind as string } : {}),
  };
  if (!boundedText(result.id)) throw new Error(`${label}.id is invalid`);
  if (typeof result.present !== "boolean")
    throw new Error(`${label}.present is invalid`);
  if (result.content !== undefined && typeof result.content !== "string")
    throw new Error(`${label}.content is invalid`);
  if (
    result.content !== undefined &&
    (result.present !== true ||
      Buffer.byteLength(result.content, "utf8") > MAX_ARTIFACT_BYTES ||
      !result.content.trim() ||
      result.content.includes("AUTHORING PENDING") ||
      startsWithFrontmatter(result.content))
  )
    throw new Error(`${label}.content is invalid`);
  if (
    result.content !== undefined &&
    result.contentHash !== undefined &&
    sha256(result.content) !== result.contentHash
  )
    throw new Error(`${label}.contentHash does not match content`);
  if (result.contentPath !== undefined && result.present !== true)
    throw new Error(`${label}.contentPath requires present=true`);
  if (
    result.contentPath !== undefined &&
    !boundedText(result.contentPath, MAX_PATH_BYTES)
  )
    throw new Error(`${label}.contentPath is invalid`);
  if (
    result.contentHash !== undefined &&
    !HASH_PATTERN.test(result.contentHash)
  )
    throw new Error(`${label}.contentHash is invalid`);
  if (result.kind !== undefined && !boundedText(result.kind))
    throw new Error(`${label}.kind is invalid`);
  return result;
}

function normalizedReview(
  value: unknown,
  model: unknown,
): AuthoringReviewOutput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Authoring review must be an object");
  if (typeof value.passed === "boolean") {
    if (!EVIDENCE_SOURCES.includes(value.evidenceSource as never))
      throw new Error("Authoring review evidenceSource is invalid");
    if (!boundedText(value.reviewedAt))
      throw new Error("Authoring review reviewedAt is invalid");
    if (!Array.isArray(value.findings))
      throw new Error("Authoring review findings must be an array");
    const findings = normalizedReviewFindings(
      value.findings,
      "authoring review findings",
    );
    const blockingFindings = findings
      .filter((finding) => finding.severity !== "minor")
      .map((finding) => finding.problem);
    const warnings = findings
      .filter((finding) => finding.severity === "minor")
      .map((finding) => finding.problem);
    if (value.passed && blockingFindings.length)
      throw new Error(
        "Passed authoring review cannot contain blocking findings",
      );
    return {
      decision:
        value.decision === "needs_context"
          ? "needs_context"
          : value.decision === "rejected" || !value.passed
            ? "rejected"
            : "approved",
      reviewer: boundedText(value.reviewer)
        ? value.reviewer
        : boundedText(model)
          ? (model as string)
          : "authoring-provider",
      summary: boundedText(value.summary)
        ? value.summary
        : value.passed
          ? "Authoring review passed."
          : findings.map((finding) => finding.problem).join("; ") ||
            "Authoring review did not pass.",
      blockingFindings: Array.isArray(value.blockingFindings)
        ? value.blockingFindings.filter(
            (finding): finding is string => typeof finding === "string",
          )
        : blockingFindings,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : warnings,
      passed: value.passed,
      evidenceSource:
        value.evidenceSource as AuthoringReviewOutput["evidenceSource"],
      ...(value.voters !== undefined ? { voters: value.voters as number } : {}),
      ...(value.lenses !== undefined
        ? { lenses: value.lenses as string[] }
        : {}),
      ...(value.rounds !== undefined ? { rounds: value.rounds as number } : {}),
      ...(value.dryRounds !== undefined
        ? { dryRounds: value.dryRounds as number }
        : {}),
      ...(value.mode !== undefined
        ? { mode: value.mode as AuthoringReviewOutput["mode"] }
        : {}),
      ...(value.inputHash !== undefined
        ? { inputHash: value.inputHash as string }
        : {}),
      ...(value.decision !== undefined
        ? {
            decision: value.decision as AuthoringReviewOutput["decision"],
          }
        : {}),
      ...(Array.isArray(value.voterEvidence)
        ? {
            voterEvidence:
              value.voterEvidence as AuthoringReviewVoterEvidence[],
          }
        : {}),
      findings,
      reviewedAt: value.reviewedAt as string,
    };
  }
  return value as unknown as AuthoringReviewOutput;
}

function normalizeLaneAction(
  value: unknown,
  status: unknown,
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
): AuthoringRecordInput["action"] {
  const required = Boolean(
    plan.semanticDossierHash &&
    plan.dag.wave1.includes(lane) &&
    (status === "NEEDS_CONTEXT" || status === "BLOCKED"),
  );
  if (value === undefined && !required) return undefined;
  if (
    !isRecord(value) ||
    !boundedText(value.prompt) ||
    !boundedText(value.requirement)
  )
    throw new Error(
      "Authoring lane action requires a bounded prompt and requirement",
    );
  const kind =
    status === "NEEDS_CONTEXT"
      ? "question"
      : status === "BLOCKED"
        ? "repair"
        : undefined;
  if (!kind || value.kind !== kind)
    throw new Error("Authoring lane action does not match status");
  if (kind === "question" && plan.semanticDossier) {
    const pointer = value.requirement as string;
    if (!pointer.startsWith("/") || pointer.includes("~"))
      throw new Error(
        "Authoring question action requires a dossier field pointer",
      );
    let field: unknown = plan.semanticDossier;
    for (const key of pointer.slice(1).split("/")) {
      if (!field || typeof field !== "object" || !Object.hasOwn(field, key))
        throw new Error(
          "Authoring question action identifies an unknown dossier field",
        );
      field = (field as Record<string, unknown>)[key];
    }
  }
  return {
    kind,
    prompt: value.prompt as string,
    requirement: value.requirement as string,
  };
}

function normalizeLaneOutput(
  value: unknown,
  plan: AuthoringPlan,
  expectedLane: AuthoringLaneId,
): AuthoringRecordInput {
  if (!isRecord(value))
    throw new Error("Authoring lane output must be an object");
  if (value.lane !== undefined && value.lane !== expectedLane)
    throw new Error(
      `Authoring lane output lane mismatch: expected ${expectedLane}`,
    );
  const status = value.status;
  if (status === "PENDING" || status === "IN_PROGRESS")
    throw new Error(
      `Authoring lane output status is invalid: ${String(status)}`,
    );
  if (status !== "COMPLETE" && !validOutputStatus(status))
    throw new Error(
      `Authoring lane output status is invalid: ${String(status)}`,
    );
  const lane = laneDefinition(plan, expectedLane);
  const claimsValue = value.claims;
  if (claimsValue !== undefined && !Array.isArray(claimsValue))
    throw new Error("Authoring lane output claims must be an array");
  if (Array.isArray(claimsValue) && claimsValue.length > MAX_ARRAY_LENGTH)
    throw new Error("Authoring lane output claims exceeds its maximum length");
  const claims = (claimsValue ?? []).map((claim, index) =>
    normalizedClaim(claim, `Authoring lane output claims[${index}]`),
  );
  const artifactsValue = value.artifacts;
  if (artifactsValue !== undefined && !Array.isArray(artifactsValue))
    throw new Error("Authoring lane output artifacts must be an array");
  if (Array.isArray(artifactsValue) && artifactsValue.length > MAX_ARRAY_LENGTH)
    throw new Error(
      "Authoring lane output artifacts exceeds its maximum length",
    );
  const artifacts = (artifactsValue ?? []).map((artifact, index) =>
    normalizedArtifact(
      artifact,
      lane,
      `Authoring lane output artifacts[${index}]`,
    ),
  );
  const findings = normalizedFindings(
    value.findings,
    "Authoring lane output findings",
  );
  let summary = value.summary;
  if (summary !== undefined && !summaryWithinBounds(summary))
    throw new Error("Authoring lane output summary is missing or too large");
  if (
    (status === "BLOCKED" ||
      status === "NEEDS_CONTEXT" ||
      status === "DONE_WITH_CONCERNS") &&
    !summary &&
    findings.length
  )
    summary = findings.map((finding) => finding.problem).join("; ");
  if (
    (status === "BLOCKED" ||
      status === "NEEDS_CONTEXT" ||
      status === "DONE_WITH_CONCERNS") &&
    !summary
  )
    throw new Error(`${status} authoring lane output requires a summary`);
  if (summary !== undefined && !summaryWithinBounds(summary))
    throw new Error("Authoring lane output summary is missing or too large");
  if (value.dispatchMode !== undefined && !boundedText(value.dispatchMode))
    throw new Error("Authoring lane output dispatchMode is invalid");
  if (value.model !== undefined && !boundedText(value.model))
    throw new Error("Authoring lane output model is invalid");
  if (
    value.expectedRevision !== undefined &&
    (!Number.isInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0)
  )
    throw new Error("Authoring lane output expectedRevision is invalid");
  const review = normalizedReview(value.review, value.model);
  const semanticDossierHash = value.semanticDossierHash;
  if (semanticDossierHash !== plan.semanticDossierHash)
    throw new Error(
      "Authoring lane output semanticDossierHash is stale or missing",
    );
  if (
    semanticDossierHash !== undefined &&
    !HASH_PATTERN.test(String(semanticDossierHash))
  )
    throw new Error("Authoring lane output semanticDossierHash is invalid");
  const action = normalizeLaneAction(value.action, status, plan, expectedLane);
  return {
    status: status as AuthoringStatus,
    claims,
    artifacts,
    findings,
    ...(value.dispatchMode !== undefined
      ? { dispatchMode: value.dispatchMode as string }
      : {}),
    ...(value.model !== undefined ? { model: value.model as string } : {}),
    ...(summary !== undefined ? { summary: summary as string } : {}),
    ...(value.expectedRevision !== undefined
      ? { expectedRevision: value.expectedRevision as number }
      : {}),
    ...(value.protocolHash !== undefined
      ? { protocolHash: value.protocolHash as string }
      : {}),
    ...(value.authoringPlanHash !== undefined
      ? { authoringPlanHash: value.authoringPlanHash as string }
      : {}),
    ...(value.workflowProtocolHash !== undefined
      ? { workflowProtocolHash: value.workflowProtocolHash as string }
      : {}),
    ...(value.sourceEvidenceHash !== undefined
      ? { sourceEvidenceHash: value.sourceEvidenceHash as string }
      : {}),
    ...(value.authoringInputHash !== undefined
      ? { authoringInputHash: value.authoringInputHash as string }
      : {}),
    ...(semanticDossierHash !== undefined
      ? { semanticDossierHash: semanticDossierHash as string }
      : {}),
    ...(action ? { action } : {}),
    ...(review ? { review } : {}),
  };
}

function validateNormalizedLaneInput(
  input: AuthoringRecordInput,
  plan: AuthoringPlan,
  laneId: AuthoringLaneId,
): string[] {
  const lane = laneDefinition(plan, laneId);
  const findings: string[] = [];
  const claims = input.claims ?? [];
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (claimIds.has(claim.id))
      findings.push(`duplicate authoring claim: ${claim.id}`);
    claimIds.add(claim.id);
    if (!expectedClaims(lane).includes(claim.id))
      findings.push(`unknown authoring claim: ${claim.id}`);
  }
  if (statusRequiresCompleteEvidence(input.status)) {
    for (const claimId of expectedClaims(lane)) {
      const claim = claims.find((item) => item.id === claimId);
      if (!claim) findings.push(`missing authoring claim: ${claimId}`);
      else if (claim.status !== "SUPPORTED" || claim.evidence.length === 0)
        findings.push(`complete authoring claim is not supported: ${claimId}`);
    }
  }
  const artifacts = input.artifacts ?? [];
  const artifactPaths = new Set<string>();
  for (const artifact of artifacts) {
    if (artifactPaths.has(artifact.path))
      findings.push(`duplicate authoring artifact path: ${artifact.path}`);
    artifactPaths.add(artifact.path);
    if (!lane.contentLeaves.includes(artifact.path))
      findings.push(`unknown authoring artifact path: ${artifact.path}`);
    if (statusRequiresCompleteEvidence(input.status)) {
      if (artifact.present !== true)
        findings.push(
          `complete authoring artifact is missing: ${artifact.path}`,
        );
      if (
        lane.contentLeaves.includes(artifact.path) &&
        artifact.content === undefined &&
        artifact.contentPath === undefined
      )
        findings.push(
          `complete authoring artifact has no content: ${artifact.path}`,
        );
      if (
        artifact.content !== undefined &&
        artifact.contentHash !== undefined &&
        sha256(artifact.content) !== artifact.contentHash
      )
        findings.push(
          `authoring artifact hash does not match content: ${artifact.path}`,
        );
    }
  }
  if (statusRequiresCompleteEvidence(input.status)) {
    for (const leaf of lane.contentLeaves)
      if (!artifactPaths.has(leaf))
        findings.push(`missing authoring artifact: ${leaf}`);
  }
  findings.push(
    ...validateReview(
      input.review,
      laneId === "skill-review" && statusRequiresCompleteEvidence(input.status),
    ),
  );
  return findings;
}

export function validateAuthoringLaneOutput(
  value: unknown,
  plan: AuthoringPlan,
  expectedLane: AuthoringLaneId,
): string[] {
  if (!isRecord(value) || typeof value.lane !== "string")
    return ["Authoring lane output lane is required"];
  if (value.status === "COMPLETE")
    return ["Authoring lane output status is invalid: COMPLETE"];
  try {
    const normalized = normalizeLaneOutput(value, plan, expectedLane);
    const findings = validateNormalizedLaneInput(
      normalized,
      plan,
      expectedLane,
    );
    for (const [field, expected] of [
      ["protocolHash", plan.protocolHash],
      ["authoringPlanHash", plan.authoringPlanHash],
      ["workflowProtocolHash", plan.workflowProtocolHash],
      ["sourceEvidenceHash", plan.sourceEvidenceHash],
      ["authoringInputHash", authoringInputHash(plan)],
    ] as const) {
      if (normalized[field] !== undefined && normalized[field] !== expected)
        findings.push(`Authoring lane output ${field} is stale`);
    }
    return findings;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export async function readAuthoringPlan(
  state: CreatorState,
): Promise<AuthoringPlan> {
  if (state.authoring) {
    const expectedRoot = sessionRoot(state);
    if (
      state.authoring.sessionPath !== expectedRoot ||
      (state.authoring.statePath !== undefined &&
        state.authoring.statePath !== sessionSummaryPath(state)) ||
      state.authoring.planPath !== path.join(expectedRoot, "plan.json") ||
      state.authoring.recordsPath !== path.join(expectedRoot, "records")
    )
      throw new Error("Authoring session paths are invalid");
  }
  const file = sessionPlanPath(state);
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.size > MAX_RECORD_BYTES)
    throw new Error("Authoring plan is not a bounded regular file");
  const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const findings = validateAuthoringPlan(value);
  if (findings.length)
    throw new Error(
      `Invalid authoring plan:\n${findings.map((finding) => finding.message).join("\n")}`,
    );
  return mapAuthoringPlanPaths(
    value as AuthoringPlan,
    toResolvedPaths(state.projectRoot),
  );
}

async function acquireSessionLock(root: string): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, ".lock");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const handle = await fs.open(lock, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) +
          "\n",
        "utf8",
      );
      await handle.close();
      return async () => {
        await fs.rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let invalid = false;
      try {
        const lockStats = await fs.lstat(lock);
        if (lockStats.isSymbolicLink()) {
          await fs.rm(lock, { force: true });
          continue;
        }
        if (!lockStats.isFile()) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (lockStats.size > MAX_TEXT_BYTES) {
          invalid = true;
        }
        if (invalid) {
          await fs.rm(lock, { force: true });
          continue;
        }
        const value = await fs.readFile(lock, "utf8");
        let pid: number | undefined;
        try {
          const parsed = JSON.parse(value) as { pid?: unknown };
          if (Number.isInteger(parsed.pid)) pid = parsed.pid as number;
        } catch {
          const parsed = Number(value.trim());
          if (Number.isInteger(parsed)) pid = parsed;
          else invalid = true;
        }
        if (pid === undefined) invalid = true;
        if (pid !== undefined) {
          try {
            process.kill(pid, 0);
          } catch (processError) {
            stale = (processError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT")
          throw readError;
      }
      if (stale || invalid) {
        await fs.rm(lock, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Authoring session is busy; retry the same operation");
}

export async function inspectAuthoringSessionLock(
  state: CreatorState,
): Promise<AuthoringSessionLock> {
  const lockPath = path.join(sessionRoot(state), ".lock");
  let stats;
  try {
    stats = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: lockPath, status: "available" };
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { path: lockPath, status: "invalid" };
  }
  if (stats.size > MAX_TEXT_BYTES) {
    return { path: lockPath, status: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return { path: lockPath, status: "invalid" };
  }
  if (!isRecord(value)) {
    return { path: lockPath, status: "invalid" };
  }
  const pid = value.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { path: lockPath, status: "invalid" };
  }
  const owner = {
    pid,
    ...(typeof value.at === "string" ? { at: value.at } : {}),
  };
  try {
    process.kill(owner.pid, 0);
    return { path: lockPath, status: "held", owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { path: lockPath, status: "stale", owner };
    }
    return { path: lockPath, status: "held", owner };
  }
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
  for (const lane of authoringLaneIds()) {
    const file = recordFile(state, lane);
    try {
      const stats = await fs.lstat(file);
      if (!stats.isFile()) {
        errors.push(`cannot read authoring record ${lane}: not a regular file`);
        continue;
      }
      if (stats.size > MAX_RECORD_BYTES) {
        errors.push(`cannot read authoring record ${lane}: file is too large`);
        continue;
      }
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const findings = validateAuthoringRecord(value, plan, lane);
      if (findings.length) {
        errors.push(`invalid authoring record ${lane}: ${findings.join("; ")}`);
      } else {
        records[lane] = mapAuthoringRecordPaths(
          value as AuthoringRecord,
          toResolvedPaths(state.projectRoot),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`cannot read authoring record ${lane}: ${String(error)}`);
    }
  }
  return { records, errors };
}

function sessionSummaryPath(state: CreatorState): string {
  return path.join(sessionRoot(state), "state.json");
}

function creatorStatePath(state: CreatorState): string {
  return path.join(
    state.projectRoot,
    ".badger",
    "states",
    `${state.name}.json`,
  );
}

function validAuthoringSummary(value: unknown): value is AuthoringStateSummary {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.status === "string" &&
    typeof value.sessionPath === "string" &&
    typeof value.planPath === "string" &&
    typeof value.recordsPath === "string" &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.generatorContractVersion === 1 ||
      value.generatorContractVersion ===
        AUTHORING_GENERATOR_CONTRACT_VERSION) &&
    typeof value.planHash === "string" &&
    typeof value.protocolHash === "string" &&
    typeof value.workflowProtocolHash === "string" &&
    typeof value.sourceEvidenceHash === "string" &&
    typeof value.authoringPlanHash === "string" &&
    typeof value.authoringInputHash === "string" &&
    typeof value.scaffoldHash === "string" &&
    (value.authoredMaterialHash === null ||
      typeof value.authoredMaterialHash === "string") &&
    (value.assembledPackageHash === null ||
      typeof value.assembledPackageHash === "string") &&
    isRecord(value.records)
  );
}

async function readSessionSummary(
  state: CreatorState,
): Promise<AuthoringStateSummary | undefined> {
  try {
    const stats = await fs.lstat(sessionSummaryPath(state));
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES)
      throw new Error("Authoring session summary is invalid");
    const value = JSON.parse(
      await fs.readFile(sessionSummaryPath(state), "utf8"),
    ) as unknown;
    if (!validAuthoringSummary(value))
      throw new Error("Authoring session summary is invalid");
    const summary = mapAuthoringSummaryPaths(
      value,
      toResolvedPaths(state.projectRoot),
    );
    const root = sessionRoot(state);
    const statePath =
      typeof summary.statePath === "string"
        ? summary.statePath
        : sessionSummaryPath(state);
    if (
      summary.sessionPath !== root ||
      statePath !== sessionSummaryPath(state) ||
      summary.planPath !== path.join(root, "plan.json") ||
      summary.recordsPath !== recordsRoot(state)
    )
      throw new Error("Authoring session summary paths are invalid");
    return normalizeAuthoringSummary({
      ...summary,
      statePath,
      generatorContractVersion: AUTHORING_GENERATOR_CONTRACT_VERSION,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function currentAuthoringSummary(
  state: CreatorState,
): Promise<AuthoringStateSummary | undefined> {
  try {
    const session = await readSessionSummary(state);
    if (session) return session;
    return state.authoring;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return state.authoring;
    throw error;
  }
}

function reconcileRecordRevision(
  state: CreatorState,
  authoring: AuthoringStateSummary,
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): AuthoringStateSummary {
  const revisions = Object.values(records)
    .map((record) => record?.revision ?? 0)
    .filter((revision) => Number.isInteger(revision));
  const highestRevision = Math.max(authoring.revision, ...revisions);
  const recordSummaries = Object.fromEntries(
    Object.entries(records).map(([lane, record]) => [
      lane,
      recordSummary(record!, recordFile(state, lane as AuthoringLaneId)),
    ]),
  );
  if (
    highestRevision === authoring.revision &&
    Object.keys(recordSummaries).length === 0
  )
    return authoring;
  return {
    ...authoring,
    revision: highestRevision,
    records: {
      ...authoring.records,
      ...recordSummaries,
    },
  };
}

function summaryStatus(
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): AuthoringSessionStatus {
  if (
    authoringLaneIds().every((lane) => isCompleteStatus(records[lane]?.status))
  )
    return "authored";
  return Object.keys(records).length ? "in-progress" : "pending";
}

async function writeSessionSummary(state: CreatorState): Promise<void> {
  if (!state.authoring) return;
  const summary = mapAuthoringSummaryPaths(
    {
      ...state.authoring,
      statePath: sessionSummaryPath(state),
    } satisfies AuthoringStateSummary,
    toStoredPaths(state.projectRoot),
  );
  await atomicWrite(
    sessionSummaryPath(state),
    JSON.stringify(summary, null, 2) + "\n",
  );
}

async function withAtomicSessionPersistence<T>(
  files: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const snapshots = new Map<string, string | undefined>();
  for (const file of [...new Set(files)]) {
    snapshots.set(file, await readOptionalText(file));
  }
  try {
    return await operation();
  } catch (error) {
    let rollbackError: unknown;
    for (const [file, content] of snapshots) {
      try {
        await restoreOptionalText(file, content);
      } catch (restoreError) {
        rollbackError ??= restoreError;
      }
    }
    if (rollbackError) {
      throw new Error(
        `Authoring session rollback failed after persistence error: ${String(rollbackError)}; original error: ${String(error)}`,
      );
    }
    throw error;
  }
}

export async function initializeAuthoringSession(options: {
  state: CreatorState;
  plan: AuthoringPlan;
  generated: GeneratedPackage;
}): Promise<CreatorState> {
  const planFindings = validateAuthoringPlan(options.plan);
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
    let persisted: CreatorState;
    try {
      persisted = await readState(state.projectRoot, state.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      persisted = state;
    }
    const sessionPrevious = await readSessionSummary(persisted);
    const previous = sessionPrevious ?? persisted.authoring;
    const sameInput = previous?.authoringInputHash === inputHash;
    await fs.mkdir(recordsRoot(persisted), { recursive: true });
    const planFile = path.join(root, "plan.json");
    const retainedRecords = previous?.records ?? {};
    const retainedLanes = authoringLaneIds().filter(
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
    persisted.generated = generated;
    persisted.authoring = {
      schemaVersion: 1,
      status: sameInput
        ? previous?.status === "assembled"
          ? "in-progress"
          : (previous?.status ?? "pending")
        : previous
          ? "stale"
          : "pending",
      workflow: options.plan.name,
      sessionPath: root,
      statePath: sessionSummaryPath(persisted),
      planPath: path.join(root, "plan.json"),
      recordsPath: recordsRoot(persisted),
      revision: (previous?.revision ?? 0) + 1,
      generatorContractVersion: AUTHORING_GENERATOR_CONTRACT_VERSION,
      planHash: options.plan.planHash,
      protocolHash: options.plan.protocolHash,
      workflowProtocolHash: options.plan.workflowProtocolHash,
      sourceEvidenceHash: options.plan.sourceEvidenceHash,
      authoringPlanHash: options.plan.authoringPlanHash,
      authoringInputHash: inputHash,
      ...(options.plan.semanticDossierHash
        ? { semanticDossierHash: options.plan.semanticDossierHash }
        : {}),
      scaffoldHash:
        options.generated.scaffoldHash ?? previous?.scaffoldHash ?? "",
      authoredMaterialHash: sameInput
        ? (previous?.authoredMaterialHash ?? null)
        : null,
      assembledPackageHash: null,
      review:
        sameInput && previous?.scaffoldHash === options.generated.scaffoldHash
          ? previous?.review
          : undefined,
      records: retainedRecords,
      ...(invalidatedLanes?.length ? { invalidatedLanes } : {}),
    };
    persisted.authoring.sessionId = authoringSessionIdentity(
      persisted.authoring,
    )!.sessionId;
    persisted.currentHash = null;
    persisted.eval = undefined;
    persisted.review = undefined;
    persisted.status = "generated";
    return withAtomicSessionPersistence(
      [planFile, sessionSummaryPath(persisted), creatorStatePath(persisted)],
      async () => {
        await atomicWrite(
          planFile,
          JSON.stringify(
            mapAuthoringPlanPaths(
              options.plan,
              toStoredPaths(persisted.projectRoot),
            ),
            null,
            2,
          ) + "\n",
        );
        await writeSessionSummary(persisted);
        await writeState(persisted);
        Object.assign(state, persisted);
        return persisted;
      },
    );
  });
}

export const createAuthoringSession = initializeAuthoringSession;

export async function readAuthoringSession(
  projectRoot: string,
  name: string,
): Promise<AuthoringStateSummary> {
  const state = await readState(projectRoot, name);
  const summary = await currentAuthoringSummary(state);
  if (!summary) throw new Error(`Authoring session is missing: ${name}`);
  try {
    const plan = await readAuthoringPlan(state);
    const stored = await readStoredRecords(state, plan);
    return reconcileRecordRevision(state, summary, stored.records);
  } catch {
    return summary;
  }
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
  if (!safeRelativePath(input.path))
    throw new Error("Authoring artifact path is required");
  if (!boundedText(input.id))
    throw new Error(`Authoring artifact id is required: ${input.path}`);
  if (typeof input.present !== "boolean")
    throw new Error(`Authoring artifact presence is invalid: ${input.path}`);
  if (input.kind !== undefined && !boundedText(input.kind))
    throw new Error(`Authoring artifact kind is invalid: ${input.path}`);
  let contentHash = input.contentHash;
  let contentPath: string | undefined;
  let content: string | undefined;
  if (input.content !== undefined) {
    if (typeof input.content !== "string")
      throw new Error(`Authoring artifact content is invalid: ${input.path}`);
    if (input.present !== true)
      throw new Error(
        `Authoring artifact content is not present: ${input.path}`,
      );
    if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES)
      throw new Error(`Authoring artifact content is too large: ${input.path}`);
    if (!input.content.trim())
      throw new Error(`Authoring artifact content is empty: ${input.path}`);
    if (input.content.includes("AUTHORING PENDING"))
      throw new Error(
        `Authoring artifact contains a pending marker: ${input.path}`,
      );
    if (startsWithFrontmatter(input.content))
      throw new Error(
        `Authoring artifact cannot replace package frontmatter: ${input.path}`,
      );
    content = input.content;
    contentHash = sha256(input.content);
    contentPath = path.join(
      sessionRoot(state),
      "artifacts",
      lane,
      `${sha256(`${input.path}:${contentHash}`)}.md`,
    );
  } else if (input.contentPath !== undefined) {
    const suppliedPath = path.resolve(state.projectRoot, input.contentPath);
    if (!isWithin(state.projectRoot, suppliedPath))
      throw new Error(
        `Authoring artifact content path escapes the project: ${input.path}`,
      );
    const realSuppliedPath = await fs.realpath(suppliedPath);
    if (!isWithin(state.projectRoot, realSuppliedPath))
      throw new Error(
        `Authoring artifact content path escapes the project: ${input.path}`,
      );
    if (isWithin(path.join(state.projectRoot, ".badger"), realSuppliedPath))
      throw new Error(
        `Authoring artifact content path is protected: ${input.path}`,
      );
    const suppliedStats = await fs.lstat(suppliedPath);
    if (!suppliedStats.isFile())
      throw new Error(
        `Authoring artifact content path is not a file: ${input.path}`,
      );
    if (suppliedStats.size > MAX_ARTIFACT_BYTES)
      throw new Error(`Authoring artifact content is too large: ${input.path}`);
    const suppliedContent = await fs.readFile(suppliedPath, "utf8");
    if (input.present !== true)
      throw new Error(
        `Authoring artifact content is not present: ${input.path}`,
      );
    if (Buffer.byteLength(suppliedContent, "utf8") > MAX_ARTIFACT_BYTES)
      throw new Error(`Authoring artifact content is too large: ${input.path}`);
    if (!suppliedContent.trim())
      throw new Error(`Authoring artifact content is empty: ${input.path}`);
    if (suppliedContent.includes("AUTHORING PENDING"))
      throw new Error(
        `Authoring artifact contains a pending marker: ${input.path}`,
      );
    if (startsWithFrontmatter(suppliedContent))
      throw new Error(
        `Authoring artifact cannot replace package frontmatter: ${input.path}`,
      );
    contentHash = sha256(suppliedContent);
    contentPath = path.join(
      sessionRoot(state),
      "artifacts",
      lane,
      `${sha256(`${input.path}:${contentHash}`)}.md`,
    );
    content = suppliedContent;
  }
  if (content !== undefined) {
    if (await copiesCompleteSourceSkillBody(state, content)) {
      throw new Error(
        `Authoring content copies a complete source Skill body: ${input.path}`,
      );
    }
    assertAuthoredContent(
      content,
      input.path,
      state.confirmedProposal?.workflow,
    );
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
      ...(input.kind ? { kind: input.kind } : {}),
    },
    ...(content !== undefined ? { content } : {}),
  };
}

export async function recordAuthoring(options: {
  state: CreatorState;
  lane: AuthoringLaneId;
  record: unknown;
  expectedRevision?: number;
  confirmed?: boolean;
}): Promise<AuthoringRecord> {
  if (options.confirmed !== true) {
    throw new Error(
      "Authoring record persistence requires explicit confirmation",
    );
  }
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
    let current: CreatorState;
    try {
      current = await readState(options.state.projectRoot, options.state.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = options.state;
    }
    const sessionSummary = await currentAuthoringSummary(current);
    if (sessionSummary) current.authoring = sessionSummary;
    if (!current.generated || !current.authoring)
      throw new Error(
        "Generate the workflow scaffold before recording authoring",
      );
    const currentPlan = await readAuthoringPlan(current);
    const input = normalizeLaneOutput(
      options.record,
      currentPlan,
      options.lane,
    );
    const expectedRevision = options.expectedRevision ?? input.expectedRevision;
    if (
      expectedRevision !== undefined &&
      (!Number.isInteger(expectedRevision) || expectedRevision < 0)
    )
      throw new Error("Authoring expected revision is invalid");
    const lane = laneDefinition(currentPlan, options.lane);
    const currentInputHash = authoringInputHash(currentPlan);
    if (current.authoring.authoringInputHash !== currentInputHash)
      throw new Error("Authoring session input evidence is stale");
    for (const [field, expected] of [
      ["protocolHash", currentPlan.protocolHash],
      ["authoringPlanHash", currentPlan.authoringPlanHash],
      ["workflowProtocolHash", currentPlan.workflowProtocolHash],
      ["sourceEvidenceHash", currentPlan.sourceEvidenceHash],
      ["authoringInputHash", current.authoring.authoringInputHash],
    ] as const) {
      if (input[field] !== undefined && input[field] !== expected)
        throw new Error(`Authoring record ${field} is stale`);
    }
    const stored = await readStoredRecords(current, currentPlan);
    current.authoring = reconcileRecordRevision(
      current,
      current.authoring,
      stored.records,
    );
    if (
      expectedRevision !== undefined &&
      expectedRevision !== current.authoring.revision
    ) {
      const conflict = new AuthoringRevisionConflictError(
        options.lane,
        expectedRevision,
        current.authoring.revision,
      );
      current.authoring = {
        ...current.authoring,
        statePath: sessionSummaryPath(current),
        conflict: conflict.conflict,
      };
      await writeSessionSummary(current);
      await writeState(current);
      Object.assign(options.state, current);
      throw conflict;
    }
    for (const dependency of lane.dependencies) {
      const dependencyRecord = stored.records[dependency];
      if (!dependencyRecord || !isCompleteStatus(dependencyRecord.status))
        throw new Error(
          `Authoring lane ${options.lane} is blocked by ${dependency}`,
        );
      if (
        dependencyRecord.authoringInputHash !==
        current.authoring.authoringInputHash
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
        current,
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
    const prior = current.authoring;
    const record: AuthoringRecord = {
      schemaVersion: 1,
      kind: "authoring-record",
      revision: prior.revision + 1,
      workflow: currentPlan.name,
      lane: options.lane,
      status: input.status,
      protocolHash: currentPlan.protocolHash,
      authoringPlanHash: currentPlan.authoringPlanHash,
      workflowProtocolHash: currentPlan.workflowProtocolHash,
      sourceEvidenceHash: currentPlan.sourceEvidenceHash,
      authoringInputHash: currentInputHash,
      ...(input.semanticDossierHash
        ? { semanticDossierHash: input.semanticDossierHash }
        : {}),
      authoredMaterialHash: "0".repeat(64),
      claims: claims as AuthoringClaimEvidence[],
      artifacts: normalizedArtifacts,
      ...(input.findings?.length ? { findings: input.findings } : {}),
      ...(input.dispatchMode ? { dispatchMode: input.dispatchMode } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(summary !== undefined ? { summary } : {}),
      at: new Date().toISOString(),
    };
    record.authoredMaterialHash = recordMaterialHash(record);
    const findings = validateAuthoringRecord(record, currentPlan, options.lane);
    if (findings.length)
      throw new Error(`Invalid authoring record:\n${findings.join("\n")}`);
    const transactionPaths = [
      ...pendingArtifacts.map((artifact) => artifact.path),
      recordFile(current, options.lane),
      sessionSummaryPath(current),
      creatorStatePath(current),
    ];
    const previousFiles = new Map<string, string | undefined>();
    for (const file of transactionPaths) {
      previousFiles.set(file, await readOptionalText(file));
    }
    try {
      for (const artifact of pendingArtifacts)
        await atomicWrite(artifact.path, artifact.content);
      await atomicWrite(
        recordFile(current, options.lane),
        JSON.stringify(
          mapAuthoringRecordPaths(record, toStoredPaths(current.projectRoot)),
          null,
          2,
        ) + "\n",
      );
      stored.records[options.lane] = record;
      const remainingInvalidated = prior.invalidatedLanes?.filter(
        (laneId) => laneId !== options.lane,
      );
      const invalidatedLanes = new Set(remainingInvalidated ?? []);
      for (const dependent of authoringDependentLanes(options.lane)) {
        if (stored.records[dependent] || prior.records[dependent])
          invalidatedLanes.add(dependent);
      }
      const orderedInvalidated = authoringLaneIds().filter((laneId) =>
        invalidatedLanes.has(laneId),
      );
      current.authoring = {
        ...prior,
        statePath: sessionSummaryPath(current),
        conflict: undefined,
        review: undefined,
        status: orderedInvalidated.length
          ? "stale"
          : summaryStatus(stored.records),
        revision: prior.revision + 1,
        authoredMaterialHash: recordsMaterialHash(stored.records),
        assembledPackageHash: null,
        records: {
          ...prior.records,
          [options.lane]: recordSummary(
            record,
            recordFile(current, options.lane),
          ),
        },
        ...(orderedInvalidated.length
          ? {
              invalidatedLanes: orderedInvalidated,
            }
          : { invalidatedLanes: undefined }),
      };
      current.generated = {
        ...current.generated,
        assembledPackageHash: undefined,
      };
      current.currentHash = null;
      current.eval = undefined;
      current.review = undefined;
      current.status = "generated";
      await writeSessionSummary(current);
      await writeState(current);
    } catch (error) {
      let rollbackError: unknown;
      for (const [file, content] of previousFiles) {
        try {
          await restoreOptionalText(file, content);
        } catch (restoreError) {
          rollbackError ??= restoreError;
        }
      }
      if (rollbackError) {
        throw new Error(
          `Authoring record rollback failed after persistence error: ${String(rollbackError)}; original error: ${String(error)}`,
        );
      }
      throw error;
    }
    Object.assign(options.state, current);
    return record;
  });
}

export async function recordAuthoringFile(options: {
  state: CreatorState;
  lane: AuthoringLaneId;
  file: string;
  expectedRevision?: number;
  confirmed?: boolean;
}): Promise<AuthoringRecord> {
  if (options.confirmed !== true) {
    throw new Error(
      "Authoring record persistence requires explicit confirmation",
    );
  }
  const file = path.resolve(options.file);
  if (isWithin(path.join(options.state.projectRoot, ".badger"), file))
    throw new Error("Authoring lane output cannot be read from .badger state");
  const stats = await fs.lstat(file);
  if (!stats.isFile()) throw new Error("Authoring lane output is not a file");
  if (stats.size > MAX_RECORD_BYTES)
    throw new Error("Authoring lane output exceeds its size limit");
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Authoring lane output is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return recordAuthoring({
    state: options.state,
    lane: options.lane,
    record: value,
    expectedRevision: options.expectedRevision,
    confirmed: options.confirmed,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sectionBody(content: string, heading: string): string {
  const headingPattern = new RegExp(
    `^## ${escapeRegExp(heading)}[ \\t]*$`,
    "mu",
  );
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
  const target = path.resolve(state.projectRoot, artifact.contentPath);
  if (!isWithin(sessionRoot(state), target))
    throw new Error(
      `Authoring artifact content path escapes the session: ${artifact.path}`,
    );
  const realTarget = await fs.realpath(target);
  if (!isWithin(sessionRoot(state), realTarget))
    throw new Error(
      `Authoring artifact content path escapes the session: ${artifact.path}`,
    );
  const stats = await fs.lstat(target);
  if (!stats.isFile())
    throw new Error(
      `Authoring artifact content is not a file: ${artifact.path}`,
    );
  if (stats.size > MAX_ARTIFACT_BYTES)
    throw new Error(
      `Authoring artifact content is too large: ${artifact.path}`,
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
  if (startsWithFrontmatter(content))
    throw new Error(
      `Authoring artifact cannot replace package frontmatter: ${artifact.path}`,
    );
  if (await copiesCompleteSourceSkillBody(state, content)) {
    throw new Error(
      `Authoring content copies a complete source Skill body: ${artifact.path}`,
    );
  }
  assertAuthoredContent(
    content,
    artifact.path,
    state.confirmedProposal?.workflow,
  );
  return content;
}

function replaceSection(
  original: string,
  heading: string,
  authoredContent: string,
): string {
  const headingPattern = new RegExp(
    `^## ${escapeRegExp(heading)}[ \\t]*$`,
    "mu",
  );
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
        semanticDossier: plan.semanticDossier
          ? {
              hash: plan.semanticDossierHash,
              schemaVersion: plan.semanticDossier.schemaVersion,
              kind: plan.semanticDossier.kind,
              confirmed: plan.semanticDossier.confirmed,
              workflow: { ...plan.semanticDossier.workflow },
              sources: plan.semanticDossier.sources.map((source) => ({
                id: source.id,
                name: source.name,
                canonicalPath: source.canonicalPath,
                contentHash: source.contentHash,
                roles: [...source.roles],
              })),
              ledger: {
                confirmedUserFacts:
                  plan.semanticDossier.confirmedUserFacts.length,
                sourceDerivedFacts:
                  plan.semanticDossier.sourceDerivedFacts.length,
                agentInferences: plan.semanticDossier.agentInferences.length,
                unresolvedAssumptions:
                  plan.semanticDossier.unresolvedAssumptions.length,
                remainingQuestions:
                  plan.semanticDossier.remainingQuestions.length,
              },
            }
          : null,
        status: "assembled",
        dag: plan.dag,
        deterministicBackbone: [
          ...authoringProtocolProjection().deterministicBackbone,
        ],
        controlPlane: {
          authority: "Badger assembler",
          scripts: authoringProtocolProjection().controlPlaneScripts.map(
            (script) => ({
              ...script,
            }),
          ),
          distinction: {
            plan: "badger-plan.mjs inspects the normalized WorkflowProtocol without mutating state.",
            check:
              "badger-check.mjs validates generated package completeness and assembled authoring status.",
            hook: "badger-hook-guard.mjs enforces the active WorkflowRuntime hook boundary.",
          },
        },
        lanes: authoringLaneIds().map((lane) => ({
          id: lane,
          dependencies: laneDefinition(plan, lane).dependencies,
          claims: expectedClaims(laneDefinition(plan, lane)),
          artifacts:
            records[lane]?.artifacts.map((artifact) => ({
              id: artifact.id,
              path: artifact.path,
              contentHash: artifact.contentHash ?? null,
            })) ?? [],
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

function compositionReport(
  plan: AuthoringPlan,
  state: CreatorState,
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>> = {},
): string {
  const selected = plan.sourceEvidence
    .map((candidate) => {
      const sources = candidate.sources
        .map((source) => `- ${source.name}: ${source.hash}`)
        .join("\n");
      return `### ${candidate.name}\n${sources || "- No source selected"}`;
    })
    .join("\n\n");
  const laneEvidence = authoringLaneIds()
    .map((laneId) => {
      const lane = laneDefinition(plan, laneId);
      const record = records[laneId];
      const claims =
        record?.claims.map((claim) => claim.id).join(", ") || "none";
      const artifacts =
        record?.artifacts.map((artifact) => artifact.path).join(", ") || "none";
      return `- ${laneId}: ${record?.status ?? "PENDING"}; claims=${claims}; artifacts=${artifacts}; required=${expectedClaims(lane).join(", ") || "none"}`;
    })
    .join("\n");
  return `# Composition Report

This deterministic report records the source and protocol identities used to assemble the package. It is audit evidence, not user guidance.

- Authoring Protocol: \`${plan.protocolHash}\`
- Workflow Protocol: \`${plan.workflowProtocolHash}\`
- Source evidence: \`${plan.sourceEvidenceHash}\`
- Authoring input: \`${state.authoring?.authoringInputHash ?? "(missing)"}\`
- Authored material: \`${state.authoring?.authoredMaterialHash ?? "(pending)"}\`

## Authoring Lanes

${laneEvidence}

## Resolved Skills

${selected || "- None"}
`;
}

function waveReadiness(
  id: AuthoringWaveReadiness["id"],
  lanes: readonly AuthoringLaneId[],
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
  nextLanes: readonly AuthoringLaneId[],
  plan?: AuthoringPlan,
  invalidated = new Set<AuthoringLaneId>(),
): AuthoringWaveReadiness {
  const completed = lanes.filter(
    (lane) => !invalidated.has(lane) && isCompleteStatus(records[lane]?.status),
  );
  const blocked: Partial<Record<AuthoringLaneId, string[]>> = {};
  for (const lane of lanes) {
    const definition = plan?.lanes.find((item) => item.id === lane);
    const dependencies =
      definition?.dependencies ?? authoringLaneDependencies(lane);
    const reasons = dependencies
      .filter(
        (dependency) =>
          invalidated.has(dependency) ||
          !isCompleteStatus(records[dependency]?.status),
      )
      .map((dependency) =>
        invalidated.has(dependency)
          ? `blocked by stale ${dependency}`
          : `blocked by ${dependency}`,
      );
    if (invalidated.has(lane)) reasons.push("lane has stale evidence");
    if (records[lane]?.status === "BLOCKED") reasons.push("lane is BLOCKED");
    if (records[lane]?.status === "NEEDS_CONTEXT")
      reasons.push("lane NEEDS_CONTEXT");
    if (records[lane]?.status === "DONE_WITH_CONCERNS")
      reasons.push("lane has concerns");
    if (reasons.length) blocked[lane] = reasons;
  }
  return {
    id,
    lanes: [...lanes],
    completed,
    next: lanes.filter((lane) => nextLanes.includes(lane)),
    blocked,
  };
}

function readinessLanes(
  plan: AuthoringPlan | undefined,
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
  nextLanes: readonly AuthoringLaneId[],
  blockers: readonly string[],
  invalidated = new Set<AuthoringLaneId>(),
): Record<AuthoringLaneId, AuthoringLaneReadiness> {
  return Object.fromEntries(
    authoringLaneIds().map((lane) => {
      const record = records[lane];
      const definition = plan?.lanes.find((item) => item.id === lane);
      const laneBlockers = [
        ...blockers.filter(
          (blocker) =>
            blocker.includes(`: ${lane}`) ||
            blocker.includes(` ${lane}`) ||
            blocker.includes(`by ${lane}`),
        ),
        ...(invalidated.has(lane) &&
        !blockers.some(
          (blocker) => blocker === `stale authoring record: ${lane}`,
        )
          ? [`stale authoring record: ${lane}`]
          : []),
      ];
      return [
        lane,
        {
          id: lane,
          dependencies: [
            ...(definition?.dependencies ?? authoringLaneDependencies(lane)),
          ],
          status: record?.status ?? "PENDING",
          executable: nextLanes.includes(lane),
          blockers: laneBlockers,
          claims: record?.claims ?? [],
          artifacts: record?.artifacts ?? [],
          findings: record?.findings ?? [],
          ...(record?.summary ? { summary: record.summary } : {}),
          ...(record?.action ? { action: record.action } : {}),
        } satisfies AuthoringLaneReadiness,
      ];
    }),
  ) as Record<AuthoringLaneId, AuthoringLaneReadiness>;
}

function recoveryInfo(
  state: CreatorState,
  authoring?: AuthoringStateSummary,
  recoveryRequired?: string,
): AuthoringRecoveryInfo {
  const session = authoring?.sessionPath ?? sessionRoot(state);
  return {
    resumable: Boolean(authoring),
    freshProcess: true,
    ...(recoveryRequired
      ? { recoveryRequired: true, reason: recoveryRequired }
      : {}),
    revision: authoring?.revision ?? 0,
    sessionPath: session,
    statePath: authoring?.statePath ?? path.join(session, "state.json"),
    planPath: authoring?.planPath ?? path.join(session, "plan.json"),
    recordsPath: authoring?.recordsPath ?? path.join(session, "records"),
    invalidatedLanes: [...(authoring?.invalidatedLanes ?? [])],
    ...(authoring?.conflict ? { conflict: authoring.conflict } : {}),
  };
}

export async function authoringReadiness(
  state: CreatorState,
): Promise<AuthoringReadiness> {
  const emptyRecords: Partial<Record<AuthoringLaneId, AuthoringRecord>> = {};
  const emptyLanes = readinessLanes(undefined, emptyRecords, [], []);
  const sessionLock = await inspectAuthoringSessionLock(state);
  let recoveredSummary: AuthoringStateSummary | undefined;
  let recoveryError: string | undefined;
  try {
    recoveredSummary =
      (await currentAuthoringSummary(state)) ?? state.authoring;
  } catch (error) {
    recoveryError = String(error);
    recoveredSummary = state.authoring;
  }
  if (recoveryError && !recoveredSummary) {
    return {
      state: "blocked",
      status: "stale",
      recoveryError,
      lock: sessionLock,
      blockers: [`Authoring session recovery required: ${recoveryError}`],
      warnings: [],
      evidence: {
        session: sessionRoot(state),
        plan: sessionPlanPath(state),
      },
      records: emptyRecords,
      nextLanes: [],
      completedLanes: [],
      lanes: emptyLanes,
      waves: [
        waveReadiness(
          "wave1",
          authoringLanesForWave("wave1"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "wave2",
          authoringLanesForWave("wave2"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "barrier",
          authoringLanesForWave("barrier"),
          emptyRecords,
          [],
        ),
      ],
      recovery: recoveryInfo(state, state.authoring, recoveryError),
    };
  }
  if (!state.generated || !recoveredSummary) {
    const legacyDraft = Boolean(state.generated);
    return {
      state: "blocked",
      status: legacyDraft ? "legacy" : "pending",
      lock: sessionLock,
      blockers: [
        legacyDraft
          ? "Legacy deterministic scaffold is scaffold-only; migrate before authoring or publication"
          : "Authoring session is missing; generate a confirmed scaffold",
      ],
      warnings: [],
      evidence: {
        draft: state.draftPath,
        ...(state.generated ? { generated: state.generated.packageRoot } : {}),
      },
      records: emptyRecords,
      nextLanes: [],
      completedLanes: [],
      lanes: emptyLanes,
      waves: [
        waveReadiness(
          "wave1",
          authoringLanesForWave("wave1"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "wave2",
          authoringLanesForWave("wave2"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "barrier",
          authoringLanesForWave("barrier"),
          emptyRecords,
          [],
        ),
      ],
      recovery: recoveryInfo(state),
    };
  }
  if (!state.authoring) state.authoring = recoveredSummary;
  let authoring: AuthoringStateSummary = recoveredSummary;
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
      completedLanes: [],
      lanes: emptyLanes,
      waves: [
        waveReadiness(
          "wave1",
          authoringLanesForWave("wave1"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "wave2",
          authoringLanesForWave("wave2"),
          emptyRecords,
          [],
        ),
        waveReadiness(
          "barrier",
          authoringLanesForWave("barrier"),
          emptyRecords,
          [],
        ),
      ],
      recovery: recoveryInfo(state, authoring),
    };
  }
  authoring = {
    ...authoring,
    workflow: authoring.workflow ?? plan.name,
    ...(plan.semanticDossierHash
      ? { semanticDossierHash: plan.semanticDossierHash }
      : {}),
  };
  authoring.sessionId = authoringSessionIdentity(authoring)!.sessionId;
  state.authoring = authoring;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (recoveryError) {
    blockers.push(`Authoring session recovery required: ${recoveryError}`);
    authoring = { ...authoring, status: "stale" };
  }
  const stored = await readStoredRecords(state, plan);
  blockers.push(...stored.errors);
  authoring = reconcileRecordRevision(state, authoring, stored.records);
  const invalidated = new Set(authoring.invalidatedLanes ?? []);
  const sourceDrift = await sourceEvidenceDrift(state, plan);
  if (sourceDrift.length) {
    for (const lane of authoringLaneIds()) invalidated.add(lane);
    authoring = {
      ...authoring,
      status: "stale",
      invalidatedLanes: authoringLaneIds().filter((lane) =>
        invalidated.has(lane),
      ),
    };
    blockers.push(...sourceDrift);
    blockers.push(
      "Source evidence drift invalidates all authoring lanes; regenerate and re-record them",
    );
    state.authoring = authoring;
  }
  const currentInputHash = authoringInputHash(plan);
  if (authoring.authoringInputHash !== currentInputHash)
    blockers.push("Authoring input evidence is stale; regenerate the scaffold");
  if (!HASH_PATTERN.test(authoring.scaffoldHash))
    blockers.push("Authoring scaffold hash is invalid");
  if (authoring.invalidatedLanes?.length)
    blockers.push(
      `Authoring records were invalidated for changed inputs: ${authoring.invalidatedLanes.join(", ")}`,
    );
  if (authoring.conflict)
    blockers.push(
      `Authoring revision conflict for ${authoring.conflict.lane}: expected ${authoring.conflict.expectedRevision}, actual ${authoring.conflict.actualRevision}`,
    );
  let hasContext = false;
  for (const laneId of authoringLaneIds()) {
    const lane = laneDefinition(plan, laneId);
    const record = stored.records[laneId];
    if (!record) {
      blockers.push(`missing authoring record: ${laneId}`);
      continue;
    }
    if (invalidated.has(laneId))
      blockers.push(`stale authoring record: ${laneId}`);
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
      if (
        !dependencyRecord ||
        invalidated.has(dependency) ||
        !isCompleteStatus(dependencyRecord.status)
      )
        blockers.push(
          `Authoring lane ${laneId} is blocked by${
            invalidated.has(dependency) ? " stale" : ""
          } ${dependency}`,
        );
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
  if (authoring.status === "assembled" && authoring.assembledPackageHash) {
    try {
      const currentPackageHash = await hashDirectory(packageRoot(state));
      if (currentPackageHash !== authoring.assembledPackageHash)
        blockers.push(
          "Assembled package changed outside the deterministic assembler",
        );
    } catch (error) {
      blockers.push(`Unable to hash assembled package: ${String(error)}`);
    }
  }
  const allRecordsComplete = authoringLaneIds().every(
    (lane) =>
      !invalidated.has(lane) && isCompleteStatus(stored.records[lane]?.status),
  );
  let review: AuthoringReviewResult | undefined;
  if (allRecordsComplete && blockers.length === 0) {
    try {
      const packageHash = await hashDirectory(packageRoot(state));
      review = await buildAuthoringReview({
        plan,
        records: stored.records,
        packageRoot: packageRoot(state),
        packageHash,
        authoringInputHash: currentInputHash,
        authoredMaterialHash:
          authoring.authoredMaterialHash ?? recordsMaterialHash(stored.records),
        assembled: authoring.status === "assembled",
      });
      warnings.push(...review.warnings);
      if (!review.passed) {
        blockers.push(
          `Authoring review did not pass${
            review.blockingFindings.length
              ? `: ${review.blockingFindings.join("; ")}`
              : ""
          }`,
        );
      }
      if (authoring.status === "assembled") {
        if (!authoring.review) {
          blockers.push("Authoring review evidence is missing");
        } else if (authoring.review.reviewHash !== review.reviewHash) {
          blockers.push("Authoring review evidence is stale");
        }
      }
    } catch (error) {
      blockers.push(`Unable to build authoring review: ${String(error)}`);
    }
  }
  const pendingMarkers = allRecordsComplete
    ? []
    : ["Generated scaffold contains authoring-pending content"];
  blockers.push(...pendingMarkers);
  const nextLanes = authoringLaneIds().filter((lane) => {
    if (
      stored.records[lane] &&
      !invalidated.has(lane) &&
      isCompleteStatus(stored.records[lane]!.status)
    )
      return false;
    return laneDefinition(plan, lane).dependencies.every(
      (dependency) =>
        !invalidated.has(dependency) &&
        isCompleteStatus(stored.records[dependency]?.status),
    );
  });
  const ready = blockers.length === 0 && allRecordsComplete;
  const completedLanes = authoringLaneIds().filter(
    (lane) =>
      !invalidated.has(lane) && isCompleteStatus(stored.records[lane]?.status),
  );
  const lanes = readinessLanes(
    plan,
    stored.records,
    nextLanes,
    blockers,
    invalidated,
  );
  const status: AuthoringSessionStatus = recoveryError
    ? "stale"
    : authoring.status === "assembled" &&
        authoring.assembledPackageHash &&
        ready
      ? "assembled"
      : authoring.status === "stale" ||
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
  const identity = authoringSessionIdentity(authoring);
  return {
    state: ready ? "ready" : hasContext ? "needs-context" : "blocked",
    status,
    ...(identity ? { identity } : {}),
    lock: sessionLock,
    ...(recoveryError ? { recoveryError } : {}),
    blockers,
    warnings,
    evidence: {
      session: sessionRoot(state),
      plan: sessionPlanPath(state),
      records: recordsRoot(state),
      scaffold: authoring.scaffoldHash,
      planHash: plan.planHash,
      protocol: plan.protocolHash,
      authoringPlan: plan.authoringPlanHash,
      workflowProtocol: plan.workflowProtocolHash,
      sourceEvidence: plan.sourceEvidenceHash,
      authoringInput: authoring.authoringInputHash,
      protocolHash: plan.protocolHash,
      authoringPlanHash: plan.authoringPlanHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
      authoringInputHash: authoring.authoringInputHash,
      ...(authoring.authoredMaterialHash
        ? { authoredMaterial: authoring.authoredMaterialHash }
        : {}),
      ...(authoring.assembledPackageHash
        ? { assembledPackage: authoring.assembledPackageHash }
        : {}),
    },
    records: stored.records,
    nextLanes,
    completedLanes,
    lanes,
    waves: [
      waveReadiness(
        "wave1",
        authoringLanesForWave("wave1"),
        stored.records,
        nextLanes,
        plan,
        invalidated,
      ),
      waveReadiness(
        "wave2",
        authoringLanesForWave("wave2"),
        stored.records,
        nextLanes,
        plan,
        invalidated,
      ),
      waveReadiness(
        "barrier",
        authoringLanesForWave("barrier"),
        stored.records,
        nextLanes,
        plan,
        invalidated,
      ),
    ],
    recovery: recoveryInfo(state, authoring, recoveryError),
    ...((review ?? authoring.review)
      ? { review: review ?? authoring.review }
      : {}),
  };
}

export const readAuthoringStatus = authoringReadiness;

function authoredLeafPaths(plan: AuthoringPlan): string[] {
  const laneContentLeaves = Object.fromEntries(
    plan.lanes.map((lane) => [lane.id, lane.contentLeaves]),
  );
  return Object.keys(authoringContentLeafOwners({ laneContentLeaves }));
}

async function assertAuthoringPlanCurrent(
  state: CreatorState,
  plan: AuthoringPlan,
): Promise<void> {
  const proposal = state.confirmedProposal;
  if (!proposal)
    throw new Error("Confirmed workflow proposal is missing for assembly");
  if (proposal.name !== plan.name)
    throw new Error(
      "Authoring plan workflow does not match the confirmed proposal",
    );
  if (proposal.planHash !== plan.planHash)
    throw new Error("Authoring plan is stale for the confirmed Factory plan");
  if (sha256(JSON.stringify(proposal.workflow)) !== plan.workflowProtocolHash)
    throw new Error(
      "Authoring plan is stale for the confirmed WorkflowProtocol",
    );
  const canonicalPlan = deriveAuthoringPlan({
    proposal,
    depth: plan.depth,
  });
  if (
    JSON.stringify(stableValue(canonicalPlan)) !==
    JSON.stringify(stableValue(plan))
  )
    throw new Error(
      "Authoring plan is not the canonical plan for this proposal",
    );
  const factoryPlan = await readPlan(state.planPath);
  if (sha256(JSON.stringify(factoryPlan)) !== proposal.planHash)
    throw new Error("Factory plan input is stale for the confirmed proposal");
}

async function sourceEvidenceDrift(
  state: CreatorState,
  plan: AuthoringPlan,
): Promise<string[]> {
  const sources = new Map<string, { label: string; hash: string }>();
  for (const candidate of plan.sourceEvidence) {
    for (const source of candidate.sources) {
      sources.set(source.root, { label: source.name, hash: source.hash });
    }
  }
  if (plan.upgradeSource) {
    sources.set(plan.upgradeSource.root, {
      label: "upgrade source",
      hash: plan.upgradeSource.hash,
    });
  }
  if (state.generated?.sourceRoot && state.generated.sourceHash) {
    sources.set(state.generated.sourceRoot, {
      label: "upgrade source",
      hash: state.generated.sourceHash,
    });
  }
  const findings: string[] = [];
  for (const [root, source] of sources) {
    let currentHash: string;
    try {
      currentHash = await hashDirectory(root);
    } catch (error) {
      findings.push(
        `Authoring source evidence is unavailable for ${source.label}: ${String(error)}`,
      );
      continue;
    }
    if (currentHash !== source.hash) {
      findings.push(`Authoring source evidence is stale: ${source.label}`);
    }
  }
  return findings;
}

async function assertSourceEvidenceCurrent(
  state: CreatorState,
  plan: AuthoringPlan,
): Promise<void> {
  const findings = await sourceEvidenceDrift(state, plan);
  if (findings.length) throw new Error(findings.join("\n"));
}

async function readPackageInventoryProjection(
  root: string,
  authoredPaths: readonly string[],
  status: "scaffold" | "assembled",
): Promise<string> {
  const inventoryPath = path.join(root, "reference", "package-inventory.json");
  const value = JSON.parse(await fs.readFile(inventoryPath, "utf8")) as {
    schemaVersion: number;
    kind: string;
    status: string;
    files: Array<{ path: string; owner: string }>;
  };
  const authored = new Set(authoredPaths);
  return (
    JSON.stringify(
      {
        ...value,
        status,
        files: value.files.map((file) => ({
          ...file,
          owner: file.path.startsWith("source/")
            ? "source"
            : authored.has(file.path)
              ? "authored"
              : "auto",
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

async function assertCurrentPackageMatchesScaffold(options: {
  currentRoot: string;
  scaffoldRoot: string;
  state: CreatorState;
  plan: AuthoringPlan;
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
}): Promise<void> {
  const currentStats = await fs.lstat(options.currentRoot);
  if (!currentStats.isDirectory() || currentStats.isSymbolicLink())
    throw new Error("Generated package root is not a regular directory");
  const projectRoot = await fs.realpath(options.state.projectRoot);
  const currentRoot = await fs.realpath(options.currentRoot);
  if (!isWithin(projectRoot, currentRoot))
    throw new Error("Generated package resolves outside the project root");
  const actualPaths = await listFiles(options.currentRoot);
  const expectedPaths = await listFiles(options.scaffoldRoot);
  const actualSet = new Set(
    actualPaths.map((value) => value.replaceAll("\\", "/")),
  );
  const expectedSet = new Set(
    expectedPaths.map((value) => value.replaceAll("\\", "/")),
  );
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  if (extra.length)
    throw new Error(
      `Generated package contains unauthorized files: ${extra.sort().join(", ")}`,
    );
  if (missing.length)
    throw new Error(
      `Generated package is missing deterministic files: ${missing.sort().join(", ")}`,
    );

  const authored = new Set(authoredLeafPaths(options.plan));
  const assembled = options.state.authoring?.status === "assembled";
  for (const relativePath of [...expectedSet].sort()) {
    if (authored.has(relativePath) && !authoredHeading(relativePath)) continue;
    const currentPath = path.join(options.currentRoot, relativePath);
    const scaffoldPath = path.join(options.scaffoldRoot, relativePath);
    let expected = await fs.readFile(scaffoldPath, "utf8");
    if (assembled && relativePath === "reference/authoring-lanes.json")
      expected = authoringLanesDocument(
        options.plan,
        options.state,
        options.records,
      );
    if (assembled && relativePath === "reference/composition-report.md")
      expected = compositionReport(
        options.plan,
        options.state,
        options.records,
      );
    if (assembled && relativePath === "reference/package-inventory.json")
      expected = await readPackageInventoryProjection(
        options.scaffoldRoot,
        [...authored],
        "assembled",
      );
    let current = await fs.readFile(currentPath, "utf8");
    if (relativePath === "reference/source-evidence.json") {
      const normalizeSourceEvidence = (content: string): string => {
        const value = JSON.parse(content) as Record<string, unknown>;
        return (
          JSON.stringify({ ...value, preservedAt: "scaffold" }, null, 2) + "\n"
        );
      };
      current = normalizeSourceEvidence(current);
      expected = normalizeSourceEvidence(expected);
    }
    const heading = authoredHeading(relativePath);
    const comparable = heading
      ? replaceSection(current, heading, "__AUTHORED_SECTION_IGNORED__")
      : current;
    const expectedComparable = heading
      ? replaceSection(expected, heading, "__AUTHORED_SECTION_IGNORED__")
      : expected;
    if (comparable !== expectedComparable)
      throw new Error(`Generated Auto-zone file changed: ${relativePath}`);
  }
}

async function assertAssembledPackage(
  root: string,
  authoredPaths: readonly string[],
): Promise<void> {
  const paths = await listFiles(root);
  const pathSet = new Set(paths.map((value) => value.replaceAll("\\", "/")));
  for (const relativePath of authoringProtocolProjection()
    .deterministicBackbone) {
    if (!pathSet.has(relativePath))
      throw new Error(
        `Assembled package is missing deterministic file: ${relativePath}`,
      );
  }
  const lanesPath = path.join(root, "reference", "authoring-lanes.json");
  const lanes = JSON.parse(await fs.readFile(lanesPath, "utf8")) as {
    status?: unknown;
    deterministicBackbone?: unknown;
    controlPlane?: { scripts?: unknown };
  };
  if (lanes.status !== "assembled")
    throw new Error(
      "Assembled authoring-lanes metadata is not marked assembled",
    );
  if (
    JSON.stringify(lanes.deterministicBackbone) !==
    JSON.stringify(authoringProtocolProjection().deterministicBackbone)
  )
    throw new Error("Assembled deterministic backbone metadata is invalid");
  if (
    JSON.stringify(lanes.controlPlane?.scripts ?? []) !==
    JSON.stringify(authoringProtocolProjection().controlPlaneScripts)
  )
    throw new Error("Assembled Badger control-plane mapping is invalid");
  const inventory = JSON.parse(
    await fs.readFile(
      path.join(root, "reference", "package-inventory.json"),
      "utf8",
    ),
  ) as { status?: unknown; files?: Array<{ path?: unknown }> };
  if (inventory.status !== "assembled")
    throw new Error("Assembled package inventory is not marked assembled");
  const inventoryPaths = new Set(
    (inventory.files ?? [])
      .filter((file): file is { path: string } => typeof file.path === "string")
      .map((file) => file.path),
  );
  if (
    paths.some(
      (relativePath) => !inventoryPaths.has(relativePath.replaceAll("\\", "/")),
    ) ||
    [...inventoryPaths].some((relativePath) => !pathSet.has(relativePath))
  )
    throw new Error(
      "Assembled package inventory does not match the package tree",
    );
  for (const relativePath of authoredPaths) {
    const content = await fs.readFile(path.join(root, relativePath), "utf8");
    if (content.includes("AUTHORING PENDING"))
      throw new Error(
        `Assembled package contains a pending marker: ${relativePath}`,
      );
    const heading = authoredHeading(relativePath);
    assertAuthoredContent(
      heading ? sectionBody(content, heading) : content,
      relativePath,
    );
  }
}

interface AssemblyDirectorySwap {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function swapAssemblyDirectory(
  source: string,
  destination: string,
): Promise<AssemblyDirectorySwap> {
  const sourceStats = await fs.lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink())
    throw new Error("Assembly staging root is not a regular directory");
  const parent = path.dirname(destination);
  const backup = path.join(
    parent,
    `.${path.basename(destination)}.${path.basename(source)}.backup`,
  );
  let hasBackup = false;
  try {
    const destinationStats = await fs.lstat(destination);
    if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory())
      throw new Error("Generated package root is not a regular directory");
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rename(destination, backup);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (hasBackup) await fs.rename(backup, destination).catch(() => undefined);
    throw error;
  }
  return {
    async commit() {
      if (hasBackup)
        await fs
          .rm(backup, { recursive: true, force: true })
          .catch(() => undefined);
    },
    async rollback() {
      await fs.rm(destination, { recursive: true, force: true });
      if (hasBackup) await fs.rename(backup, destination);
    },
  };
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreOptionalText(
  file: string,
  content: string | undefined,
): Promise<void> {
  if (content === undefined) await fs.rm(file, { force: true });
  else await atomicWrite(file, content);
}

export async function assemblePackage(
  state: CreatorState,
  confirmed = false,
): Promise<CreatorState> {
  if (!confirmed) {
    throw new Error("Authoring assembly requires explicit confirmation");
  }
  if (!state.generated)
    throw new Error("Generate the workflow scaffold before assembly");
  state.authoring ??= await currentAuthoringSummary(state);
  if (!state.authoring)
    throw new Error("Generate the workflow scaffold before assembly");
  const root = sessionRoot(state);
  return withSessionLock(root, async () => {
    let current: CreatorState;
    try {
      current = await readState(state.projectRoot, state.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = state;
    }
    const sessionSummary = await currentAuthoringSummary(current);
    if (sessionSummary) current.authoring = sessionSummary;
    if (!current.generated || !current.authoring)
      throw new Error("Generate the workflow scaffold before assembly");
    const readinessDecision = await authoringSessionDecision({
      state: current,
      operation: "assemble",
    });
    const readiness = readinessDecision.readiness;
    if (!readinessDecision.allowed)
      throw new Error(
        `Cannot assemble blocked authoring session:\n${readinessDecision.blockers.join("\n")}`,
      );
    const plan = await readAuthoringPlan(current);
    const stored = await readStoredRecords(current, plan);
    if (stored.errors.length)
      throw new Error(
        `Cannot assemble invalid authoring records:\n${stored.errors.join("\n")}`,
      );
    current.authoring = reconcileRecordRevision(
      current,
      current.authoring,
      stored.records,
    );
    const packageDirectory = packageRoot(current);
    await assertAuthoringPlanCurrent(current, plan);
    await assertSourceEvidenceCurrent(current, plan);
    const factoryPlan = await readPlan(current.planPath);
    if (factoryPlan.sourceRoot)
      factoryPlan.sourceRoot = path.resolve(
        current.projectRoot,
        factoryPlan.sourceRoot,
      );
    const stagingRoot = await fs.mkdtemp(
      path.join(
        path.dirname(packageDirectory),
        `.${path.basename(packageDirectory)}.assembly-`,
      ),
    );
    let moved = false;
    try {
      const scaffold = await generatePackage({
        proposal: current.confirmedProposal!,
        plan: factoryPlan,
        destination: stagingRoot,
      });
      if (current.authoring.scaffoldHash !== scaffold.scaffoldHash)
        throw new Error(
          "Generated scaffold is stale for the authoring session",
        );
      await assertCurrentPackageMatchesScaffold({
        currentRoot: packageDirectory,
        scaffoldRoot: scaffold.packageRoot,
        state: current,
        plan,
        records: stored.records,
      });
      const assembledSourceEvidence = scaffold.sourceEvidence
        ? { ...scaffold.sourceEvidence, preservedAt: "assembled" as const }
        : undefined;
      if (assembledSourceEvidence) {
        await atomicWrite(
          path.join(scaffold.packageRoot, "reference", "source-evidence.json"),
          JSON.stringify(assembledSourceEvidence, null, 2) + "\n",
        );
      }
      const authoredPaths = authoredLeafPaths(plan);
      const artifactTargets = new Set<string>();
      for (const laneId of authoringLaneIds()) {
        const record = stored.records[laneId]!;
        for (const artifact of record.artifacts) {
          const content = await readArtifactContent(current, artifact);
          const relativePath = packageRelativePath(artifact.path);
          if (artifactTargets.has(relativePath))
            throw new Error(
              `Duplicate authored package target: ${artifact.path}`,
            );
          artifactTargets.add(relativePath);
          const target = packageLeafPath(scaffold.packageRoot, artifact.path);
          const targetStats = await fs.lstat(target);
          if (!targetStats.isFile() || targetStats.isSymbolicLink())
            throw new Error(
              `Authored package target is not a regular file: ${artifact.path}`,
            );
          const heading = authoredHeading(artifact.path);
          await atomicWrite(
            target,
            heading
              ? replaceSection(
                  await fs.readFile(target, "utf8"),
                  heading,
                  content,
                )
              : content.endsWith("\n")
                ? content
                : `${content}\n`,
          );
        }
      }
      for (const authoredPath of authoredPaths)
        if (!artifactTargets.has(authoredPath))
          throw new Error(`Missing authored package target: ${authoredPath}`);
      await atomicWrite(
        path.join(scaffold.packageRoot, "reference", "authoring-lanes.json"),
        authoringLanesDocument(plan, current, stored.records),
      );
      await atomicWrite(
        path.join(scaffold.packageRoot, "reference", "composition-report.md"),
        compositionReport(plan, current, stored.records),
      );
      await writePackageInventory(
        scaffold.packageRoot,
        "assembled",
        authoredPaths,
      );
      await assertAssembledPackage(scaffold.packageRoot, authoredPaths);
      const assembledPackageHash = await hashDirectory(scaffold.packageRoot);
      const inventory = await inventoryPackage(
        scaffold.packageRoot,
        authoredPaths,
      );
      const authoredMaterialHash = recordsMaterialHash(stored.records);
      const authoringReview = await buildAuthoringReview({
        plan,
        records: stored.records,
        packageRoot: scaffold.packageRoot,
        packageHash: assembledPackageHash,
        authoringInputHash: current.authoring.authoringInputHash,
        authoredMaterialHash,
        assembled: true,
      });
      if (!authoringReview.passed) {
        throw new Error(
          `Cannot assemble failed authoring review:\n${authoringReview.blockingFindings.join("\n")}`,
        );
      }
      const authoring = current.authoring;
      const generated = current.generated;
      if (!authoring || !generated)
        throw new Error("Authoring session disappeared during assembly");
      const stateFile = path.join(
        current.projectRoot,
        ".badger",
        "states",
        `${current.name}.json`,
      );
      const previousSession = await readOptionalText(
        sessionSummaryPath(current),
      );
      const previousState = await readOptionalText(stateFile);
      const nextAuthoring: AuthoringStateSummary = {
        ...authoring,
        statePath: sessionSummaryPath(current),
        conflict: undefined,
        status: "assembled",
        revision: authoring.revision + 1,
        authoredMaterialHash,
        assembledPackageHash,
        review: authoringReview,
        invalidatedLanes: undefined,
      };
      const nextGenerated = {
        ...generated,
        packageRoot: packageDirectory,
        protocolPath: path.join(
          packageDirectory,
          "reference",
          "workflow-protocol.json",
        ),
        evalPath: path.join(packageDirectory, "badger", "eval.yaml"),
        authoringPlanPath: path.join(
          packageDirectory,
          "reference",
          "authoring-plan.json",
        ),
        inventory,
        assembledPackageHash,
        ...(assembledSourceEvidence
          ? { sourceEvidence: assembledSourceEvidence }
          : {}),
      };
      const swap = await swapAssemblyDirectory(
        scaffold.packageRoot,
        packageDirectory,
      );
      try {
        current.authoring = nextAuthoring;
        current.generated = nextGenerated;
        current.currentHash = null;
        current.eval = undefined;
        current.review = undefined;
        current.status = "generated";
        await writeSessionSummary(current);
        await writeState(current);
        await swap.commit();
        moved = true;
        Object.assign(state, current);
        return current;
      } catch (error) {
        let rollbackError: unknown;
        try {
          await restoreOptionalText(stateFile, previousState);
        } catch (restoreError) {
          rollbackError = restoreError;
        }
        try {
          await restoreOptionalText(
            sessionSummaryPath(current),
            previousSession,
          );
        } catch (restoreError) {
          rollbackError ??= restoreError;
        }
        try {
          await swap.rollback();
        } catch (restoreError) {
          rollbackError ??= restoreError;
        }
        if (rollbackError)
          throw new Error(
            `Assembly rollback failed after persistence error: ${String(rollbackError)}; original error: ${String(error)}`,
          );
        throw error;
      }
    } finally {
      if (!moved) await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  });
}
async function authoritativeAuthoringState(
  state: CreatorState,
): Promise<CreatorState> {
  try {
    const persisted = await readState(state.projectRoot, state.name);
    return persisted;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
    throw error;
  }
}

export async function invalidateAuthoringSession(
  options: AuthoringInvalidationOptions,
): Promise<AuthoringInvalidation> {
  if (options.confirmed !== true) {
    throw new Error("Authoring invalidation requires explicit confirmation");
  }
  const requested = [...new Set(options.lanes)];
  if (!requested.length) {
    throw new Error("Authoring invalidation requires at least one lane");
  }
  for (const lane of requested) {
    if (!authoringLaneIds().includes(lane)) {
      throw new Error(`Unknown authoring lane: ${lane}`);
    }
  }
  const state = await authoritativeAuthoringState(options.state);
  if (!state.authoring) {
    throw new Error("Authoring session is missing; cannot invalidate lanes");
  }
  const root = sessionRoot(state);
  return withSessionLock(root, async () => {
    const current = await authoritativeAuthoringState(state);
    const currentReadiness = await authoringReadiness(current);
    if (currentReadiness.recoveryError) {
      throw new Error(
        `Authoring session recovery required: ${currentReadiness.recoveryError}`,
      );
    }
    const authoring = current.authoring;
    if (!authoring) {
      throw new Error("Authoring session is missing; cannot invalidate lanes");
    }
    const currentRevision = authoring.revision;
    const conflict =
      options.expectedRevision !== undefined &&
      options.expectedRevision !== currentRevision
        ? {
            lane: requested[0]!,
            expectedRevision: options.expectedRevision,
            actualRevision: currentRevision,
            at: new Date().toISOString(),
          }
        : undefined;
    if (conflict) {
      current.authoring = {
        ...authoring,
        conflict,
        statePath: sessionSummaryPath(current),
      };
      await writeSessionSummary(current);
      await writeState(current);
      Object.assign(options.state, current);
      return {
        schemaVersion: 1,
        lanes: [],
        revision: currentRevision,
        reason: options.reason ?? "Authoring invalidation revision conflict",
        identity: authoringSessionIdentity(current.authoring),
        recovery: recoveryInfo(current, current.authoring),
        conflict,
      };
    }
    const retained = new Set<AuthoringLaneId>([
      ...(authoring.invalidatedLanes ?? []),
      ...Object.keys(authoring.records).filter(
        (lane): lane is AuthoringLaneId =>
          authoringLaneIds().includes(lane as AuthoringLaneId),
      ),
    ]);
    const invalidated = new Set<AuthoringLaneId>();
    for (const lane of requested) {
      for (const affected of authoringAffectedLanes(lane)) {
        if (retained.has(affected)) invalidated.add(affected);
      }
    }
    const ordered = authoringLaneIds().filter((lane) => invalidated.has(lane));
    const reason =
      options.reason ?? "Authoring inputs changed; re-record affected lanes";
    const nextAuthoring: AuthoringStateSummary = {
      ...authoring,
      statePath: sessionSummaryPath(current),
      status: "stale",
      revision: currentRevision + 1,
      assembledPackageHash: null,
      review: undefined,
      conflict: undefined,
      ...(ordered.length ? { invalidatedLanes: ordered } : {}),
    };
    nextAuthoring.sessionId =
      authoringSessionIdentity(nextAuthoring)?.sessionId;
    current.authoring = nextAuthoring;
    current.generated = current.generated
      ? { ...current.generated, assembledPackageHash: undefined }
      : current.generated;
    current.currentHash = null;
    current.eval = undefined;
    current.review = undefined;
    current.status = "generated";
    await withAtomicSessionPersistence(
      [sessionSummaryPath(current), creatorStatePath(current)],
      async () => {
        await writeSessionSummary(current);
        await writeState(current);
      },
    );
    Object.assign(options.state, current);
    return {
      schemaVersion: 1,
      lanes: ordered,
      revision: nextAuthoring.revision,
      reason,
      identity: authoringSessionIdentity(nextAuthoring),
      recovery: recoveryInfo(current, nextAuthoring),
    };
  });
}

function decisionState(
  readiness: AuthoringReadiness,
  blockers: readonly string[],
  conflict?: AuthoringRevisionConflict,
): AuthoringSessionDecision["state"] {
  if (
    conflict ||
    blockers.some((blocker) => /stale|invalidated/iu.test(blocker))
  ) {
    return "stale";
  }
  if (readiness.state === "needs-context") return "needs-context";
  return blockers.length === 0 ? "allowed" : "blocked";
}

function decisionFindings(
  readiness: AuthoringReadiness,
  lane?: AuthoringLaneId,
): AuthoringLaneFinding[] {
  if (lane) return [...(readiness.lanes[lane]?.findings ?? [])];
  return authoringLaneIds().flatMap((laneId) => [
    ...(readiness.lanes[laneId]?.findings ?? []),
  ]);
}

function operationBlockers(
  operation: AuthoringSessionOperation,
  readiness: AuthoringReadiness,
  lane?: AuthoringLaneId,
): string[] {
  if (operation === "invalidate") return [];
  if (operation === "dispatch" || operation === "record") {
    if (readiness.recoveryError || !readiness.recovery.resumable) {
      return readiness.blockers.length
        ? [...readiness.blockers]
        : ["Authoring session is missing; generate a confirmed scaffold"];
    }
    if (!lane) return [`Authoring ${operation} requires a lane`];
    const laneReadiness = readiness.lanes[lane];
    if (!laneReadiness) return [`Unknown authoring lane: ${lane}`];
    const invalidated = readiness.recovery.invalidatedLanes.includes(lane);
    const dependencyBlockers = laneReadiness.dependencies
      .filter((dependency) => !readiness.completedLanes.includes(dependency))
      .map(
        (dependency) =>
          `Authoring lane ${lane} blocked by${
            readiness.recovery.invalidatedLanes.includes(dependency)
              ? " stale"
              : ""
          } ${dependency}`,
      );
    const dependenciesReady = dependencyBlockers.length === 0;
    if (!invalidated && dependenciesReady) return [];
    const blockers = [
      ...new Set([...dependencyBlockers, ...laneReadiness.blockers]),
    ];
    return blockers.length
      ? blockers
      : [`Authoring lane ${lane} is not executable`];
  }
  if (operation === "assemble") {
    return readiness.state === "ready" ? [] : [...readiness.blockers];
  }
  if (readiness.status === "assembled" && readiness.state === "ready") {
    return [];
  }
  return [
    ...(readiness.blockers.length
      ? readiness.blockers
      : ["Authoring session is not assembled"]),
  ];
}

export async function authoringSessionDecision(
  options: AuthoringSessionDecisionOptions,
): Promise<AuthoringSessionDecision> {
  const state = await authoritativeAuthoringState(options.state);
  const readiness = await authoringReadiness(state);
  const blockers = operationBlockers(
    options.operation,
    readiness,
    options.lane,
  );
  let conflict: AuthoringRevisionConflict | undefined;
  if (
    options.expectedRevision !== undefined &&
    options.lane !== undefined &&
    options.expectedRevision !== readiness.recovery.revision
  ) {
    conflict = {
      lane: options.lane,
      expectedRevision: options.expectedRevision,
      actualRevision: readiness.recovery.revision,
      at: new Date().toISOString(),
    };
    blockers.push(
      `Authoring revision conflict ${options.lane}: expected ${options.expectedRevision}, actual ${readiness.recovery.revision}`,
    );
  }
  const identity = readiness.identity ?? authoringSessionIdentity(state);
  const lock = readiness.lock ?? (await inspectAuthoringSessionLock(state));
  if (lock.status === "invalid") {
    blockers.push("Authoring session lock is invalid");
  }
  if (
    lock.status === "held" &&
    lock.owner?.pid !== process.pid &&
    (options.operation === "record" ||
      options.operation === "assemble" ||
      options.operation === "publish" ||
      options.operation === "distribute")
  ) {
    blockers.push("Authoring session is locked by another process");
  }
  const status = decisionState(readiness, blockers, conflict);
  return {
    schemaVersion: 1,
    operation: options.operation,
    ...(options.lane ? { lane: options.lane } : {}),
    allowed: status === "allowed",
    state: status,
    blockers,
    warnings: [...readiness.warnings],
    findings: decisionFindings(readiness, options.lane),
    revision: readiness.recovery.revision,
    ...(identity ? { identity } : {}),
    readiness,
    recovery: {
      ...readiness.recovery,
      ...(conflict ? { conflict } : {}),
    },
    lock,
    ...(conflict ? { conflict } : {}),
  };
}

export async function authoringWriteGate(
  options: AuthoringWriteGateOptions,
): Promise<AuthoringWriteGate> {
  const decision = await authoringSessionDecision(options);
  const confirmed = options.confirmed === true;
  const blockers = [...decision.blockers];
  if (!confirmed) {
    const operationLabel =
      options.operation === "assemble" ? "assembly" : options.operation;
    blockers.push(`Authoring ${operationLabel} requires explicit confirmation`);
  }
  const status = decisionState(decision.readiness, blockers, decision.conflict);
  return {
    ...decision,
    operation: options.operation,
    confirmed,
    allowed: status === "allowed",
    state: status,
    blockers,
  };
}

export interface AuthoringSessionGateway {
  initialize(
    options: Parameters<typeof initializeAuthoringSession>[0],
  ): ReturnType<typeof initializeAuthoringSession>;
  read(
    projectRoot: string,
    name: string,
  ): ReturnType<typeof readAuthoringSession>;
  readiness(state: CreatorState): ReturnType<typeof authoringReadiness>;
  decide(
    options: AuthoringSessionDecisionOptions,
  ): Promise<AuthoringSessionDecision>;
  decision(
    options: AuthoringSessionDecisionOptions,
  ): Promise<AuthoringSessionDecision>;
  writeGate(options: AuthoringWriteGateOptions): Promise<AuthoringWriteGate>;
  lock(state: CreatorState): Promise<AuthoringSessionLock>;
  invalidate(
    options: AuthoringInvalidationOptions,
  ): Promise<AuthoringInvalidation>;
  record(options: AuthoringSessionRecordOptions): Promise<AuthoringRecord>;
  assemble(
    state: CreatorState,
    confirmed?: boolean,
  ): ReturnType<typeof assemblePackage>;
}

export function authoringSessionGateway(): AuthoringSessionGateway {
  return {
    initialize: initializeAuthoringSession,
    read: readAuthoringSession,
    readiness: authoringReadiness,
    decide: authoringSessionDecision,
    decision: authoringSessionDecision,
    writeGate: authoringWriteGate,
    lock: inspectAuthoringSessionLock,
    invalidate: invalidateAuthoringSession,
    record: async (options) => {
      const gate = await authoringWriteGate({
        state: options.state,
        operation: "record",
        lane: options.lane,
        expectedRevision: options.expectedRevision,
        confirmed: options.confirmed,
      });
      if (!gate.allowed) {
        throw new Error(
          `Cannot record authoring session:\n${gate.blockers.join("\n")}`,
        );
      }
      return recordAuthoring({
        state: options.state,
        lane: options.lane,
        record: options.record,
        expectedRevision: options.expectedRevision ?? gate.revision,
        confirmed: true,
      });
    },
    assemble: async (state, confirmed = false) => {
      const gate = await authoringWriteGate({
        state,
        operation: "assemble",
        confirmed,
      });
      if (!gate.allowed) {
        throw new Error(
          `Cannot assemble authoring session:\n${gate.blockers.join("\n")}`,
        );
      }
      return assemblePackage(state, true);
    },
  };
}
