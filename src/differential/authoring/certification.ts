import path from "node:path";
import {
  authoringLaneIds,
  authoringProtocolProjection,
} from "../../authoring/protocol.js";
import { sha256, stableValue } from "../../util.js";
import type {
  ArtifactInventory,
  DifferentialFixture,
  OfficialCommandRunner,
  ReadinessObservation,
} from "../types.js";
import type { DirectorySnapshot } from "../fixture.js";

export const AUTHORING_PARITY_DIMENSIONS = [
  "lane-dag",
  "lane-claims",
  "review-depth",
  "content-leaves",
  "deterministic-backbone",
  "output-envelope",
  "readiness",
] as const;

export type AuthoringParityDimension =
  (typeof AUTHORING_PARITY_DIMENSIONS)[number];

export type AuthoringDifferenceClassification =
  "expected-extension" | "semantic-mismatch" | "missing-functionality";

export type AuthoringExtensionCategory =
  "naming" | "namespace" | "storage" | "recovery" | "concurrency" | "hash";

export interface AuthoringDifference {
  dimension: AuthoringParityDimension;
  path: string;
  official: unknown;
  badger: unknown;
  classification: AuthoringDifferenceClassification;
  category?: AuthoringExtensionCategory;
  detail: string;
}

export interface AuthoringFieldGroup {
  required: readonly string[];
  optional: readonly string[];
}

export interface AuthoringOutputEnvelope {
  sourcePath: string;
  statuses: readonly string[];
  lane: AuthoringFieldGroup;
  artifact: AuthoringFieldGroup;
  finding: AuthoringFieldGroup;
  review: AuthoringFieldGroup;
}

export const OFFICIAL_AUTHORING_OUTPUT_ENVELOPE: AuthoringOutputEnvelope = {
  sourcePath: "domains/bundle/authoring.ts",
  statuses: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
  lane: {
    required: ["lane", "status"],
    optional: [
      "dispatchMode",
      "model",
      "artifacts",
      "claims",
      "findings",
      "review",
    ],
  },
  artifact: {
    required: ["path"],
    optional: ["kind", "content"],
  },
  finding: {
    required: ["severity", "problem"],
    optional: ["path", "fix"],
  },
  review: {
    required: ["passed", "evidenceSource", "findings", "reviewedAt"],
    optional: ["voters", "lenses", "rounds"],
  },
};

export const BADGER_AUTHORING_OUTPUT_ENVELOPE: AuthoringOutputEnvelope = {
  sourcePath: "src/authoring/types.ts",
  statuses: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
  lane: {
    required: ["lane", "status"],
    optional: [
      "dispatchMode",
      "model",
      "summary",
      "protocolHash",
      "authoringPlanHash",
      "workflowProtocolHash",
      "sourceEvidenceHash",
      "authoringInputHash",
      "expectedRevision",
      "artifacts",
      "claims",
      "findings",
      "review",
    ],
  },
  artifact: {
    required: ["path"],
    optional: [
      "kind",
      "id",
      "present",
      "content",
      "contentPath",
      "contentHash",
    ],
  },
  finding: {
    required: ["severity", "problem"],
    optional: ["path", "claim", "impact", "fix"],
  },
  review: {
    required: ["passed", "evidenceSource", "findings", "reviewedAt"],
    optional: [
      "voters",
      "lenses",
      "rounds",
      "dryRounds",
      "mode",
      "inputHash",
      "voterEvidence",
    ],
  },
};

export interface AuthoringProtocolLaneProjection {
  brief: string;
  claims: string[];
  contentLeaves: string[];
}

