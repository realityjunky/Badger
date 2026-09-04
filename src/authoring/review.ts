import { promises as fs } from "node:fs";
import path from "node:path";
import {
  hashDirectory,
  packageRelativePath,
  sha256,
  stableValue,
} from "../util.js";
import {
  AUTHORING_DETERMINISTIC_BACKBONE,
  AUTHORING_LANE_IDS,
} from "./protocol.js";
import {
  AUTHORING_REVIEW_LENSES,
  type AuthoringDepth,
  type AuthoringLaneFinding,
  type AuthoringLaneId,
  type AuthoringPlan,
  type AuthoringRecord,
  type AuthoringReviewFinding,
  type AuthoringReviewFindingSource,
  type AuthoringReviewOutput,
  type AuthoringReviewResult,
  type AuthoringReviewVoterEvidence,
} from "./types.js";

export { AUTHORING_REVIEW_LENSES };

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REVIEW_SOURCES = [
  "deterministic-check-only",
  "llm-single",
  "llm-multivote",
] as const;
const SEVERITIES = ["critical", "important", "minor"] as const;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_FINDINGS = 128;
const MAX_REVIEW_BYTES = 256 * 1024;

type ReviewSource = (typeof REVIEW_SOURCES)[number];

export interface AuthoringReviewContext {
  plan: AuthoringPlan;
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
  packageRoot: string;
  packageHash: string;
  authoringInputHash: string;
  authoredMaterialHash: string;
  assembled: boolean;
  input?: AuthoringReviewOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES
  );
}

function safeFindingPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    Buffer.byteLength(value, "utf8") <= 512 &&
    !path.isAbsolute(value) &&
    !normalized.includes("\0") &&
    normalized === path.posix.normalize(normalized) &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../../") &&
    !normalized.includes("//")
  );
}

function findingKey(finding: AuthoringReviewFinding): string {
  return JSON.stringify(
    stableValue({
      severity: finding.severity,
      lens: finding.lens ?? "self-consistency",
      path: finding.path ?? null,
      claim: finding.claim ?? null,
      problem: finding.problem,
      impact: finding.impact ?? null,
      fix: finding.fix ?? null,
    }),
  );
}

function normalizeFinding(
  finding: AuthoringReviewFinding,
  source: AuthoringReviewFindingSource,
  voterIds?: readonly string[],
): AuthoringReviewFinding {
  return {
    severity: finding.severity,
    ...(finding.path ? { path: finding.path } : {}),
    ...(finding.claim ? { claim: finding.claim } : {}),
    problem: finding.problem,
    ...(finding.impact ? { impact: finding.impact } : {}),
    ...(finding.fix ? { fix: finding.fix } : {}),
    lens: finding.lens ?? "self-consistency",
    source,
    ...(voterIds ? { voterIds: [...voterIds].sort() } : {}),
  };
}

function inputFindings(
  input: AuthoringReviewOutput,
  source: AuthoringReviewFindingSource,
): AuthoringReviewFinding[] {
  return (input.findings ?? []).map((finding) =>
    normalizeFinding(finding as AuthoringReviewFinding, source),
  );
}

function confirmedProviderFindings(
  input: AuthoringReviewOutput,
  mode: AuthoringDepth,
): AuthoringReviewFinding[] {
  const voters = input.voterEvidence ?? [];
  if (!voters.length) return inputFindings(input, "provider");
  const threshold = mode === "full" ? 2 : 1;
  const votes = new Map<
    string,
    { finding: AuthoringReviewFinding; voterIds: Set<string> }
  >();
  for (const voter of voters) {
    const seen = new Set<string>();
    for (const rawFinding of voter.findings) {
      const finding = normalizeFinding(rawFinding, "provider", [voter.id]);
      const key = findingKey(finding);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = votes.get(key);
      if (existing) existing.voterIds.add(voter.id);
      else votes.set(key, { finding, voterIds: new Set([voter.id]) });
    }
  }
  return [...votes.values()]
    .filter((entry) => entry.voterIds.size >= threshold)
    .map((entry) =>
      normalizeFinding(entry.finding, "provider", [...entry.voterIds]),
    );
}

function findingSeverityBlocker(finding: AuthoringReviewFinding): boolean {
  return finding.severity === "critical" || finding.severity === "important";
}

