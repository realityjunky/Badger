import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewState } from "../../publish/lifecycle.js";
import { buildProposal } from "../../factory/proposal.js";
import { generatePackage } from "../../factory/generate.js";
import { initializeState, readState, writeState } from "../../factory/state.js";
import {
  assemblePackage,
  authoringReadiness,
  initializeAuthoringSession,
  runManualAuthoringFixture,
} from "../../authoring/index.js";
import { deriveAuthoringPlan } from "../../authoring/plan.js";
import { BADGER_AUTHORING_OUTPUT_ENVELOPE } from "./certification.js";
import {
  authoringContentLeaves,
  authoringLaneContentLeaves,
  authoringLaneIds,
} from "../../authoring/protocol.js";
import {
  canonicalizeAuthoringProtocol,
  certifyAuthoringDifferential,
  compareAuthoringObservations,
  compareAuthoringProtocols,
  EXPECTED_BADGER_AUTHORING_EXTENSIONS,
  OFFICIAL_AUTHORING_OUTPUT_ENVELOPE,
  type AuthoringCertification,
  type AuthoringDifferentialHarnessOptions,
  type AuthoringDifferentialReport,
  type AuthoringIdentityEvidence,
  type AuthoringLifecycleObservation,
  type AuthoringProtocolSnapshot,
  type AuthoringReadinessObservation,
  type AuthoringSourceFile,
} from "./certification.js";
import {
  assertFixtureSourcePath,
  copyFixtureSkill,
  fixturePlanForOfficial,
  fixturePlanForStandalone,
  fixtureSkillPath,
  readFixture,
  snapshotDirectory,
  snapshotsEqual,
  type DirectorySnapshot,
} from "../fixture.js";
import { inventoryDirectory } from "../observe.js";
import { canonicalizeReadiness } from "../observe.js";
import {
  createOfficialCommandRunner,
  readOfficialRevision,
} from "../official.js";
import { readExtractionManifest } from "../run.js";
import type {
  ArtifactInventory,
  DifferentialFixture,
  OfficialCommandRunner,
  ReadinessObservation,
} from "../types.js";
import { hashDirectory, isWithin, sha256 } from "../../util.js";
import type { AuthoringLaneId } from "../../authoring/types.js";

const DEFAULT_OFFICIAL_PROTOCOL_PATH =
  "assets/skills/comet-any/reference/authoring-protocol.json";
const DEFAULT_OFFICIAL_AUTHORING_SOURCE_PATH = "domains/bundle/authoring.ts";
const BADGER_PROTOCOL_PATH =
  "assets/skills/badger-create/reference/authoring-protocol.json";
const BADGER_SOURCE_PATHS = [
  "assets/skills/badger-create/SKILL.md",
  "assets/skills/badger-create/reference/authoring-protocol.json",
  "assets/skills/badger-create/reference/authoring-subagents.md",
  "assets/skills/badger-create/reference/bundle-authoring.md",
  "assets/skills/badger-create/reference/authored-zone-example.md",
  "assets/skills/badger-create/reference/eval-provider.md",
  "assets/skills/badger-create/reference/package-inventory.example.json",
  "src/authoring/protocol.ts",
  "src/authoring/types.ts",
  "src/authoring/plan.ts",
  "src/authoring/dispatch.ts",
  "src/authoring/lifecycle.ts",
  "src/publish/lifecycle.ts",
  "src/eval/run.ts",
];
const OFFICIAL_SOURCE_PATHS = [
  "assets/skills/comet-any/SKILL.md",
  DEFAULT_OFFICIAL_PROTOCOL_PATH,
  DEFAULT_OFFICIAL_AUTHORING_SOURCE_PATH,
  "assets/skills/comet-any/reference/bundle-authoring.md",
  "assets/skills/comet-any/reference/authoring-subagents.md",
  "assets/skills/comet-any/reference/authored-zone-example.md",
  "assets/skills/comet-any/reference/eval-provider.md",
  "assets/skills/comet-any/reference/subagents/script-author.md",
  "assets/skills/comet-any/reference/subagents/reference-author.md",
  "assets/skills/comet-any/reference/subagents/pause-points-author.md",
  "assets/skills/comet-any/reference/subagents/workflow-entry-author.md",
  "assets/skills/comet-any/reference/subagents/skill-core-author.md",
  "assets/skills/comet-any/reference/subagents/skill-reviewer.md",
];

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as RecordValue;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectPath(projectRoot: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(projectRoot, value.replace(/^\.\//u, ""));
}

function objectValue(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function generatedArtifactRoot(
  projectRoot: string,
  generated: RecordValue,
  fallback: string,
): string {
  const directRoot = projectPath(projectRoot, generated.draftPath);
  if (directRoot) return directRoot;
  const factory = objectValue(generated.factory);
  const generatedPackage = objectValue(factory?.generatedSkillPackage);
  return projectPath(projectRoot, generatedPackage?.packageRoot) ?? fallback;
}

function commandArgs(command: string[], projectRoot: string): string[] {
  return [...command, "--project", projectRoot, "--json"];
}

async function prepareFixtureProject(
  repositoryRoot: string,
  fixturePath: string,
  fixtureSkillsRoot: string,
  fixture: DifferentialFixture,
  projectRoot: string,
): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agents", "skills"), {
    recursive: true,
  });
  for (const skill of fixture.skills) {
    await copyFixtureSkill(
      repositoryRoot,
      fixtureSkillPath(fixturePath, skill),
      path.join(projectRoot, ".agents", "skills", skill.name),
      fixtureSkillsRoot,
    );
  }
}