export interface AuthoringProtocolSnapshot {
  sourcePath: string;
  hash: string;
  schemaVersion: 1;
  dag: {
    wave1: string[];
    wave2: string[];
    barrier: string[];
  };
  depth: {
    quick: {
      voters: number;
      maxRounds: number;
      evidenceSource: string;
    };
    full: {
      voters: number;
      maxRounds: number;
      evidenceSource: string;
    };
    dryThreshold: number;
  };
  lanes: Record<string, AuthoringProtocolLaneProjection>;
  verify: {
    lenses: string[];
    loopUntilDry: boolean;
  };
  deterministicBackbone: string[];
  contentLeaves: string[];
}

export interface AuthoringProtocolComparison {
  laneDagEqual: boolean;
  claimsEqual: boolean;
  reviewDepthEqual: boolean;
  contentLeavesEqual: boolean;
  deterministicBackboneEqual: boolean;
  exactMatches: AuthoringParityDimension[];
  expectedExtensions: AuthoringDifference[];
  semanticMismatches: AuthoringDifference[];
}

export interface AuthoringEnvelopeComparison {
  equal: boolean;
  compatible: boolean;
  expectedExtensions: AuthoringDifference[];
  semanticMismatches: AuthoringDifference[];
}

export interface AuthoringIdentityEvidence {
  planHash: string | null;
  protocolHash: string | null;
  workflowProtocolHash: string | null;
  sourceEvidenceHash: string | null;
  authoringPlanHash: string | null;
  authoringInputHash: string | null;
  scaffoldHash: string | null;
  authoredMaterialHash: string | null;
  assembledPackageHash: string | null;
  authoringReviewHash: string | null;
  evaluationHash: string | null;
  packageHash: string | null;
  publicationApprovalHash: string | null;
}

export interface AuthoringLifecycleObservation {
  side: "official" | "badger";
  workflow: string;
  status: string;
  authoringStatus: string;
  lifecycleComplete: boolean;
  completedLanes: string[];
  laneStatuses: Record<string, string>;
  contentLeaves: string[];
  generatedArtifacts: ArtifactInventory;
  artifactOwners: Record<string, "auto" | "authored" | "source">;
  readiness: {
    state: string;
    authoring: ReadinessObservation;
    runtime: ReadinessObservation;
    publication: ReadinessObservation;
  };
  identities: AuthoringIdentityEvidence;
  evidencePaths: Record<string, string>;
  outputEnvelope: AuthoringOutputEnvelope;
}

export interface AuthoringReadinessObservation {
  state: string;
  authoring: ReadinessObservation;
  runtime: ReadinessObservation;
  publication: ReadinessObservation;
}

export interface AuthoringExtensionEvidence {
  id: string;
  category: AuthoringExtensionCategory;
  detail: string;
  sourcePaths: string[];
}

export const EXPECTED_BADGER_AUTHORING_EXTENSIONS: readonly AuthoringExtensionEvidence[] =
  [
    {
      id: "control-plane-naming",
      category: "naming",
      detail:
        "Badger keeps upstream plan, check, and hook roles while using badger-prefixed generated scripts.",
      sourcePaths: ["src/authoring/protocol.ts", "src/factory/generate.ts"],
    },
    {
      id: "authoring-state-namespace",
      category: "namespace",
      detail:
        "Badger stores authoring sessions below .badger/authoring and keeps them separate from WorkflowRuntime runs.",
      sourcePaths: ["src/authoring/lifecycle.ts", "src/types.ts"],
    },
    {
      id: "durable-lane-records",
      category: "storage",
      detail:
        "Badger persists one hash-bound record per authoring lane before assembly.",
      sourcePaths: ["src/authoring/lifecycle.ts", "src/authoring/types.ts"],
    },
    {
      id: "fresh-process-recovery",
      category: "recovery",
      detail:
        "Badger exposes fresh-process recovery paths and reconstructs authoring status from persisted records.",
      sourcePaths: ["src/authoring/lifecycle.ts"],
    },
    {
      id: "revision-fenced-records",
      category: "concurrency",
      detail:
        "Badger serializes authoring mutations and rejects stale expected revisions.",
      sourcePaths: ["src/authoring/lifecycle.ts", "src/authoring/types.ts"],
    },
    {
      id: "hash-bound-authoring-evidence",
      category: "hash",
      detail:
        "Badger binds authoring input, source evidence, authored material, package, review, and runtime identities.",
      sourcePaths: [
        "src/authoring/plan.ts",
        "src/authoring/lifecycle.ts",
        "src/publish/lifecycle.ts",
      ],
    },
  ];