function sectionVerdict(
  input: AuthoringReviewOutput,
  findings: readonly AuthoringReviewFinding[],
  lens: "contract-fit" | "usability",
): "pass" | "fail" | "needs_context" {
  const explicit = input[lens === "contract-fit" ? "contractFit" : "usability"];
  if (explicit === "needs_context") return "needs_context";
  if (
    findings.some(
      (finding) => finding.lens === lens && findingSeverityBlocker(finding),
    )
  ) {
    return "fail";
  }
  if (explicit === "fail") return "fail";
  return "pass";
}

function reviewHash(value: Omit<AuthoringReviewResult, "reviewHash">): string {
  return sha256(JSON.stringify(stableValue(value)));
}

export function validateAuthoringReviewResult(value: unknown): string[] {
  if (!isRecord(value)) return ["authoring review evidence must be an object"];
  const findings: string[] = [];
  if (value.schemaVersion !== 1) {
    findings.push("authoring review evidence schemaVersion is invalid");
  }
  const reviewHashValue = value.reviewHash;
  if (!HASH_PATTERN.test(String(reviewHashValue))) {
    return [...findings, "authoring review evidence hash is invalid"];
  }
  const { reviewHash: _reviewHash, ...withoutHash } = value;
  findings.push(
    ...validateAuthoringReviewInput(
      { ...value, inputHash: value.authoringInputHash },
      {
        depth: value.mode as AuthoringDepth,
        verify: {
          voters: value.mode === "full" ? 3 : 1,
          lenses: [...AUTHORING_REVIEW_LENSES],
          maxRounds: value.mode === "full" ? 4 : 1,
          dryThreshold: 2,
          evidenceSource:
            value.mode === "full" ? "llm-multivote" : "llm-single",
          loopUntilDry: true,
        },
      } as Pick<AuthoringPlan, "depth" | "verify">,
      String(value.authoringInputHash),
    ),
  );
  if (
    reviewHash(withoutHash as Omit<AuthoringReviewResult, "reviewHash">) !==
    reviewHashValue
  ) {
    findings.push("authoring review evidence hash does not match contents");
  }
  for (const field of [
    "authoringInputHash",
    "authoredMaterialHash",
    "packageHash",
  ] as const) {
    if (!HASH_PATTERN.test(String(value[field]))) {
      findings.push(`authoring review ${field} is invalid`);
    }
  }
  if (Array.isArray(value.findings)) {
    value.findings.forEach((finding, index) => {
      if (
        !isRecord(finding) ||
        typeof finding.lens !== "string" ||
        typeof finding.source !== "string"
      ) {
        findings.push(
          `authoring review evidence findings[${index}] metadata is invalid`,
        );
      }
    });
  }
  if (Array.isArray(value.voterEvidence)) {
    value.voterEvidence.forEach((voter, voterIndex) => {
      if (isRecord(voter) && Array.isArray(voter.findings)) {
        voter.findings.forEach((finding, findingIndex) => {
          if (
            !isRecord(finding) ||
            typeof finding.lens !== "string" ||
            typeof finding.source !== "string"
          ) {
            findings.push(
              `authoring review evidence voterEvidence[${voterIndex}].findings[${findingIndex}] metadata is invalid`,
            );
          }
        });
      }
    });
  }
  return [...new Set(findings)];
}

export function hashAuthoringReviewVoterEvidence(
  value: Omit<AuthoringReviewVoterEvidence, "evidenceHash">,
): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function invalidInput(message: string): string[] {
  return [message];
}