async function sourceFileSnapshot(
  root: string,
  relativePath: string,
): Promise<AuthoringSourceFile> {
  const file = path.resolve(root, relativePath);
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Authoring source must be a regular file: ${file}`);
  }
  const content = await fs.readFile(file);
  return {
    path: file,
    bytes: content.byteLength,
    sha256: sha256(content),
  };
}

async function sourceFileSnapshots(
  root: string,
  relativePaths: readonly string[],
): Promise<AuthoringSourceFile[]> {
  return Promise.all(
    relativePaths.map((relativePath) => sourceFileSnapshot(root, relativePath)),
  );
}

function sourceSnapshotsEqual(
  before: readonly AuthoringSourceFile[],
  after: readonly AuthoringSourceFile[],
): boolean {
  return (
    before.length === after.length &&
    before.every(
      (source, index) =>
        source.path === after[index]?.path &&
        source.bytes === after[index]?.bytes &&
        source.sha256 === after[index]?.sha256,
    )
  );
}

function contentLeavesForFixture(fixture: DifferentialFixture): string[] {
  const workflow = fixture.plan.workflow;
  const activeNodeIds = workflow.customNodes
    .filter((node) => !node.disabled)
    .map((node) => node.id);
  return [
    ...authoringContentLeaves({
      activeNodeIds,
      workflowName: workflow.name,
    }),
  ];
}

function artifactOwnerMap(
  artifacts: ArtifactInventory,
  contentLeaves: readonly string[],
): Record<string, "auto" | "authored" | "source"> {
  const authoredPaths = new Set(
    contentLeaves.map((contentPath) =>
      contentPath.startsWith("../") ? contentPath.slice(3) : contentPath,
    ),
  );
  return Object.fromEntries(
    artifacts.files.map((file) => [
      file.path,
      authoredPaths.has(file.path) ? "authored" : "auto",
    ]),
  );
}

function authoringLaneLeaves(
  fixture: DifferentialFixture,
  lane: string,
): string[] {
  const workflow = fixture.plan.workflow;
  const activeNodeIds = workflow.customNodes
    .filter((node) => !node.disabled)
    .map((node) => node.id);
  return [
    ...authoringLaneContentLeaves(lane as AuthoringLaneId, {
      activeNodeIds,
      workflowName: workflow.name,
    }),
  ];
}

function fixtureContent(pathValue: string, workflowName: string): string {
  if (pathValue === "SKILL.md") {
    return [
      "## Decision Core",
      "",
      "Read persisted WorkflowRuntime state before selecting the current Node.",
      "Follow only declared transitions and pause only for declared user choices.",
      "On resume, re-read state and evidence instead of relying on conversation history.",
      "",
      `The synthetic workflow is ${workflowName} and its route remains protocol-owned.`,
    ].join("\n");
  }
  if (pathValue.endsWith("/SKILL.md")) {
    return [
      "## Guidance",
      "",
      "Read the current Node responsibility and prerequisites before acting.",
      "Use the declared implementation, record bounded evidence, and verify completion before advancing.",
      "If required evidence is missing, stop with the declared recovery path.",
    ].join("\n");
  }
  if (pathValue.endsWith("decision-points.md")) {
    return [
      "# Decision Points",
      "",
      "Pause only for a genuine declared user choice.",
      "Handle deterministic repairs automatically and report bounded stop conditions.",
    ].join("\n");
  }
  if (pathValue.endsWith("recovery.md")) {
    return [
      "# Recovery",
      "",
      "Read persisted authoring and WorkflowRuntime state in a fresh process.",
      "Reject stale identities and preserve the last valid evidence before re-authoring.",
    ].join("\n");
  }
  return [
    "# Skill Review",
    "",
    "The six lanes and declared WorkflowProtocol remain aligned.",
    "No blocking findings remain in this synthetic review.",
  ].join("\n");
}

function fallbackReadiness(
  state: string,
  blockers: string[],
  warnings: string[] = [],
): ReadinessObservation {
  return { state, blockers, warnings, evidence: {} };
}

function readinessSection(
  value: unknown,
  fallback: ReadinessObservation,
): ReadinessObservation {
  if (value === undefined) return fallback;
  try {
    return canonicalizeReadiness(value);
  } catch {
    return fallback;
  }
}

function officialReadiness(
  value: unknown,
  authoringFallback: ReadinessObservation,
): AuthoringReadinessObservation {
  const document = record(value, "official readiness result");
  const root = objectValue(document.readiness) ?? document;
  const publication = readinessSection(
    root.publication ?? document.readiness ?? document,
    fallbackReadiness("blocked", [
      "Official publication readiness unavailable",
    ]),
  );
  const authoring = readinessSection(root.authoring, authoringFallback);
  const runtime = readinessSection(
    root.runtime,
    fallbackReadiness(
      publication.blockers.length === 0 ? "ready" : "blocked",
      publication.blockers,
      publication.warnings,
    ),
  );
  const state =
    typeof root.state === "string"
      ? root.state
      : publication.blockers.length === 0
        ? "ready"
        : "blocked";
  return { state, authoring, runtime, publication };
}

function localReadiness(
  state: Awaited<ReturnType<typeof reviewState>>,
): AuthoringReadinessObservation {
  return {
    state: state.state,
    authoring: canonicalizeReadiness(state.authoring),
    runtime: canonicalizeReadiness(state.runtime),
    publication: canonicalizeReadiness(state.publication),
  };
}

function identitiesFromLocal(
  state: Awaited<ReturnType<typeof readState>>,
  packageHash: string,
): AuthoringIdentityEvidence {
  const authoring = state.authoring;
  return {
    planHash: state.planHash,
    protocolHash: authoring?.protocolHash ?? null,
    workflowProtocolHash: authoring?.workflowProtocolHash ?? null,
    sourceEvidenceHash: authoring?.sourceEvidenceHash ?? null,
    authoringPlanHash: authoring?.authoringPlanHash ?? null,
    authoringInputHash: authoring?.authoringInputHash ?? null,
    scaffoldHash: authoring?.scaffoldHash ?? null,
    authoredMaterialHash: authoring?.authoredMaterialHash ?? null,
    assembledPackageHash: authoring?.assembledPackageHash ?? null,
    authoringReviewHash: authoring?.review?.reviewHash ?? null,
    evaluationHash: state.eval?.hash ?? null,
    packageHash,
    publicationApprovalHash:
      state.review?.approvalHash ?? state.review?.hash ?? null,
  };
}

function localLaneStatuses(
  readiness: Awaited<ReturnType<typeof authoringReadiness>>,
): Record<string, string> {
  return Object.fromEntries(
    authoringLaneIds().map((lane) => [
      lane,
      readiness.records[lane]?.status ?? readiness.lanes[lane].status,
    ]),
  );
}

export async function observeStandaloneAuthoring(options: {
  fixture: DifferentialFixture;
  fixturePath: string;
  fixtureSkillsRoot: string;
  repositoryRoot: string;
  projectRoot: string;
  homeDir: string;
  outputRoot: string;
  depth: "quick" | "full";
}): Promise<AuthoringLifecycleObservation> {
  const planPath = path.join(
    options.projectRoot,
    "authoring-differential-plan.json",
  );
  const plan = fixturePlanForStandalone(options.fixture);
  await fs.mkdir(options.projectRoot, { recursive: true });
  await prepareFixtureProject(
    options.repositoryRoot,
    options.fixturePath,
    options.fixtureSkillsRoot,
    options.fixture,
    options.projectRoot,
  );
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
  const proposal = await buildProposal({
    projectRoot: options.projectRoot,
    planPath,
  });
  const fallbackInventoryRoot = path.join(
    options.projectRoot,
    ".badger",
    "drafts",
    plan.workflow.name,
  );
  if (!proposal.canInitialize) {
    const generatedArtifacts = await inventoryDirectory(
      fallbackInventoryRoot,
      true,
    );
    const readiness = fallbackReadiness(
      "blocked",
      proposal.blockers,
      proposal.warnings,
    );
    return {
      side: "badger",
      workflow: plan.workflow.name,
      status: "blocked",
      authoringStatus: "pending",
      lifecycleComplete: false,
      completedLanes: [],
      laneStatuses: Object.fromEntries(
        authoringLaneIds().map((lane) => [lane, "PENDING"]),
      ),
      contentLeaves: contentLeavesForFixture(options.fixture),
      generatedArtifacts,
      artifactOwners: {},
      readiness: {
        state: "blocked",
        authoring: readiness,
        runtime: readiness,
        publication: readiness,
      },
      identities: {
        planHash: null,
        protocolHash: null,
        workflowProtocolHash: null,
        sourceEvidenceHash: null,
        authoringPlanHash: null,
        authoringInputHash: null,
        scaffoldHash: null,
        authoredMaterialHash: null,
        assembledPackageHash: null,
        authoringReviewHash: null,
        evaluationHash: null,
        packageHash: null,
        publicationApprovalHash: null,
      },
      evidencePaths: { workflowPlan: planPath },
      outputEnvelope: BADGER_AUTHORING_OUTPUT_ENVELOPE,
    };
  }
  let state = await initializeState({
    projectRoot: options.projectRoot,
    planPath,
    plan,
    proposal,
    confirmed: true,
  });
  const generated = await generatePackage({
    proposal,
    plan,
    destination: state.draftPath,
    authoringDepth: options.depth,
  });
  state.generated = generated;
  state.status = "generated";
  await writeState(state);
  const authoringPlan = deriveAuthoringPlan({ proposal, depth: options.depth });
  await initializeAuthoringSession({
    state,
    plan: authoringPlan,
    generated,
  });
  const completed = await runManualAuthoringFixture({
    state,
    outputRoot: options.outputRoot,
  });
  const assembled = await assemblePackage(completed, true);
  const readinessAfterAssembly = await authoringReadiness(assembled);
  const composite = reviewState(assembled);
  const packageRoot = assembled.generated!.packageRoot;
  const packageHash = await hashDirectory(packageRoot);
  const authoringInput = assembled.authoring!;
  const identities = identitiesFromLocal(assembled, packageHash);
  const contentLeaves = contentLeavesForFixture(options.fixture);
  const laneStatuses = localLaneStatuses(readinessAfterAssembly);
  const lifecycleComplete =
    readinessAfterAssembly.state === "ready" &&
    readinessAfterAssembly.status === "assembled" &&
    authoringLaneIds().every(
      (lane) => readinessAfterAssembly.records[lane]?.status === "DONE",
    );
  return {
    side: "badger",
    workflow: assembled.name,
    status: assembled.status,
    authoringStatus: authoringInput.status,
    lifecycleComplete,
    completedLanes: [...readinessAfterAssembly.completedLanes],
    laneStatuses,
    contentLeaves,
    generatedArtifacts: await inventoryDirectory(packageRoot),
    artifactOwners: Object.fromEntries(
      (assembled.generated?.inventory ?? []).map((file) => [
        file.path,
        file.owner,
      ]),
    ),
    readiness: localReadiness(composite),
    identities,
    evidencePaths: {
      workflowPlan: assembled.planPath,
      authoringPlan: authoringInput.planPath,
      authoringSession: authoringInput.sessionPath,
      authoringRecords: authoringInput.recordsPath,
      package: packageRoot,
      evaluation: assembled.generated!.evalPath,
      outputRoot: options.outputRoot,
    },
    outputEnvelope: BADGER_AUTHORING_OUTPUT_ENVELOPE,
  };
}

function officialLaneClaims(value: unknown, lane: string): string[] {
  const plan = objectValue(value);
  const lanes = objectValue(plan?.lanes);
  const definition = objectValue(lanes?.[lane]);
  return Array.isArray(definition?.claims)
    ? definition.claims.filter(
        (claim): claim is string => typeof claim === "string",
      )
    : [];
}

function officialLaneOutput(
  fixture: DifferentialFixture,
  lane: string,
  plan: unknown,
): RecordValue {
  const artifacts = authoringLaneLeaves(fixture, lane).map((pathValue) => ({
    path: pathValue,
    kind: "markdown",
    content: fixtureContent(pathValue, fixture.plan.workflow.name),
  }));
  const output: RecordValue = {
    lane,
    status: "DONE",
    dispatchMode: "manual-file",
    claims: officialLaneClaims(plan, lane).map((id) => ({
      id,
      summary: `Synthetic fixture supports ${id}.`,
    })),
    artifacts,
    findings: [],
  };
  if (lane === "skill-review") {
    output.review = {
      passed: true,
      evidenceSource: "deterministic-check-only",
      voters: 0,
      lenses: [
        "contract-fit",
        "usability",
        "evidence-trace",
        "self-consistency",
      ],
      rounds: 1,
      findings: [],
      reviewedAt: "1970-01-01T00:00:00.000Z",
    };
  }
  return output;
}

async function invokeOfficial(
  runner: OfficialCommandRunner,
  command: string[],
  projectRoot: string,
  homeDir: string,
): Promise<unknown> {
  return runner.run(commandArgs(command, projectRoot), {
    cwd: projectRoot,
    homeDir,
  });
}

async function packageContainsText(
  root: string,
  needle: string,
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && (await packageContainsText(target, needle))) {
      return true;
    }
    if (
      entry.isFile() &&
      (await fs.readFile(target, "utf8")).includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

export async function observeOfficialAuthoring(options: {
  fixture: DifferentialFixture;
  fixturePath: string;
  fixtureSkillsRoot: string;
  repositoryRoot: string;
  projectRoot: string;
  homeDir: string;
  outputRoot: string;
  depth: "quick" | "full";
  runner: OfficialCommandRunner;
}): Promise<AuthoringLifecycleObservation> {
  const planPath = path.join(
    options.projectRoot,
    "authoring-differential-plan.json",
  );
  const plan = fixturePlanForOfficial(options.fixture);
  await fs.mkdir(options.projectRoot, { recursive: true });
  await prepareFixtureProject(
    options.repositoryRoot,
    options.fixturePath,
    options.fixtureSkillsRoot,
    options.fixture,
    options.projectRoot,
  );
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
  await invokeOfficial(
    options.runner,
    ["creator", "candidates"],
    options.projectRoot,
    options.homeDir,
  );
  const proposal = record(
    await invokeOfficial(
      options.runner,
      ["creator", "propose", plan.workflow.name, "--file", planPath],
      options.projectRoot,
      options.homeDir,
    ),
    "official proposal",
  );
  const generatedFallback = path.join(
    options.projectRoot,
    ".comet",
    "bundle-drafts",
    plan.workflow.name,
  );
  const canGenerate =
    proposal.canGenerate === true || proposal.canInitialize === true;
  if (!canGenerate) {
    const readiness = fallbackReadiness(
      "blocked",
      Array.isArray(proposal.blockers)
        ? proposal.blockers.filter(
            (item): item is string => typeof item === "string",
          )
        : ["Official proposal cannot generate"],
    );
    const generatedArtifacts = await inventoryDirectory(
      generatedFallback,
      true,
    );
    return {
      side: "official",
      workflow: plan.workflow.name,
      status: "blocked",
      authoringStatus: "pending",
      lifecycleComplete: false,
      completedLanes: [],
      laneStatuses: Object.fromEntries(
        authoringLaneIds().map((lane) => [lane, "PENDING"]),
      ),
      contentLeaves: contentLeavesForFixture(options.fixture),
      generatedArtifacts,
      artifactOwners: {},
      readiness: {
        state: "blocked",
        authoring: readiness,
        runtime: readiness,
        publication: readiness,
      },
      identities: {
        planHash: stringValue(proposal.planHash),
        protocolHash: null,
        workflowProtocolHash: null,
        sourceEvidenceHash: null,
        authoringPlanHash: null,
        authoringInputHash: null,
        scaffoldHash: null,
        authoredMaterialHash: null,
        assembledPackageHash: null,
        authoringReviewHash: null,
        evaluationHash: null,
        packageHash: null,
        publicationApprovalHash: null,
      },
      evidencePaths: { workflowPlan: planPath },
      outputEnvelope: OFFICIAL_AUTHORING_OUTPUT_ENVELOPE,
    };
  }
  await invokeOfficial(
    options.runner,
    [
      "creator",
      "init",
      plan.workflow.name,
      "--file",
      planPath,
      "--confirmed-proposal",
    ],
    options.projectRoot,
    options.homeDir,
  );
  const firstGenerated = record(
    await invokeOfficial(
      options.runner,
      ["creator", "generate", plan.workflow.name],
      options.projectRoot,
      options.homeDir,
    ),
    "official generated scaffold",
  );
  let packageRoot = generatedArtifactRoot(
    options.projectRoot,
    firstGenerated,
    generatedFallback,
  );
  const scaffoldHash = await hashDirectory(packageRoot).catch(() => null);
  const authoringPlan = await invokeOfficial(
    options.runner,
    ["creator", "authoring-plan", plan.workflow.name, "--depth", options.depth],
    options.projectRoot,
    options.homeDir,
  );
  const recordRoot = path.join(options.outputRoot, "official-lanes");
  await fs.mkdir(recordRoot, { recursive: true });
  const recordedLanes: string[] = [];
  for (const lane of [
    ...authoringLaneIds().filter((item) => item !== "skill-review"),
    "skill-review",
  ]) {
    const outputPath = path.join(recordRoot, `${lane}.json`);
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        officialLaneOutput(options.fixture, lane, authoringPlan),
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await invokeOfficial(
      options.runner,
      [
        "creator",
        "authoring-record",
        plan.workflow.name,
        "--lane",
        lane,
        "--file",
        outputPath,
      ],
      options.projectRoot,
      options.homeDir,
    );
    recordedLanes.push(lane);
  }
  const finalGenerated = record(
    await invokeOfficial(
      options.runner,
      ["creator", "generate", plan.workflow.name],
      options.projectRoot,
      options.homeDir,
    ),
    "official assembled scaffold",
  );
  packageRoot = generatedArtifactRoot(
    options.projectRoot,
    finalGenerated,
    packageRoot,
  );
  const statusResult = record(
    await invokeOfficial(
      options.runner,
      ["creator", "status", plan.workflow.name],
      options.projectRoot,
      options.homeDir,
    ),
    "official authoring status",
  );
  let reviewResult: unknown;
  let publicationReviewFailed = false;
  try {
    reviewResult = await invokeOfficial(
      options.runner,
      [
        "publish",
        "review",
        plan.workflow.name,
        "--platform",
        "codex",
        "--scope",
        "project",
      ],
      options.projectRoot,
      options.homeDir,
    );
  } catch (error) {
    publicationReviewFailed = true;
    reviewResult = {
      readiness: {
        state: "blocked",
        blockers: [`Official publication review failed: ${String(error)}`],
        warnings: [],
        evidence: {},
      },
    };
  }
  const pending = await packageContainsText(packageRoot, "AUTHORING PENDING");
  const generatedArtifacts = await inventoryDirectory(packageRoot, true);
  const generatedPaths = new Set(
    generatedArtifacts.files.map((file) => file.path),
  );
  const allContentLeavesPresent = contentLeavesForFixture(
    options.fixture,
  ).every((contentPath) =>
    generatedPaths.has(
      contentPath.startsWith("../") ? contentPath.slice(3) : contentPath,
    ),
  );
  const completed =
    recordedLanes.length === authoringLaneIds().length &&
    !pending &&
    allContentLeavesPresent &&
    !publicationReviewFailed;
  const publication = officialReadiness(
    reviewResult,
    fallbackReadiness(
      completed ? "ready" : "blocked",
      pending ? ["Official package retains authoring-pending content"] : [],
    ),
  );
  const packageHash = await hashDirectory(packageRoot).catch(() => null);
  const contentLeaves = contentLeavesForFixture(options.fixture);
  const planRecord = objectValue(authoringPlan);
  const identities: AuthoringIdentityEvidence = {
    planHash: stringValue(proposal.planHash),
    protocolHash: stringValue(planRecord?.protocolHash),
    workflowProtocolHash: stringValue(planRecord?.workflowProtocolHash),
    sourceEvidenceHash: stringValue(planRecord?.sourceEvidenceHash),
    authoringPlanHash: stringValue(planRecord?.authoringPlanHash),
    authoringInputHash: stringValue(planRecord?.authoringInputHash),
    scaffoldHash,
    authoredMaterialHash: packageHash,
    assembledPackageHash: packageHash,
    authoringReviewHash: null,
    evaluationHash: stringValue(objectValue(statusResult.eval)?.hash),
    packageHash,
    publicationApprovalHash: null,
  };
  const laneStatuses = Object.fromEntries(
    authoringLaneIds().map((lane) => [
      lane,
      recordedLanes.includes(lane) ? "DONE" : "PENDING",
    ]),
  );
  const status = stringValue(statusResult.status) ?? "generated";
  return {
    side: "official",
    workflow: plan.workflow.name,
    status,
    authoringStatus: completed ? "authored" : "in-progress",
    lifecycleComplete: completed,
    completedLanes: [...recordedLanes],
    laneStatuses,
    contentLeaves,
    generatedArtifacts,
    artifactOwners: artifactOwnerMap(generatedArtifacts, contentLeaves),
    readiness: publication,
    identities,
    evidencePaths: {
      workflowPlan: planPath,
      authoringPlan: path.join(
        options.projectRoot,
        ".comet",
        "bundle-authoring",
        `${plan.workflow.name}.json`,
      ),
      package: packageRoot,
      outputRoot: options.outputRoot,
    },
    outputEnvelope: OFFICIAL_AUTHORING_OUTPUT_ENVELOPE,
  };
}

function expectedRevisionFromManifest(value: unknown): string {
  const manifest = record(value, "extraction manifest");
  return (
    stringValue(
      record(manifest.official, "extraction manifest official").revision,
    ) ?? ""
  );
}

async function readProtocol(file: string): Promise<AuthoringProtocolSnapshot> {
  const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  return canonicalizeAuthoringProtocol(value, file);
}

function fixtureSourceIntegrity(
  before: DirectorySnapshot[],
  after: DirectorySnapshot[],
): boolean {
  return (
    before.length === after.length &&
    before.every((snapshot, index) => snapshotsEqual(snapshot, after[index]))
  );
}

async function fixtureSources(
  repositoryRoot: string,
  fixturePath: string,
  fixtureSkillsRoot: string,
  fixture: DifferentialFixture,
): Promise<DirectorySnapshot[]> {
  return Promise.all(
    fixture.skills.map(async (skill) => {
      const source = fixtureSkillPath(fixturePath, skill);
      assertFixtureSourcePath(repositoryRoot, source, fixtureSkillsRoot);
      if (!isWithin(fixtureSkillsRoot, source)) {
        throw new Error(`Fixture Skill is outside configured root: ${source}`);
      }
      return snapshotDirectory(source);
    }),
  );
}

export async function runAuthoringDifferentialHarness(
  options: AuthoringDifferentialHarnessOptions,
): Promise<AuthoringDifferentialReport> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const fixturePath = path.resolve(options.fixturePath);
  const fixtureSkillsRoot = path.resolve(
    repositoryRoot,
    options.fixtureSkillsRoot ?? path.join("primer_designer_harness", "skills"),
  );
  const fixture = await readFixture(fixturePath);
  const extractionManifestPath = path.resolve(
    path.dirname(fixturePath),
    fixture.extractionManifest,
  );
  const extractionManifest = await readExtractionManifest(
    extractionManifestPath,
  );
  const expectedRevision = expectedRevisionFromManifest(extractionManifest);
  const officialRoot = path.resolve(options.officialRoot);
  const officialRevision =
    options.officialRevision ?? (await readOfficialRevision(officialRoot));
  const verified = officialRevision === expectedRevision;
  if (!verified) {
    throw new Error(
      `Official authoring baseline revision mismatch: expected ${expectedRevision}, got ${officialRevision}`,
    );
  }
  const officialProtocolPath = path.resolve(
    officialRoot,
    options.officialProtocolPath ?? DEFAULT_OFFICIAL_PROTOCOL_PATH,
  );
  const officialSourcePaths = [...OFFICIAL_SOURCE_PATHS];
  officialSourcePaths[1] =
    options.officialProtocolPath ?? DEFAULT_OFFICIAL_PROTOCOL_PATH;
  officialSourcePaths[2] =
    options.officialAuthoringSourcePath ??
    DEFAULT_OFFICIAL_AUTHORING_SOURCE_PATH;
  const officialSourceBefore = await sourceFileSnapshots(
    officialRoot,
    officialSourcePaths,
  );
  const badgerProtocolPath = path.resolve(repositoryRoot, BADGER_PROTOCOL_PATH);
  const officialProtocol = await readProtocol(officialProtocolPath);
  const badgerProtocol = await readProtocol(badgerProtocolPath);
  const sourceBefore = await fixtureSources(
    repositoryRoot,
    fixturePath,
    fixtureSkillsRoot,
    fixture,
  );
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-authoring-differential-"),
  );
  const officialProject = path.join(temporaryRoot, "official-project");
  const badgerProject = path.join(temporaryRoot, "badger-project");
  const officialHome = path.join(temporaryRoot, "official-home");
  const badgerHome = path.join(temporaryRoot, "badger-home");
  const officialOutput = path.join(temporaryRoot, "official-output");
  const badgerOutput = path.join(temporaryRoot, "badger-output");
  try {
    await Promise.all([
      fs.mkdir(officialHome, { recursive: true }),
      fs.mkdir(badgerHome, { recursive: true }),
      fs.mkdir(officialOutput, { recursive: true }),
      fs.mkdir(badgerOutput, { recursive: true }),
    ]);
    const runner =
      options.officialRunner ??
      createOfficialCommandRunner({
        officialCli:
          options.officialCli ?? path.join(officialRoot, "bin", "comet.js"),
      });
    const [officialObservation, badgerObservation] = await Promise.all([
      observeOfficialAuthoring({
        fixture,
        fixturePath,
        fixtureSkillsRoot,
        repositoryRoot,
        projectRoot: officialProject,
        homeDir: officialHome,
        outputRoot: officialOutput,
        depth: options.depth ?? "quick",
        runner,
      }),
      observeStandaloneAuthoring({
        fixture,
        fixturePath,
        fixtureSkillsRoot,
        repositoryRoot,
        projectRoot: badgerProject,
        homeDir: badgerHome,
        outputRoot: badgerOutput,
        depth: options.depth ?? "quick",
      }),
    ]);
    const comparison = compareAuthoringObservations(
      officialObservation,
      badgerObservation,
      compareAuthoringProtocols(officialProtocol, badgerProtocol),
    );
    const sourceAfter = await fixtureSources(
      repositoryRoot,
      fixturePath,
      fixtureSkillsRoot,
      fixture,
    );
    const officialSourceAfter = await sourceFileSnapshots(
      officialRoot,
      officialSourcePaths,
    );
    const unchanged = fixtureSourceIntegrity(sourceBefore, sourceAfter);
    const officialUnchanged = sourceSnapshotsEqual(
      officialSourceBefore,
      officialSourceAfter,
    );
    const certification: AuthoringCertification = certifyAuthoringDifferential({
      official: { verified, unchanged: officialUnchanged },
      fixture: { unchanged },
      comparison,
      officialLifecycleComplete: officialObservation.lifecycleComplete,
      badgerLifecycleComplete: badgerObservation.lifecycleComplete,
    });
    return {
      schemaVersion: 1,
      kind: "official-badger-authoring-differential",
      extractionManifest,
      fixture: {
        id: fixture.id,
        skills: fixture.skills.map((skill) => skill.name),
        sourceBefore,
        sourceAfter,
        unchanged,
      },
      official: {
        root: officialRoot,
        revision: officialRevision,
        expectedRevision,
        verified,
        sourceBefore: officialSourceBefore,
        sourceAfter: officialSourceAfter,
        unchanged: officialUnchanged,
        protocol: officialProtocol,
        observation: officialObservation,
      },
      badger: {
        root: repositoryRoot,
        protocol: badgerProtocol,
        observation: badgerObservation,
        sourcePaths: BADGER_SOURCE_PATHS.map((sourcePath) =>
          path.resolve(repositoryRoot, sourcePath),
        ),
      },
      extensions: EXPECTED_BADGER_AUTHORING_EXTENSIONS.map((extension) => ({
        ...extension,
        sourcePaths: extension.sourcePaths.map((sourcePath) =>
          path.resolve(repositoryRoot, sourcePath),
        ),
      })),
      comparison,
      certification,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