export interface AuthoringDifferentialComparison extends AuthoringProtocolComparison {
  outputEnvelopeEqual: boolean;
  outputEnvelopeCompatible: boolean;
  generatedArtifactInventoryEqual: boolean;
  readinessEqual: boolean;
  lifecycleComplete: boolean;
  compatible: boolean;
  officialOnlyArtifacts: string[];
  badgerOnlyArtifacts: string[];
  expectedExtensions: AuthoringDifference[];
  semanticMismatches: AuthoringDifference[];
  missingFunctionality: AuthoringDifference[];
}

export interface AuthoringCertification {
  status: "certified" | "blocked";
  blockers: string[];
  warnings: string[];
}

export interface AuthoringCertificationEvidence {
  official: {
    verified: boolean;
    unchanged: boolean;
  };
  fixture: {
    unchanged: boolean;
  };
  comparison: Pick<
    AuthoringDifferentialComparison,
    "compatible" | "semanticMismatches" | "missingFunctionality"
  >;
  officialLifecycleComplete: boolean;
  badgerLifecycleComplete: boolean;
}

export interface AuthoringDifferentialReport {
  schemaVersion: 1;
  kind: "official-badger-authoring-differential";
  extractionManifest: unknown;
  fixture: {
    id: string;
    skills: string[];
    sourceBefore: DirectorySnapshot[];
    sourceAfter: DirectorySnapshot[];
    unchanged: boolean;
  };
  official: {
    root: string;
    revision: string;
    expectedRevision: string;
    verified: boolean;
    sourceBefore: AuthoringSourceFile[];
    sourceAfter: AuthoringSourceFile[];
    unchanged: boolean;
    protocol: AuthoringProtocolSnapshot;
    observation: AuthoringLifecycleObservation;
  };
  badger: {
    root: string;
    protocol: AuthoringProtocolSnapshot;
    observation: AuthoringLifecycleObservation;
    sourcePaths: string[];
  };
  extensions: readonly AuthoringExtensionEvidence[];
  comparison: AuthoringDifferentialComparison;
  certification: AuthoringCertification;
}

export interface AuthoringSourceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AuthoringDifferentialHarnessOptions {
  repositoryRoot: string;
  fixturePath: string;
  fixtureSkillsRoot?: string;
  officialRoot: string;
  officialCli?: string;
  officialRevision?: string;
  officialProtocolPath?: string;
  officialAuthoringSourcePath?: string;
  depth?: "quick" | "full";
  officialRunner?: OfficialCommandRunner;
}

const OFFICIAL_AUTHORING_BACKBONE = [
  "reference/workflow-protocol.json",
  "scripts/workflow-state.mjs",
  "scripts/workflow-guard.mjs",
  "scripts/workflow-handoff.mjs",
  "scripts/comet-plan.mjs",
  "scripts/comet-check.mjs",
  "scripts/comet-hook-guard.mjs",
  "bundle.yaml",
  "comet/skill.yaml",
  "comet/guardrails.yaml",
  "comet/checks.yaml",
  "comet/eval.yaml",
  "reference/resolved-skills.json",
  "reference/composition-report.md",
  "reference/authoring-lanes.json",
] as const;

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as RecordValue;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "";
}

function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    left.length === right.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function differenceMembers(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return left.filter((value) => !right.includes(value));
}