function validateFindingInput(
  value: unknown,
  label: string,
  requireConcrete: boolean,
): string[] {
  if (!isRecord(value)) return invalidInput(`${label} must be an object`);
  const findings: string[] = [];
  if (!SEVERITIES.includes(value.severity as (typeof SEVERITIES)[number])) {
    findings.push(`${label}.severity is invalid`);
  }
  if (!boundedText(value.problem)) findings.push(`${label}.problem is invalid`);
  if (
    value.lens !== undefined &&
    !AUTHORING_REVIEW_LENSES.includes(
      value.lens as (typeof AUTHORING_REVIEW_LENSES)[number],
    )
  ) {
    findings.push(`${label}.lens is invalid`);
  }
  if (
    value.source !== undefined &&
    !["provider", "deterministic"].includes(String(value.source))
  ) {
    findings.push(`${label}.source is invalid`);
  }
  if (
    value.path !== undefined &&
    (!boundedText(value.path) || !safeFindingPath(value.path))
  ) {
    findings.push(`${label}.path is invalid`);
  }
  if (requireConcrete) {
    for (const field of ["path", "impact", "fix"] as const) {
      if (!boundedText(value[field]))
        findings.push(`${label}.${field} is required`);
    }
  } else {
    for (const field of ["impact", "fix"] as const) {
      if (value[field] !== undefined && !boundedText(value[field])) {
        findings.push(`${label}.${field} is invalid`);
      }
    }
  }
  if (value.voterIds !== undefined) {
    if (
      !Array.isArray(value.voterIds) ||
      value.voterIds.length > MAX_FINDINGS ||
      value.voterIds.some((voterId) => !boundedText(voterId))
    ) {
      findings.push(`${label}.voterIds is invalid`);
    }
  }
  return findings;
}

function validateVoterEvidence(
  value: unknown,
  index: number,
  authoringInputHash: string,
): string[] {
  const label = `authoring review voterEvidence[${index}]`;
  if (!isRecord(value)) return invalidInput(`${label} must be an object`);
  const findings: string[] = [];
  for (const field of ["id", "provider", "model"] as const) {
    if (!boundedText(value[field]))
      findings.push(`${label}.${field} is invalid`);
  }
  if (value.inputHash !== authoringInputHash) {
    findings.push(`${label}.inputHash is stale`);
  }
  if (!HASH_PATTERN.test(String(value.evidenceHash))) {
    findings.push(`${label}.evidenceHash is invalid`);
  }
  if (typeof value.passed !== "boolean") {
    findings.push(`${label}.passed is invalid`);
  }
  if (!Array.isArray(value.findings)) {
    findings.push(`${label}.findings must be an array`);
  } else {
    if (value.findings.length > MAX_FINDINGS) {
      findings.push(`${label}.findings exceeds its maximum length`);
    }
    value.findings.forEach((finding, findingIndex) => {
      findings.push(
        ...validateFindingInput(
          finding,
          `${label}.findings[${findingIndex}]`,
          true,
        ),
      );
    });
  }
  if (findings.length === 0) {
    const candidate = {
      id: value.id as string,
      provider: value.provider as string,
      model: value.model as string,
      inputHash: value.inputHash as string,
      passed: value.passed as boolean,
      findings: value.findings as AuthoringReviewFinding[],
    } satisfies Omit<AuthoringReviewVoterEvidence, "evidenceHash">;
    if (hashAuthoringReviewVoterEvidence(candidate) !== value.evidenceHash) {
      findings.push(`${label}.evidenceHash does not match evidence`);
    }
    if (candidate.passed && candidate.findings.some(findingSeverityBlocker)) {
      findings.push(`${label}.passed cannot contain blocking findings`);
    }
  }
  return findings;
}

