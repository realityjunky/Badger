import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreatorState } from "../types.js";
import { atomicWrite, isWithin } from "../util.js";
import { readState } from "../factory/state.js";
import {
  authoringPlanPath,
  authoringSessionPath,
  authoringReadiness,
  recordAuthoringFile,
  readAuthoringPlan,
} from "./lifecycle.js";
import type {
  AuthoringLaneId,
  AuthoringLaneOutput,
  AuthoringPlan,
} from "./types.js";

export const AUTHORING_OUTPUT_LIMIT_BYTES = 256 * 1024;

export interface AuthoringProviderCapabilities {
  writeCreatorState: false;
  executeCandidateSkills: false;
  publish: false;
  distribute: false;
  accessCredentials: false;
}

export interface AuthoringHandoff {
  schemaVersion: 1;
  kind: "authoring-handoff";
  workflow: string;
  lane: AuthoringLaneId;
  roleBriefPath: string;
  inputPaths: string[];
  commonInputPath: string;
  outputPath: string;
  outputLimitBytes: number;
  dependencies: AuthoringLaneId[];
  hashes: {
    protocolHash: string;
    authoringPlanHash: string;
    workflowProtocolHash: string;
    sourceEvidenceHash: string;
    authoringInputHash: string;
  };
  capabilities: AuthoringProviderCapabilities;
}

export interface BuildAuthoringHandoffOptions {
  state: CreatorState;
  lane: AuthoringLaneId;
  outputPath: string;
}

export interface ManualAuthoringFixtureOptions {
  state: CreatorState;
  outputRoot?: string;
}

const CAPABILITIES: AuthoringProviderCapabilities = {
  writeCreatorState: false,
  executeCandidateSkills: false,
  publish: false,
  distribute: false,
  accessCredentials: false,
};

function capabilities(): AuthoringProviderCapabilities {
  return { ...CAPABILITIES };
}

async function resolvePackageAsset(relativePath: string): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../../assets/skills/badger", relativePath),
    path.resolve(
      moduleDirectory,
      "../../../assets/skills/badger",
      relativePath,
    ),
  ];
  for (const candidate of candidates) {
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Authoring role brief is missing: ${relativePath}`);
}

async function resolveRoleBrief(
  packageRoot: string,
  relativePath: string,
): Promise<string> {
  const generatedPath = path.resolve(packageRoot, relativePath);
  try {
    const stats = await fs.lstat(generatedPath);
    if (stats.isFile()) return generatedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolvePackageAsset(relativePath);
}

function outputPathFor(options: BuildAuthoringHandoffOptions): string {
  const outputPath = path.resolve(options.outputPath);
  const protectedRoot = path.join(options.state.projectRoot, ".badger");
  if (isWithin(protectedRoot, outputPath))
    throw new Error("Authoring provider output cannot be inside .badger state");
  if (outputPath.includes("\0"))
    throw new Error("Authoring provider output path is invalid");
  return outputPath;
}

function commonInputPath(outputPath: string): string {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.common-input.json`,
  );
}

function fixtureContent(pathValue: string): string {
  if (pathValue === "SKILL.md")
    return "Detect the current Node from persisted state before explaining the next action.";
  if (pathValue.endsWith("/SKILL.md"))
    return "Load the bound Skill only after the entry check, then record bounded completion evidence.";
  if (pathValue.endsWith("decision-points.md"))
    return "Pause only for a declared user decision; automatic handling and stop conditions do not ask for confirmation.";
  if (pathValue.endsWith("recovery.md"))
    return "Resume from persisted authoring records and WorkflowRuntime state in a fresh process, not from conversation history.";
  return "The deterministic authoring fixture completed its review without blocking findings.";
}

function fixtureOutput(
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
): AuthoringLaneOutput {
  const definition = plan.lanes.find((item) => item.id === lane)!;
  const output: AuthoringLaneOutput = {
    lane,
    status: "DONE",
    dispatchMode: "manual-file",
    claims: definition.claims.concat(definition.derivedClaims).map((id) => ({
      id,
      summary: `Manual fixture supports ${id}.`,
    })),
    artifacts: definition.contentLeaves.map((pathValue) => ({
      path: pathValue,
      kind: "markdown",
      content: fixtureContent(pathValue),
    })),
    findings: [],
  };
  if (lane === "skill-review") {
    output.review = {
      passed: true,
      evidenceSource: "deterministic-check-only",
      voters: 0,
      lenses: [...plan.verify.lenses],
      rounds: 1,
      findings: [],
      reviewedAt: "1970-01-01T00:00:00.000Z",
    };
  }
  return output;
}