function protocolDifference(
  pathValue: string,
  official: unknown,
  badger: unknown,
  classification: AuthoringDifferenceClassification,
  detail: string,
  category?: AuthoringExtensionCategory,
): AuthoringDifference {
  return {
    dimension: pathValue.startsWith("merge.deterministicBackbone")
      ? "deterministic-backbone"
      : pathValue.startsWith("dag")
        ? "lane-dag"
        : pathValue.startsWith("lanes") && pathValue.endsWith("claims")
          ? "lane-claims"
          : pathValue.startsWith("depth") || pathValue.startsWith("verify")
            ? "review-depth"
            : "content-leaves",
    path: pathValue,
    official,
    badger,
    classification,
    ...(category ? { category } : {}),
    detail,
  };
}

function canonicalDepth(value: unknown, label: string) {
  const depth = record(value, label);
  return {
    voters: numberValue(depth.voters, `${label}.voters`),
    maxRounds: numberValue(depth.maxRounds, `${label}.maxRounds`),
    evidenceSource: stringValue(
      depth.evidenceSource,
      `${label}.evidenceSource`,
    ),
  };
}

export function canonicalizeAuthoringProtocol(
  value: unknown,
  sourcePath: string,
): AuthoringProtocolSnapshot {
  const protocol = record(value, "authoring protocol");
  if (protocol.schemaVersion !== 1) {
    throw new Error("authoring protocol schemaVersion must be 1");
  }
  const dagValue = record(protocol.dag, "authoring protocol dag");
  const depthValue = record(protocol.depth, "authoring protocol depth");
  const verifyValue = record(protocol.verify, "authoring protocol verify");
  const mergeValue = record(protocol.merge, "authoring protocol merge");
  const lanesValue = record(protocol.lanes, "authoring protocol lanes");
  if (typeof verifyValue.loopUntilDry !== "boolean") {
    throw new Error("authoring protocol verify.loopUntilDry must be boolean");
  }
  const dag = {
    wave1: stringArray(dagValue.wave1, "authoring protocol dag.wave1"),
    wave2: stringArray(dagValue.wave2, "authoring protocol dag.wave2"),
    barrier: stringArray(dagValue.barrier, "authoring protocol dag.barrier"),
  };
  const depth = {
    quick: canonicalDepth(depthValue.quick, "authoring protocol depth.quick"),
    full: canonicalDepth(depthValue.full, "authoring protocol depth.full"),
    dryThreshold: numberValue(
      depthValue.dryThreshold,
      "authoring protocol depth.dryThreshold",
    ),
  };
  const lanes: Record<string, AuthoringProtocolLaneProjection> = {};
  for (const laneId of authoringLaneIds()) {
    const lane = record(
      lanesValue[laneId],
      `authoring protocol lane ${laneId}`,
    );
    const rawContentLeaves = lane.producesContentLeaves;
    const contentLeaves = Array.isArray(rawContentLeaves)
      ? stringArray(
          rawContentLeaves,
          `authoring protocol lane ${laneId}.producesContentLeaves`,
        )
      : rawContentLeaves === true
        ? ["<content-leaves>"]
        : rawContentLeaves === false
          ? []
          : (() => {
              throw new Error(
                `authoring protocol lane ${laneId}.producesContentLeaves must be an array or boolean`,
              );
            })();
    lanes[laneId] = {
      brief: stringValue(lane.brief, `authoring protocol lane ${laneId}.brief`),
      claims: stringArray(
        lane.claims,
        `authoring protocol lane ${laneId}.claims`,
      ),
      contentLeaves,
    };
  }
  const snapshotWithoutHash = {
    schemaVersion: 1 as const,
    dag,
    depth,
    lanes,
    verify: {
      lenses: stringArray(
        verifyValue.lenses,
        "authoring protocol verify.lenses",
      ),
      loopUntilDry: verifyValue.loopUntilDry,
    },
    deterministicBackbone: stringArray(
      mergeValue.deterministicBackbone,
      "authoring protocol merge.deterministicBackbone",
    ),
    contentLeaves: stringArray(
      mergeValue.contentLeaves,
      "authoring protocol merge.contentLeaves",
    ),
  };
  return {
    ...snapshotWithoutHash,
    sourcePath: path.resolve(sourcePath),
    hash: sha256(stableJson(snapshotWithoutHash)),
  };
}