export function validateAuthoringReviewInput(
  value: unknown,
  plan: Pick<AuthoringPlan, "depth" | "verify">,
  authoringInputHash: string,
): string[] {
  if (!isRecord(value))
    return invalidInput("authoring review must be an object");
  const findings: string[] = [];
  const source = (value.evidenceSource ??
    "deterministic-check-only") as ReviewSource;
  if (!REVIEW_SOURCES.includes(source)) {
    findings.push("authoring review evidenceSource is invalid");
  }
  const mode = (value.mode ?? plan.depth) as AuthoringDepth;
  if (mode !== "quick" && mode !== "full") {
    findings.push("authoring review mode is invalid");
  } else if (mode !== plan.depth) {
    findings.push("authoring review mode does not match AuthoringPlan");
  }
  if (!boundedText(value.reviewer))
    findings.push("authoring review reviewer required");
  if (!boundedText(value.summary))
    findings.push("authoring review summary required");
  if (
    value.decision !== undefined &&
    !["approved", "rejected", "needs_context"].includes(String(value.decision))
  ) {
    findings.push("authoring review decision is invalid");
  }
  if (value.passed !== undefined && typeof value.passed !== "boolean") {
    findings.push("authoring review passed is invalid");
  }
  if (value.inputHash !== undefined && value.inputHash !== authoringInputHash) {
    findings.push("authoring review inputHash is stale");
  }
  if (
    source !== "deterministic-check-only" &&
    value.inputHash !== authoringInputHash
  ) {
    findings.push(
      "authoring review inputHash is required for provider evidence",
    );
  }
  if (value.reviewedAt !== undefined && !boundedText(value.reviewedAt)) {
    findings.push("authoring review reviewedAt is invalid");
  }
  for (const field of ["blockingFindings", "warnings"] as const) {
    if (value[field] !== undefined) {
      if (
        !Array.isArray(value[field]) ||
        value[field].length > MAX_FINDINGS ||
        value[field].some((item) => !boundedText(item))
      ) {
        findings.push(`authoring review ${field} is invalid`);
      }
    }
  }
  if (value.lenses !== undefined) {
    if (
      !Array.isArray(value.lenses) ||
      value.lenses.length !== plan.verify.lenses.length ||
      value.lenses.some((lens, index) => lens !== plan.verify.lenses[index])
    ) {
      findings.push("authoring review lenses do not match AuthoringPlan");
    }
  }
  for (const field of ["voters", "rounds", "dryRounds"] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
    ) {
      findings.push(`authoring review ${field} is invalid`);
    }
  }
  if (value.findings !== undefined) {
    if (!Array.isArray(value.findings)) {
      findings.push("authoring review findings must be an array");
    } else if (value.findings.length > MAX_FINDINGS) {
      findings.push("authoring review findings exceeds its maximum length");
    } else {
      value.findings.forEach((finding, index) => {
        findings.push(
          ...validateFindingInput(
            finding,
            `authoring review findings[${index}]`,
            true,
          ),
        );
      });
    }
  }
  for (const field of ["contractFit", "usability"] as const) {
    if (
      value[field] !== undefined &&
      !["pass", "fail", "needs_context"].includes(String(value[field]))
    ) {
      findings.push(`authoring review ${field} is invalid`);
    }
  }
  const voterEvidence = value.voterEvidence;
  if (voterEvidence !== undefined) {
    if (!Array.isArray(voterEvidence)) {
      findings.push("authoring review voterEvidence must be an array");
    } else {
      if (voterEvidence.length > MAX_FINDINGS) {
        findings.push(
          "authoring review voterEvidence exceeds its maximum length",
        );
      }
      voterEvidence.forEach((voterValue, index) => {
        findings.push(
          ...validateVoterEvidence(voterValue, index, authoringInputHash),
        );
      });
      const ids = voterEvidence
        .filter(isRecord)
        .map((voterValue) => voterValue.id)
        .filter((id): id is string => typeof id === "string");
      if (new Set(ids).size !== ids.length) {
        findings.push(
          "authoring review voterEvidence must use independent voter ids",
        );
      }
    }
  }
  if (source === "llm-single") {
    if (!boundedText(value.reviewedAt)) {
      findings.push("quick authoring review reviewedAt is required");
    }
    if (mode !== "quick" || value.voters !== 1) {
      findings.push("quick authoring review must record exactly one voter");
    }
    if (value.rounds !== 1) {
      findings.push("quick authoring review must record exactly one round");
    }
    if (!Array.isArray(voterEvidence) || voterEvidence.length !== 1) {
      findings.push("quick authoring review must include one provider voter");
    }
  } else if (source === "llm-multivote") {
    if (!boundedText(value.reviewedAt)) {
      findings.push("full authoring review reviewedAt is required");
    }
    if (
      !Array.isArray(value.lenses) ||
      value.lenses.length !== AUTHORING_REVIEW_LENSES.length ||
      value.lenses.some(
        (lens, index) => lens !== AUTHORING_REVIEW_LENSES[index],
      )
    ) {
      findings.push("full authoring review must record all four lenses");
    }
    if (mode !== "full" || value.voters !== 3) {
      findings.push("full authoring review must record exactly three voters");
    }
    if (
      typeof value.rounds !== "number" ||
      value.rounds < 1 ||
      value.rounds > plan.verify.maxRounds
    ) {
      findings.push("full authoring review round count is invalid");
    }
    if (value.dryRounds !== plan.verify.dryThreshold) {
      findings.push(
        "full authoring review must record the two-round dry threshold",
      );
    }
    if (!Array.isArray(voterEvidence) || voterEvidence.length !== 3) {
      findings.push(
        "full authoring review must record three independent voters",
      );
    }
  } else {
    if (
      value.voterEvidence !== undefined &&
      (!Array.isArray(value.voterEvidence) || value.voterEvidence.length > 0)
    ) {
      findings.push(
        "deterministic authoring review cannot contain provider voters",
      );
    }
    if (value.voters !== undefined && value.voters !== 0) {
      findings.push(
        "deterministic authoring review cannot record provider voters",
      );
    }
  }
  if (
    value.passed === true &&
    Array.isArray(value.findings) &&
    value.findings.some(
      (finding) =>
        isRecord(finding) &&
        findingSeverityBlocker(finding as unknown as AuthoringReviewFinding),
    )
  ) {
    findings.push("passed authoring review cannot contain blocking findings");
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REVIEW_BYTES) {
      findings.push("authoring review exceeds its size limit");
    }
  } catch {
    findings.push("authoring review cannot be serialized");
  }
  return [...new Set(findings)];
}