export async function buildAuthoringHandoff(
  options: BuildAuthoringHandoffOptions,
): Promise<AuthoringHandoff> {
  if (!options.state.generated || !options.state.authoring)
    throw new Error("Generate the workflow scaffold before dispatch");
  const plan = await readAuthoringPlan(options.state);
  const lane = plan.lanes.find((item) => item.id === options.lane);
  if (!lane) throw new Error(`Unknown authoring lane: ${options.lane}`);
  const readiness = await authoringReadiness(options.state);
  for (const dependency of lane.dependencies) {
    if (!readiness.completedLanes.includes(dependency))
      throw new Error(
        `Authoring lane ${options.lane} is blocked by ${dependency}`,
      );
  }
  const outputPath = outputPathFor(options);
  if (outputPath.length > 4096)
    throw new Error("Authoring provider output path is too long");
  const packageRoot = options.state.generated.packageRoot;
  const roleBriefPath = await resolveRoleBrief(packageRoot, lane.brief);
  const baseInputPaths = [
    roleBriefPath,
    authoringPlanPath(options.state),
    path.join(packageRoot, "reference", "workflow-protocol.json"),
    path.join(packageRoot, "reference", "resolved-skills.json"),
    ...lane.dependencies.map((dependency) =>
      path.join(
        authoringSessionPath(options.state),
        "records",
        `${dependency}.json`,
      ),
    ),
  ];
  const packageInputPaths = [
    path.join(packageRoot, "reference", "authoring-lanes.json"),
    path.join(packageRoot, "reference", "composition-report.md"),
    ...(options.lane === "script"
      ? [
          path.join(packageRoot, "scripts", "workflow-state.mjs"),
          path.join(packageRoot, "scripts", "workflow-guard.mjs"),
          path.join(packageRoot, "scripts", "workflow-handoff.mjs"),
        ]
      : []),
    ...plan.lanes
      .filter(
        (candidate) =>
          candidate.id === options.lane || options.lane === "skill-review",
      )
      .flatMap((candidate) =>
        candidate.contentLeaves.map((leaf) => {
          const relative = leaf.startsWith("../") ? leaf.slice(3) : leaf;
          return path.join(packageRoot, relative);
        }),
      ),
  ];
  const inputPaths = [...new Set([...baseInputPaths, ...packageInputPaths])];
  const commonPath = commonInputPath(outputPath);
  const handoffInputPaths = [commonPath, ...inputPaths];
  await atomicWrite(
    commonPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "authoring-common-input",
        workflow: plan.name,
        lane: options.lane,
        inputPaths: handoffInputPaths,
        goal: options.state.confirmedProposal?.goal ?? "",
        hashes: {
          protocolHash: plan.protocolHash,
          authoringPlanHash: plan.authoringPlanHash,
          workflowProtocolHash: plan.workflowProtocolHash,
          sourceEvidenceHash: plan.sourceEvidenceHash,
          authoringInputHash: options.state.authoring.authoringInputHash,
        },
        output: {
          path: outputPath,
          limitBytes: AUTHORING_OUTPUT_LIMIT_BYTES,
        },
        capabilities: capabilities(),
      },
      null,
      2,
    ) + "\n",
  );
  return {
    schemaVersion: 1,
    kind: "authoring-handoff",
    workflow: plan.name,
    lane: options.lane,
    roleBriefPath,
    inputPaths: handoffInputPaths,
    commonInputPath: commonPath,
    outputPath,
    outputLimitBytes: AUTHORING_OUTPUT_LIMIT_BYTES,
    dependencies: [...lane.dependencies],
    hashes: {
      protocolHash: plan.protocolHash,
      authoringPlanHash: plan.authoringPlanHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
      authoringInputHash: options.state.authoring.authoringInputHash,
    },
    capabilities: capabilities(),
  };
}

async function dispatchFixtureLane(
  state: CreatorState,
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
  outputRoot: string,
): Promise<void> {
  const outputPath = path.join(outputRoot, `${lane}.json`);
  await buildAuthoringHandoff({ state, lane, outputPath });
  await atomicWrite(
    outputPath,
    JSON.stringify(fixtureOutput(plan, lane), null, 2) + "\n",
  );
  await recordAuthoringFile({ state, lane, file: outputPath });
}

export async function runManualAuthoringFixture(
  options: ManualAuthoringFixtureOptions,
): Promise<CreatorState> {
  const plan = await readAuthoringPlan(options.state);
  const temporaryRoot =
    options.outputRoot ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "badger-authoring-provider-")));
  try {
    await Promise.all(
      plan.dag.wave1.map((lane) =>
        dispatchFixtureLane(options.state, plan, lane, temporaryRoot),
      ),
    );
    await Promise.all(
      plan.dag.wave2.map((lane) =>
        dispatchFixtureLane(options.state, plan, lane, temporaryRoot),
      ),
    );
    await dispatchFixtureLane(
      options.state,
      plan,
      plan.dag.barrier[0],
      temporaryRoot,
    );
    const state = await readState(
      options.state.projectRoot,
      options.state.name,
    );
    Object.assign(options.state, state);
    return state;
  } finally {
    if (!options.outputRoot)
      await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