export function compareAuthoringProtocols(
  official: AuthoringProtocolSnapshot,
  badger: AuthoringProtocolSnapshot,
): AuthoringProtocolComparison {
  const expectedExtensions: AuthoringDifference[] = [];
  const semanticMismatches: AuthoringDifference[] = [];
  const exactMatches: AuthoringParityDimension[] = [];
  const laneDagEqual = stableJson(official.dag) === stableJson(badger.dag);
  const claimsEqual =
    stableJson(
      Object.fromEntries(
        authoringLaneIds().map((lane) => [lane, official.lanes[lane].claims]),
      ),
    ) ===
    stableJson(
      Object.fromEntries(
        authoringLaneIds().map((lane) => [lane, badger.lanes[lane].claims]),
      ),
    );
  const reviewDepthEqual =
    stableJson({ depth: official.depth, verify: official.verify }) ===
    stableJson({ depth: badger.depth, verify: badger.verify });
  const contentLeavesEqual =
    stableJson({
      lanes: Object.fromEntries(
        authoringLaneIds().map((lane) => [
          lane,
          official.lanes[lane].contentLeaves,
        ]),
      ),
      merge: official.contentLeaves,
    }) ===
    stableJson({
      lanes: Object.fromEntries(
        authoringLaneIds().map((lane) => [
          lane,
          badger.lanes[lane].contentLeaves,
        ]),
      ),
      merge: badger.contentLeaves,
    });
  const deterministicBackboneEqual =
    sameMembers(official.deterministicBackbone, badger.deterministicBackbone) &&
    stableJson(official.deterministicBackbone) ===
      stableJson(badger.deterministicBackbone);
  if (laneDagEqual) exactMatches.push("lane-dag");
  else {
    semanticMismatches.push(
      protocolDifference(
        "dag",
        official.dag,
        badger.dag,
        "semantic-mismatch",
        "Authoring lane scheduling differs from the pinned upstream DAG.",
      ),
    );
  }
  if (claimsEqual) exactMatches.push("lane-claims");
  else {
    semanticMismatches.push(
      protocolDifference(
        "lanes.claims",
        official.lanes,
        badger.lanes,
        "semantic-mismatch",
        "Authoring lane claims differ from the pinned upstream claims.",
      ),
    );
  }
  if (reviewDepthEqual) exactMatches.push("review-depth");
  else {
    semanticMismatches.push(
      protocolDifference(
        "depth",
        { depth: official.depth, verify: official.verify },
        { depth: badger.depth, verify: badger.verify },
        "semantic-mismatch",
        "Authoring review depth or lenses differ from the pinned upstream contract.",
      ),
    );
  }
  if (contentLeavesEqual) exactMatches.push("content-leaves");
  else {
    semanticMismatches.push(
      protocolDifference(
        "lanes.producesContentLeaves",
        official.contentLeaves,
        badger.contentLeaves,
        "semantic-mismatch",
        "Authored content-leaf obligations differ from the pinned upstream contract.",
      ),
    );
  }
  if (deterministicBackboneEqual) exactMatches.push("deterministic-backbone");
  else if (
    sameMembers(official.deterministicBackbone, OFFICIAL_AUTHORING_BACKBONE) &&
    sameMembers(
      badger.deterministicBackbone,
      authoringProtocolProjection().deterministicBackbone,
    )
  ) {
    expectedExtensions.push(
      protocolDifference(
        "merge.deterministicBackbone",
        official.deterministicBackbone,
        badger.deterministicBackbone,
        "expected-extension",
        "Badger uses its documented package namespace and adds hash-bound generated evidence.",
        "namespace",
      ),
    );
  } else {
    semanticMismatches.push(
      protocolDifference(
        "merge.deterministicBackbone",
        official.deterministicBackbone,
        badger.deterministicBackbone,
        "semantic-mismatch",
        "Deterministic authoring backbone differs outside the documented Badger layout extension.",
      ),
    );
  }
  return {
    laneDagEqual,
    claimsEqual,
    reviewDepthEqual,
    contentLeavesEqual,
    deterministicBackboneEqual,
    exactMatches,
    expectedExtensions,
    semanticMismatches,
  };
}