export function composeAuthoringReview(options: {
  plan: Pick<AuthoringPlan, "depth" | "verify">;
  input: AuthoringReviewOutput;
  deterministicFindings: readonly AuthoringReviewFinding[];
  authoringInputHash: string;
  authoredMaterialHash: string;
  packageHash: string;
}): AuthoringReviewResult {
  const source = options.input.evidenceSource ?? "deterministic-check-only";
  const mode = (options.input.mode ?? options.plan.depth) as AuthoringDepth;
  const providerFindings =
    source === "deterministic-check-only"
      ? inputFindings(options.input, "deterministic")
      : confirmedProviderFindings(options.input, mode);
  const deterministicFindings = options.deterministicFindings.map((finding) =>
    normalizeFinding(finding, "deterministic"),
  );
  const findings = [...providerFindings, ...deterministicFindings];
  const declaredBlockingFindings = options.input.blockingFindings ?? [];
  for (const problem of declaredBlockingFindings) {
    if (findings.some((finding) => finding.problem === problem)) continue;
    findings.push({
      severity: "important",
      lens:
        source === "deterministic-check-only"
          ? "self-consistency"
          : "evidence-trace",
      source:
        source === "deterministic-check-only" ? "deterministic" : "provider",
      path: "reference/skill-review.md",
      problem,
      impact: "The authoring review reports an unresolved blocking concern.",
      fix: "Resolve the concern and submit a fresh bounded review.",
    });
  }
  if (
    (options.input.passed === false || options.input.decision === "rejected") &&
    findings.length === 0
  ) {
    findings.push({
      severity: "important",
      lens: "evidence-trace",
      source:
        source === "deterministic-check-only" ? "deterministic" : "provider",
      path: "reference/skill-review.md",
      problem: "Provider review reported failure without a concrete finding.",
      impact: "The authoring verdict cannot be audited.",
      fix: "Record a bounded finding with path, impact, and fix.",
    });
  }
  const contractFit = sectionVerdict(options.input, findings, "contract-fit");
  const usability = sectionVerdict(options.input, findings, "usability");
  const findingSource: AuthoringReviewFindingSource =
    source === "deterministic-check-only" ? "deterministic" : "provider";
  for (const [lens, verdict] of [
    ["contract-fit", contractFit],
    ["usability", usability],
  ] as const) {
    if (
      verdict !== "pass" &&
      !findings.some((finding) => finding.lens === lens)
    ) {
      findings.push({
        severity: "important",
        lens,
        source: findingSource,
        path: "reference/skill-review.md",
        problem: `${lens} review verdict is ${verdict}.`,
        impact: "The authoring review does not establish a usable package.",
        fix: `Resolve the ${lens} concerns and submit a fresh review.`,
      });
    }
  }
  const blockingFindings = findings
    .filter(findingSeverityBlocker)
    .map((finding) => finding.problem);
  const warnings = [
    ...(options.input.warnings ?? []),
    ...(source === "deterministic-check-only"
      ? [
          "Authoring review is deterministic-check-only; provider evidence is absent.",
        ]
      : []),
    ...findings
      .filter((finding) => finding.severity === "minor")
      .map((finding) => finding.problem),
  ];
  const decision =
    options.input.decision === "needs_context" ||
    contractFit === "needs_context" ||
    usability === "needs_context"
      ? "needs_context"
      : options.input.decision === "rejected" ||
          blockingFindings.length ||
          contractFit !== "pass" ||
          usability !== "pass"
        ? "rejected"
        : "approved";
  const resultWithoutHash: Omit<AuthoringReviewResult, "reviewHash"> = {
    schemaVersion: 1,
    mode,
    decision,
    passed: decision === "approved",
    contractFit,
    usability,
    evidenceSource: source,
    voters: options.input.voters ?? options.input.voterEvidence?.length ?? 0,
    lenses: [...AUTHORING_REVIEW_LENSES],
    rounds: options.input.rounds ?? 1,
    dryRounds: options.input.dryRounds ?? 1,
    reviewer: options.input.reviewer,
    summary:
      options.input.summary ||
      (decision === "approved"
        ? "Authoring review passed."
        : "Authoring review did not pass."),
    blockingFindings,
    warnings: [...new Set(warnings)],
    findings,
    reviewedAt: options.input.reviewedAt ?? "1970-01-01T00:00:00.000Z",
    authoringInputHash: options.authoringInputHash,
    authoredMaterialHash: options.authoredMaterialHash,
    packageHash: options.packageHash,
    voterEvidence: (options.input.voterEvidence ?? []).map((voter) => ({
      ...voter,
      findings: voter.findings.map((finding) =>
        normalizeFinding(finding, "provider"),
      ),
    })),
  };
  return {
    ...resultWithoutHash,
    reviewHash: reviewHash(resultWithoutHash),
  };
}

function recordFindings(
  plan: AuthoringPlan,
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>,
): AuthoringReviewFinding[] {
  const findings: AuthoringReviewFinding[] = [];
  for (const laneId of AUTHORING_LANE_IDS) {
    const lane = plan.lanes.find((candidate) => candidate.id === laneId);
    const record = records[laneId];
    if (!lane) continue;
    if (!record) {
      findings.push({
        severity: "important",
        lens: "evidence-trace",
        source: "deterministic",
        path: `records/${laneId}.json`,
        problem: `Authoring record is missing for ${laneId}.`,
        impact: "The review cannot establish complete lane evidence.",
        fix: `Submit the ${laneId} lane record before reviewing the package.`,
      });
      continue;
    }
    const expectedClaims = [...lane.claims, ...lane.derivedClaims];
    const claims = new Map(record.claims.map((claim) => [claim.id, claim]));
    for (const claimId of expectedClaims) {
      const claim = claims.get(claimId);
      if (
        !claim ||
        claim.status !== "SUPPORTED" ||
        claim.evidence.length === 0
      ) {
        findings.push({
          severity: "important",
          lens: "evidence-trace",
          source: "deterministic",
          path: `records/${laneId}.json`,
          claim: claimId,
          problem: `Required authoring claim is not supported: ${claimId}.`,
          impact: "The package meaning cannot be traced to a completed lane.",
          fix: `Record supported evidence for ${claimId}.`,
        });
      }
    }
    for (const claim of record.claims) {
      if (!expectedClaims.includes(claim.id)) {
        findings.push({
          severity: "important",
          lens: "contract-fit",
          source: "deterministic",
          path: `records/${laneId}.json`,
          claim: claim.id,
          problem: `Authoring record contains undeclared claim: ${claim.id}.`,
          impact: "Worker output is outside the declared AuthoringProtocol.",
          fix: `Remove ${claim.id} or declare it in the lane contract.`,
        });
      }
    }
    const artifactPaths = new Set(
      record.artifacts.map((artifact) => artifact.path),
    );
    for (const leaf of lane.contentLeaves) {
      if (!artifactPaths.has(leaf)) {
        findings.push({
          severity: "important",
          lens: "evidence-trace",
          source: "deterministic",
          path: `records/${laneId}.json`,
          problem: `Required authored artifact is missing: ${leaf}.`,
          impact: "The declared content leaf cannot be reviewed or assembled.",
          fix: `Submit authored content for ${leaf}.`,
        });
      }
    }
  }
  return findings;
}