function envelopeDifference(
  pathValue: string,
  official: unknown,
  badger: unknown,
  classification: AuthoringDifferenceClassification,
  detail: string,
): AuthoringDifference {
  const category: AuthoringExtensionCategory | undefined =
    /hash|revision|evidence/iu.test(pathValue)
      ? "hash"
      : /contentPath|contentHash/iu.test(pathValue)
        ? "storage"
        : undefined;
  return {
    dimension: "output-envelope",
    path: pathValue,
    official,
    badger,
    classification,
    ...(category ? { category } : {}),
    detail,
  };
}

export function compareAuthoringOutputEnvelopes(
  official: AuthoringOutputEnvelope,
  badger: AuthoringOutputEnvelope,
): AuthoringEnvelopeComparison {
  const expectedExtensions: AuthoringDifference[] = [];
  const semanticMismatches: AuthoringDifference[] = [];
  const groups: Array<
    keyof Pick<
      AuthoringOutputEnvelope,
      "lane" | "artifact" | "finding" | "review"
    >
  > = ["lane", "artifact", "finding", "review"];
  if (stableJson(official.statuses) !== stableJson(badger.statuses)) {
    semanticMismatches.push(
      envelopeDifference(
        "statuses",
        official.statuses,
        badger.statuses,
        "semantic-mismatch",
        "Lane status values differ from the pinned upstream envelope.",
      ),
    );
  }
  for (const groupName of groups) {
    const officialGroup = official[groupName];
    const badgerGroup = badger[groupName];
    for (const field of officialGroup.required) {
      if (!badgerGroup.required.includes(field)) {
        semanticMismatches.push(
          envelopeDifference(
            `${groupName}.required.${field}`,
            officialGroup.required,
            badgerGroup.required,
            "missing-functionality",
            `Badger output envelope does not require upstream field ${field}.`,
          ),
        );
      }
    }
    for (const field of officialGroup.optional) {
      if (
        !badgerGroup.required.includes(field) &&
        !badgerGroup.optional.includes(field)
      ) {
        semanticMismatches.push(
          envelopeDifference(
            `${groupName}.optional.${field}`,
            officialGroup.optional,
            badgerGroup.optional,
            "missing-functionality",
            `Badger output envelope omits upstream field ${field}.`,
          ),
        );
      }
    }
    for (const field of badgerGroup.required) {
      if (
        !officialGroup.required.includes(field) &&
        !officialGroup.optional.includes(field)
      ) {
        expectedExtensions.push(
          envelopeDifference(
            `${groupName}.required.${field}`,
            officialGroup.required,
            badgerGroup.required,
            "expected-extension",
            `Badger adds the required output field ${field}.`,
          ),
        );
      }
    }
    for (const field of badgerGroup.optional) {
      if (
        !officialGroup.required.includes(field) &&
        !officialGroup.optional.includes(field)
      ) {
        expectedExtensions.push(
          envelopeDifference(
            `${groupName}.optional.${field}`,
            officialGroup.optional,
            badgerGroup.optional,
            "expected-extension",
            `Badger adds the optional output field ${field}.`,
          ),
        );
      }
    }
  }
  const equal =
    stableJson({
      statuses: official.statuses,
      lane: official.lane,
      artifact: official.artifact,
      finding: official.finding,
      review: official.review,
    }) ===
    stableJson({
      statuses: badger.statuses,
      lane: badger.lane,
      artifact: badger.artifact,
      finding: badger.finding,
      review: badger.review,
    });
  return {
    equal,
    compatible: semanticMismatches.length === 0,
    expectedExtensions,
    semanticMismatches,
  };
}

function artifactSignature(inventory: ArtifactInventory): string {
  return stableJson(
    inventory.files.map(({ path: filePath, bytes, sha256: hash }) => ({
      path: filePath,
      bytes,
      sha256: hash,
    })),
  );
}

function readinessSignature(
  observation: AuthoringLifecycleObservation,
): string {
  return stableJson({
    state: observation.readiness.state,
    lifecycleComplete: observation.lifecycleComplete,
    authoring: {
      state: observation.readiness.authoring.state,
      hasBlockers: observation.readiness.authoring.blockers.length > 0,
    },
    runtime: {
      state: observation.readiness.runtime.state,
      hasBlockers: observation.readiness.runtime.blockers.length > 0,
    },
    publication: {
      state: observation.readiness.publication.state,
      hasBlockers: observation.readiness.publication.blockers.length > 0,
    },
  });
}

function contentLeavesPresent(
  observation: AuthoringLifecycleObservation,
): boolean {
  const paths = new Set(
    observation.generatedArtifacts.files.map((file) => file.path),
  );
  return observation.contentLeaves.every((contentPath) =>
    paths.has(
      contentPath.startsWith("../") ? contentPath.slice(3) : contentPath,
    ),
  );
}

function artifactDifferenceIsExpected(
  official: AuthoringLifecycleObservation,
  badger: AuthoringLifecycleObservation,
): boolean {
  return (
    official.lifecycleComplete &&
    badger.lifecycleComplete &&
    sameMembers(official.contentLeaves, badger.contentLeaves) &&
    contentLeavesPresent(official) &&
    contentLeavesPresent(badger)
  );
}