async function packageFindings(
  options: AuthoringReviewContext,
): Promise<AuthoringReviewFinding[]> {
  const findings: AuthoringReviewFinding[] = [];
  let actualHash: string;
  try {
    actualHash = await hashDirectory(options.packageRoot);
  } catch (error) {
    return [
      {
        severity: "critical",
        lens: "self-consistency",
        source: "deterministic",
        path: options.packageRoot,
        problem: `Generated package cannot be hashed: ${String(error)}.`,
        impact: "Package identity cannot be bound to review evidence.",
        fix: "Restore a regular generated package and regenerate its inventory.",
      },
    ];
  }
  if (actualHash !== options.packageHash) {
    findings.push({
      severity: "critical",
      lens: "self-consistency",
      source: "deterministic",
      path: options.packageRoot,
      problem: "Generated package hash does not match review evidence.",
      impact: "Review evidence refers to a different package tree.",
      fix: "Recompute the package hash after deterministic assembly.",
    });
  }
  let files: string[] = [];
  try {
    files = await listFiles(options.packageRoot);
  } catch (error) {
    findings.push({
      severity: "critical",
      lens: "self-consistency",
      source: "deterministic",
      path: options.packageRoot,
      problem: `Generated package files cannot be enumerated: ${String(error)}.`,
      impact:
        "Commands and artifact paths cannot be checked deterministically.",
      fix: "Regenerate a regular package tree without links or special files.",
    });
  }
  const fileSet = new Set(files);
  for (const required of AUTHORING_DETERMINISTIC_BACKBONE) {
    if (!fileSet.has(required)) {
      findings.push({
        severity: "important",
        lens: "self-consistency",
        source: "deterministic",
        path: required,
        problem: `Required generated artifact is missing: ${required}.`,
        impact:
          "The generated package does not contain its deterministic control plane.",
        fix: `Regenerate ${required} from the confirmed workflow.`,
      });
    }
  }
  const inventoryPath = path.join(
    options.packageRoot,
    "reference",
    "package-inventory.json",
  );
  try {
    const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8")) as {
      files?: Array<{ path?: unknown; owner?: unknown }>;
    };
    const inventoryPaths = new Set(
      (inventory.files ?? [])
        .filter((file) => typeof file.path === "string")
        .map((file) => file.path as string),
    );
    if (
      inventoryPaths.size !== fileSet.size ||
      [...inventoryPaths].some((file) => !fileSet.has(file))
    ) {
      findings.push({
        severity: "critical",
        lens: "self-consistency",
        source: "deterministic",
        path: "reference/package-inventory.json",
        problem: "Generated package inventory does not match the package tree.",
        impact: "Generated artifact evidence is incomplete or stale.",
        fix: "Regenerate the package inventory from the assembled tree.",
      });
    }
    for (const required of AUTHORING_DETERMINISTIC_BACKBONE) {
      const entry = (inventory.files ?? []).find(
        (file) => file.path === required,
      );
      if (entry && entry.owner !== "auto") {
        findings.push({
          severity: "critical",
          lens: "contract-fit",
          source: "deterministic",
          path: "reference/package-inventory.json",
          problem: `Deterministic artifact has non-auto ownership: ${required}.`,
          impact:
            "Authored content could replace generator-owned control plane.",
          fix: `Mark ${required} as generator-owned and reassemble the package.`,
        });
      }
    }
  } catch (error) {
    findings.push({
      severity: "critical",
      lens: "self-consistency",
      source: "deterministic",
      path: "reference/package-inventory.json",
      problem: `Generated package inventory cannot be read: ${String(error)}.`,
      impact: "The package artifact set cannot be independently checked.",
      fix: "Regenerate the package inventory before review.",
    });
  }
  for (const [relativePath, expectedHash] of [
    ["reference/workflow-protocol.json", options.plan.workflowProtocolHash],
    ["reference/authoring-plan.json", options.plan.authoringPlanHash],
  ] as const) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(options.packageRoot, relativePath), "utf8"),
      );
      const canonical =
        relativePath === "reference/authoring-plan.json" && isRecord(parsed)
          ? Object.fromEntries(
              Object.entries(parsed).filter(
                ([key]) => key !== "authoringPlanHash",
              ),
            )
          : parsed;
      const actualIdentity =
        relativePath === "reference/authoring-plan.json"
          ? sha256(JSON.stringify(stableValue(canonical)))
          : sha256(JSON.stringify(canonical));
      if (actualIdentity !== expectedHash) {
        findings.push({
          severity: "critical",
          lens: "contract-fit",
          source: "deterministic",
          path: relativePath,
          problem: `Generated ${relativePath} hash does not match the AuthoringPlan.`,
          impact: "Review may describe a different executable workflow.",
          fix: `Regenerate ${relativePath} from the confirmed plan.`,
        });
      }
    } catch (error) {
      findings.push({
        severity: "critical",
        lens: "self-consistency",
        source: "deterministic",
        path: relativePath,
        problem: `Generated ${relativePath} cannot be checked: ${String(error)}.`,
        impact: "Package identity is not independently verifiable.",
        fix: `Restore ${relativePath} and regenerate the package.`,
      });
    }
  }
  if (options.assembled) {
    for (const lane of options.plan.lanes) {
      for (const artifact of lane.contentLeaves) {
        const relativePath = packageRelativePath(artifact);
        const target = path.join(options.packageRoot, relativePath);
        try {
          const content = await fs.readFile(target, "utf8");
          const authoredContent = authoredPackageSection(content, relativePath);
          if (
            /(?:^|\s)(?:npm|npx|curl|wget|sudo|docker|podman|bash|sh|python|perl|ruby)\b/imu.test(
              authoredContent,
            ) ||
            /\bnode\s+scripts\//iu.test(authoredContent)
          ) {
            findings.push({
              severity: "critical",
              lens: "self-consistency",
              source: "deterministic",
              path: relativePath,
              problem:
                "Authored content contains an undeclared executable command.",
              impact:
                "Authored prose could become an unreviewed execution authority.",
              fix: "Keep executable control-plane commands in generator-owned sections.",
            });
          }
        } catch (error) {
          findings.push({
            severity: "important",
            lens: "evidence-trace",
            source: "deterministic",
            path: relativePath,
            problem: `Authored content cannot be read: ${String(error)}.`,
            impact: "The review cannot inspect the final authored leaf.",
            fix: "Restore the declared authored leaf and reassemble the package.",
          });
        }
      }
    }
  }
  return findings;
}