export function compareAuthoringObservations(
  official: AuthoringLifecycleObservation,
  badger: AuthoringLifecycleObservation,
  protocols: AuthoringProtocolComparison,
): AuthoringDifferentialComparison {
  const output = compareAuthoringOutputEnvelopes(
    official.outputEnvelope,
    badger.outputEnvelope,
  );
  const officialPaths = official.generatedArtifacts.files.map(
    (file) => file.path,
  );
  const badgerPaths = badger.generatedArtifacts.files.map((file) => file.path);
  const officialOnlyArtifacts = differenceMembers(
    officialPaths,
    badgerPaths,
  ).sort();
  const badgerOnlyArtifacts = differenceMembers(
    badgerPaths,
    officialPaths,
  ).sort();
  const generatedArtifactInventoryEqual =
    artifactSignature(official.generatedArtifacts) ===
    artifactSignature(badger.generatedArtifacts);
  const expectedExtensions = [
    ...protocols.expectedExtensions,
    ...output.expectedExtensions,
  ];
  const semanticMismatches = [
    ...protocols.semanticMismatches,
    ...output.semanticMismatches,
  ];
  const missingFunctionality: AuthoringDifference[] = [];
  const observedContentLeavesEqual = sameMembers(
    official.contentLeaves,
    badger.contentLeaves,
  );
  const contentLeavesEqual =
    protocols.contentLeavesEqual && observedContentLeavesEqual;
  const exactMatches = observedContentLeavesEqual
    ? protocols.exactMatches
    : protocols.exactMatches.filter(
        (dimension) => dimension !== "content-leaves",
      );
  if (!observedContentLeavesEqual) {
    missingFunctionality.push({
      dimension: "content-leaves",
      path: "lifecycle.contentLeaves",
      official: official.contentLeaves,
      badger: badger.contentLeaves,
      classification: "missing-functionality",
      detail:
        "Synthetic authoring observations produced different content-leaf obligations.",
    });
  }
  if (!generatedArtifactInventoryEqual) {
    const difference = {
      official: official.generatedArtifacts,
      badger: badger.generatedArtifacts,
    };
    if (artifactDifferenceIsExpected(official, badger)) {
      expectedExtensions.push({
        dimension: "readiness",
        path: "generatedArtifacts",
        ...difference,
        classification: "expected-extension",
        category: "namespace",
        detail:
          "Generated package inventories differ in implementation-owned paths or hashes while authored leaves remain complete.",
      });
    } else {
      semanticMismatches.push({
        dimension: "readiness",
        path: "generatedArtifacts",
        ...difference,
        classification: "semantic-mismatch",
        detail:
          "Generated package inventory differs before a complete authored lifecycle is established.",
      });
    }
  }
  const readinessEqual =
    readinessSignature(official) === readinessSignature(badger);
  if (!readinessEqual) {
    semanticMismatches.push({
      dimension: "readiness",
      path: "readiness",
      official: official.readiness,
      badger: badger.readiness,
      classification: "semantic-mismatch",
      detail:
        "Authoring, runtime, or publication readiness differs between the two observations.",
    });
  }
  if (!official.lifecycleComplete) {
    missingFunctionality.push({
      dimension: "readiness",
      path: "official.lifecycle",
      official: official.status,
      badger: badger.status,
      classification: "missing-functionality",
      detail:
        "The official fixture did not complete the six-lane authoring lifecycle.",
    });
  }
  if (!badger.lifecycleComplete) {
    missingFunctionality.push({
      dimension: "readiness",
      path: "badger.lifecycle",
      official: official.status,
      badger: badger.status,
      classification: "missing-functionality",
      detail: "Badger did not complete the six-lane authoring lifecycle.",
    });
  }
  const lifecycleComplete =
    official.lifecycleComplete && badger.lifecycleComplete;
  const compatible =
    lifecycleComplete &&
    readinessEqual &&
    output.compatible &&
    semanticMismatches.length === 0 &&
    missingFunctionality.length === 0;
  return {
    ...protocols,
    contentLeavesEqual,
    exactMatches,
    outputEnvelopeEqual: output.equal,
    outputEnvelopeCompatible: output.compatible,
    generatedArtifactInventoryEqual,
    readinessEqual,
    lifecycleComplete,
    compatible,
    officialOnlyArtifacts,
    badgerOnlyArtifacts,
    expectedExtensions,
    semanticMismatches,
    missingFunctionality,
  };
}

export function certifyAuthoringDifferential(
  evidence: AuthoringCertificationEvidence,
): AuthoringCertification {
  const blockers: string[] = [];
  if (!evidence.official.verified) {
    blockers.push("Official authoring baseline revision was not verified");
  }
  if (!evidence.official.unchanged) {
    blockers.push(
      "Official authoring baseline source changed during certification",
    );
  }
  if (!evidence.fixture.unchanged) {
    blockers.push("Authoring fixture source changed during certification");
  }
  if (!evidence.officialLifecycleComplete) {
    blockers.push(
      "Official authoring fixture did not reach assembly readiness",
    );
  }
  if (!evidence.badgerLifecycleComplete) {
    blockers.push("Badger authoring fixture did not reach assembly readiness");
  }
  if (evidence.comparison.semanticMismatches.length > 0) {
    blockers.push(
      `Authoring semantic mismatches: ${evidence.comparison.semanticMismatches.length}`,
    );
  }
  if (evidence.comparison.missingFunctionality.length > 0) {
    blockers.push(
      `Authoring missing functionality: ${evidence.comparison.missingFunctionality.length}`,
    );
  }
  if (!evidence.comparison.compatible) {
    blockers.push("Authoring differential evidence is not compatible");
  }
  return {
    status: blockers.length === 0 ? "certified" : "blocked",
    blockers,
    warnings: [],
  };
}