function authoredPackageSection(content: string, relativePath: string): string {
  const heading =
    relativePath === "SKILL.md"
      ? "Decision Core"
      : relativePath.endsWith("/SKILL.md")
        ? "Guidance"
        : undefined;
  if (!heading) return content;
  const match = new RegExp(`^## ${heading}[ \\t]*$`, "mu").exec(content);
  if (!match) return content;
  const bodyStart = match.index + match[0].length;
  const nextHeading = /^##\s+/mu.exec(content.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : content.length;
  return content.slice(bodyStart, bodyEnd);
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, next)));
    else if (entry.isFile()) files.push(next.replaceAll("\\", "/"));
    else
      throw new Error(`Generated package contains unsupported entry: ${next}`);
  }
  return files;
}

export async function buildAuthoringReview(
  options: AuthoringReviewContext,
): Promise<AuthoringReviewResult> {
  const input = options.input ?? options.records["skill-review"]?.review;
  const reviewInput: AuthoringReviewOutput = input ?? {
    decision: "rejected",
    reviewer: "authoring-reviewer",
    summary: "Authoring review evidence is missing.",
    blockingFindings: ["Authoring review evidence is missing."],
    warnings: [],
    passed: false,
    evidenceSource: "deterministic-check-only",
    mode: options.plan.depth,
    voters: 0,
    lenses: [...AUTHORING_REVIEW_LENSES],
    rounds: 1,
    dryRounds: 1,
    reviewedAt: "1970-01-01T00:00:00.000Z",
  };
  const deterministicFindings = [
    ...recordFindings(options.plan, options.records),
    ...(await packageFindings(options)),
  ];
  const inputValidation = validateAuthoringReviewInput(
    reviewInput,
    options.plan,
    options.authoringInputHash,
  );
  for (const message of inputValidation) {
    deterministicFindings.push({
      severity: "critical",
      lens: "self-consistency",
      source: "deterministic",
      path: "reference/skill-review.md",
      problem: message,
      impact: "The review record cannot be trusted as bounded evidence.",
      fix: "Regenerate the review output with the declared AuthoringPlan contract.",
    });
  }
  return composeAuthoringReview({
    plan: options.plan,
    input: reviewInput,
    deterministicFindings,
    authoringInputHash: options.authoringInputHash,
    authoredMaterialHash: options.authoredMaterialHash,
    packageHash: options.packageHash,
  });
}
