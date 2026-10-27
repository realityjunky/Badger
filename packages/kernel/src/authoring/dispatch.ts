import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreatorState, NodeProtocol } from "../types.js";
import { atomicWrite, isWithin, sha256, slug, stableValue } from "../util.js";
import { inspectProtectedProjectPath } from "../engine/protected-project-path.js";
import { atomicWriteContainedText } from "../engine/contained-atomic-write.js";
import { deriveAuthoringPlan } from "./plan.js";
import { readState } from "../factory/state.js";
import {
  authoringPlanPath,
  authoringSessionPath,
  authoringSessionGateway,
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
  modifyGeneratedPackage: false;
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
  confirmedProposal: { path: string; hash: string; limitBytes: number };
  semanticDossier?: { path: string; pointer: "/semanticDossier"; hash: string };
  outputPath: string;
  outputLimitBytes: number;
  dependencies: AuthoringLaneId[];
  upstreamRecords: Array<{
    lane: AuthoringLaneId;
    path: string;
    status: string;
    authoringInputHash: string;
    semanticDossierHash?: string;
  }>;
  nodeContext?: Array<{ id: string; responsibility: unknown }>;
  hashes: {
    protocolHash: string;
    authoringPlanHash: string;
    workflowProtocolHash: string;
    sourceEvidenceHash: string;
    authoringInputHash: string;
    semanticDossierHash?: string;
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
  modifyGeneratedPackage: false,
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
    path.resolve(
      moduleDirectory,
      "../../assets/skills/badger-create",
      relativePath,
    ),
    path.resolve(
      moduleDirectory,
      "../../../assets/skills/badger-create",
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

async function outputPathFor(
  options: BuildAuthoringHandoffOptions,
): Promise<string> {
  const outputPath = path.resolve(options.outputPath);
  const protectedRoot = path.join(options.state.projectRoot, ".badger");
  if (isWithin(protectedRoot, outputPath))
    throw new Error("Authoring provider output cannot be inside .badger state");
  if (
    options.state.generated &&
    (isWithin(options.state.generated.packageRoot, outputPath) ||
      isWithin(
        await fs.realpath(options.state.generated.packageRoot),
        outputPath,
      ))
  )
    throw new Error(
      "Authoring provider output cannot modify the generated package",
    );
  if (outputPath.includes("\0"))
    throw new Error("Authoring provider output path is invalid");
  await assertHandoffPath(outputPath);
  return outputPath;
}

async function assertHandoffPath(file: string): Promise<void> {
  const root = path.parse(file).root;
  await inspectProtectedProjectPath(root, path.relative(root, file), {
    label: "Authoring handoff path",
    expected: "file",
  });
}

function commonInputPath(outputPath: string): string {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.common-input.json`,
  );
}

function fixtureNode(
  state: CreatorState,
  pathValue: string,
): NodeProtocol | undefined {
  const workflow = state.confirmedProposal?.workflow;
  if (!workflow) return undefined;
  return workflow.nodes.find(
    (node) =>
      !node.disabled &&
      ("../" +
        (slug(state.confirmedProposal?.name ?? workflow.name) || "workflow") +
        "-" +
        (slug(node.id) || "node") +
        "/SKILL.md" ===
        pathValue ||
        pathValue.endsWith("-" + (slug(node.id) || "node") + "/SKILL.md")),
  );
}

function substantiveFixtureContent(
  state: CreatorState,
  pathValue: string,
): string {
  const workflow = state.confirmedProposal?.workflow;
  if (pathValue === "SKILL.md") {
    return [
      "## Decision Core",
      "",
      "### Automatic Node Detection",
      "1. Read the ordered active Nodes and compare the request topic with each Node responsibility.",
      "2. Read persisted WorkflowRuntime state and use the first incomplete current Node; do not load multiple Nodes at once.",
      "3. If the topic belongs to an earlier or later Node, explain the ordering conflict before acting.",
      "",
      "### Resume And Drift",
      "On every resume, read persisted state and the current files again rather than trusting conversation history. If state says a Node is complete but its evidence is missing, treat it as incomplete. A topic change requires confirming whether to continue the current Node or return to the declared Node that owns the new scope.",
      "",
      "### Decision Classification And Decision Points",
      "Classify each interruption as a genuine user decision, automatic handling, a stop condition, or a manual handoff. Pause only for a genuine user decision with at least two declared options that change scope, behavior, risk, or an irreversible outcome. Apply the sole safe automatic handling directly; report a stop condition with its recovery requirement; return a manual handoff without inventing a runtime route.",
      "",
      "### Red Flags",
      "- Treating conversation history as the source of current Node state hides drift after a fresh process.",
      "- Treating every guard failure as a user decision creates unnecessary pauses instead of applying the safe repair.",
      "- Loading a later Node before the persisted current Node is complete skips required evidence.",
      workflow
        ? "The declared workflow is " +
          workflow.name +
          "; route and choice references remain limited to its protocol."
        : "",
    ].join("\n");
  }
  if (pathValue.endsWith("/SKILL.md")) {
    const node = fixtureNode(state, pathValue);
    const requiredSkillCalls = node?.requiredSkillCalls ?? [];
    const requiredCalls = requiredSkillCalls.length
      ? requiredSkillCalls
          .map(
            (binding) =>
              "- " +
              binding.skill +
              `: Required Skill Call operation ${binding.operation} scope ${binding.scope} enforcement ${binding.enforcement}; load it for the declared scope and record its completion check before advancing.`,
          )
          .join("\n")
      : "- No additional Skill Calls are required for this Node; use the declared implementation only.";
    const guardrailDetails = node?.guardrails.length
      ? node.guardrails
          .map((guardrail) => {
            const verification = guardrail.verification;
            const kinds = verification
              ? Array.isArray(verification.kind)
                ? verification.kind.join(", ")
                : verification.kind
              : undefined;
            return (
              "- Guardrail: " +
              guardrail.id +
              (verification
                ? `; verification role ${verification.role} kind ${kinds}.`
                : ".")
            );
          })
          .join("\n")
      : "- Guardrails: none are declared for this Node.";
    const outputEvidence = node?.outputSchemas.length
      ? node.outputSchemas
          .map((schemaId) => {
            const schema = workflow?.outputSchemas.find(
              (candidate) => candidate.id === schemaId,
            );
            const versionedArtifacts =
              schema?.artifacts
                .filter((artifact) => artifact.lifetime !== undefined)
                .map((artifact) => artifact.id) ?? [];
            const requiredArtifacts =
              schema?.artifacts
                .filter((artifact) => artifact.required)
                .map((artifact) => artifact.id) ?? [];
            const requiredEvidence =
              schema?.evidence
                .filter((evidence) => evidence.required)
                .map((evidence) => evidence.id) ?? [];
            return (
              "- Capture evidence for output schema " +
              schemaId +
              (requiredArtifacts.length
                ? `; required artifacts ${requiredArtifacts.join(", ")}`
                : "") +
              (requiredEvidence.length
                ? `; required evidence ${requiredEvidence.join(", ")}`
                : "") +
              " and connect it to the completion summary." +
              (versionedArtifacts.length
                ? ` Select the exact accepted version and content hash for ${versionedArtifacts.join(", ")} with producer identity.`
                : "")
            );
          })
          .join("\n")
      : "- Record the bounded completion summary and any declared artifact evidence.";
    const nodeContext = node
      ? "This Guidance belongs to the " +
        node.label +
        " Node (" +
        node.id +
        "), whose responsibility is: " +
        node.responsibility
      : "This Guidance belongs to an active workflow Node with a declared responsibility.";
    const implementationContext = node
      ? "Use the declared implementation Skill " +
        node.implementation.skill +
        " for this Node; do not replace it with an unregistered capability."
      : "Use only the implementation declared by the workflow protocol.";
    return [
      "## Guidance",
      "",
      nodeContext,
      implementationContext,
      "",
      "### Prerequisites",
      "- The entry Decision Core has confirmed the current Node and its topic scope from persisted state.",
      "- The bound implementation is available and its prerequisites are satisfied; stop rather than improvise when a required dependency is missing.",
      "",
      "### Steps",
      "1. Re-read the current Node state, responsibility, and declared inputs before doing domain work.",
      "2. Load the bound Skill by its declared name and apply its domain method only to the confirmed scope.",
      "3. Check the result against the Node's completion judgment, rejecting shallow or unverified work that merely looks complete.",
      "4. Record bounded evidence before the mechanical exit check and before handing control to the next declared Node.",
      "",
      "### Required Skill Calls",
      requiredCalls,
      "",
      "### Guardrails",
      guardrailDetails,
      "",
      "### Evidence",
      outputEvidence,
      "The evidence must explain what was done, what was observed, and why the result satisfies this Node rather than only repeating the route metadata.",
      "",
      "### Completion reasoning",
      "Consider this Node complete only when the domain result is sufficient for its responsibility, required Skill Calls are evidenced, and the recorded output can support the next Node without hidden assumptions.",
      "",
      "### Red flags",
      "- Advancing after a command or checklist ran while the domain result remains empty, ambiguous, or unverified.",
      "- Copying a bound Skill body instead of recording the decisions and evidence specific to this Node.",
      "- Selecting an artifact by recency or guessing a missing dependency instead of stopping with a bounded finding.",
      "",
      "### Recovery",
      "On resume, read the persisted current Node and its evidence in a fresh process. If evidence is stale, incomplete, or the Node is blocked, preserve the blocked reason, correct the declared prerequisite, and re-enter this Node before continuing.",
    ].join("\n");
  }
  if (pathValue.endsWith("decision-points.md")) {
    const choices =
      workflow?.nodes.flatMap(
        (node) => node.decision?.choices.map((choice) => choice.id) ?? [],
      ) ?? [];
    const routes = [
      ...(workflow?.routing?.routes ?? []),
      ...(workflow?.evals.flatMap(
        (evaluation) => evaluation.expectedRoutes ?? [],
      ) ?? []),
    ].filter(
      (route, index, allRoutes) =>
        allRoutes.findIndex((candidate) => candidate.id === route.id) === index,
    );
    const declarations = choices.length
      ? choices
          .map((choice) => "- Declared choice: choice: " + choice + ".")
          .join("\n")
      : "- No declared runtime choices exist for this synthetic workflow.";
    const routeDeclarations = routes.length
      ? routes.map((route) => "- Declared route " + route.id + ".").join("\n")
      : "- No declared route choices exist for this synthetic workflow.";
    return [
      "# Decision Points",
      "",
      "## Classification",
      "Every interruption is classified before it is presented to a user. The classification is based on the current WorkflowProtocol and persisted evidence, not on conversation momentum.",
      "",
      "### Genuine User Decisions",
      "Pause only when at least two currently executable options change scope, behavior, accepted risk, or an irreversible outcome. Use only these declared runtime choices:",
      declarations,
      "",
      "### Automatic Handling",
      "Apply deterministic retries, state reconciliation, and the sole safe repair automatically. Automatic handling is not a genuine user decision and must not ask for confirmation.",
      "",
      "### Stop Conditions",
      "Missing context, corrupt evidence, stale identity, and guard failures with no safe continuation are stop conditions. Report the reason and required recovery without inventing a choice or route.",
      "",
      "### Manual Handoffs",
      "A manual handoff returns control to the responsible person when the protocol requires work outside the current process. It does not add a hidden runtime action or undeclared route.",
      "",
      "### Declared Routes",
      routeDeclarations,
    ].join("\n");
  }
  if (pathValue.endsWith("recovery.md")) {
    return [
      "# Recovery",
      "",
      "WorkflowRuntime remains the recovery authority; authoring guidance only explains its persisted boundary.",
      "",
      "## State First",
      "Start from persisted authoring and WorkflowRuntime state in a fresh process. Read the current Node, revision, lane records, and bounded findings before relying on any remembered context.",
      "",
      "## Resume Procedure",
      "Use the recorded next step for the current Node or authoring lane. Reuse valid persisted choices and evidence; do not ask the user to repeat a choice that remains bound to the same protocol and input hashes.",
      "",
      "## Drift Handling",
      "If the current Node, source evidence, package identity, or authoring input has drifted, report the blocked reason and keep the last valid record. Regenerate or re-author only the affected lane, then verify the next step from the fresh persisted state.",
      "",
      "## Manual Recovery",
      "When no automatic repair is safe, preserve the finding and hand off the exact recovery requirement. Never select an implicit latest artifact, mutate Run state from authored prose, or create a route that is absent from the WorkflowProtocol.",
    ].join("\n");
  }
  return [
    "# Skill Review",
    "",
    "## Contract Fit",
    "The six authoring lanes, their claims, dependencies, and content leaves match the declared AuthoringProtocol. The review verdict is approved only when all active Node guidance is substantive and executable metadata remains generator-owned.",
    "",
    "## Usability",
    "The assembled package explains how to start, resume, distinguish a genuine user decision from automatic handling, and recover a blocked Node without conversation history.",
    "",
    "## Strengths",
    "The semantic leaves add domain judgment while the deterministic Auto-zone preserves route, evidence, guard, and runtime ownership.",
    "",
    "## Findings",
    "No blocking findings remain. Minor wording findings do not change protocol behavior; blocking findings would prevent approval and require re-authoring before assembly.",
    "",
    "Verdict: approved; blocking findings: none.",
  ].join("\n");
}

function fixtureOutput(
  state: CreatorState,
  plan: AuthoringPlan,
  lane: AuthoringLaneId,
): AuthoringLaneOutput {
  const definition = plan.lanes.find((item) => item.id === lane)!;
  const output: AuthoringLaneOutput = {
    lane,
    status: "DONE",
    dispatchMode: "manual-file",
    ...(plan.semanticDossierHash
      ? { semanticDossierHash: plan.semanticDossierHash }
      : {}),
    claims: definition.claims.concat(definition.derivedClaims).map((id) => ({
      id,
      summary: `Manual fixture supports ${id}.`,
    })),
    artifacts: definition.contentLeaves.map((pathValue) => ({
      path: pathValue,
      kind: "markdown",
      content: substantiveFixtureContent(state, pathValue),
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
  const decision = await authoringSessionGateway().decide({
    state: options.state,
    operation: "dispatch",
    lane: options.lane,
  });
  if (!decision.allowed) {
    throw new Error(
      `Authoring lane ${options.lane} is not dispatchable:\n${decision.blockers.join("\n")}`,
    );
  }
  const outputPath = await outputPathFor(options);
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
  const proposal = options.state.confirmedProposal;
  if (
    !proposal ||
    deriveAuthoringPlan({ proposal, depth: plan.depth }).authoringPlanHash !==
      plan.authoringPlanHash
  )
    throw new Error(
      "Confirmed proposal is missing or stale for authoring handoff",
    );
  const proposalContent = JSON.stringify(stableValue(proposal), null, 2) + "\n";
  if (Buffer.byteLength(proposalContent, "utf8") > AUTHORING_OUTPUT_LIMIT_BYTES)
    throw new Error("Confirmed proposal exceeds the authoring input limit");
  const proposalHash = sha256(proposalContent);
  const proposalPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.proposal-${proposalHash}.json`,
  );
  const confirmedProposal = {
    path: proposalPath,
    hash: proposalHash,
    limitBytes: AUTHORING_OUTPUT_LIMIT_BYTES,
  };
  await assertHandoffPath(commonPath);
  await assertHandoffPath(proposalPath);
  const semanticDossier = plan.semanticDossierHash
    ? {
        path: authoringPlanPath(options.state),
        pointer: "/semanticDossier" as const,
        hash: plan.semanticDossierHash,
      }
    : undefined;
  const upstreamRecords = await Promise.all(
    lane.dependencies.map(async (dependency) => {
      const recordPath = path.join(
        authoringSessionPath(options.state),
        "records",
        `${dependency}.json`,
      );
      const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        status: string;
        authoringInputHash: string;
        semanticDossierHash?: string;
      };
      return {
        lane: dependency,
        path: recordPath,
        status: record.status,
        authoringInputHash: record.authoringInputHash,
        ...(record.semanticDossierHash
          ? { semanticDossierHash: record.semanticDossierHash }
          : {}),
      };
    }),
  );
  const nodeContext =
    options.lane === "skill-core" && plan.semanticDossier
      ? plan.semanticDossier.nodes.map((node) => ({
          id: node.id,
          responsibility: node.responsibility,
        }))
      : undefined;
  const handoffInputPaths = [commonPath, proposalPath, ...inputPaths];
  const commonContent =
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "authoring-common-input",
        ...(semanticDossier ? { semanticDossier } : {}),
        workflow: plan.name,
        lane: options.lane,
        inputPaths: handoffInputPaths,
        goal: options.state.confirmedProposal?.goal ?? "",
        confirmedProposal,
        upstreamRecords,
        ...(nodeContext ? { nodeContext } : {}),
        hashes: {
          protocolHash: plan.protocolHash,
          authoringPlanHash: plan.authoringPlanHash,
          workflowProtocolHash: plan.workflowProtocolHash,
          sourceEvidenceHash: plan.sourceEvidenceHash,
          authoringInputHash: options.state.authoring.authoringInputHash,
          ...(plan.semanticDossierHash
            ? { semanticDossierHash: plan.semanticDossierHash }
            : {}),
        },
        output: {
          path: outputPath,
          limitBytes: AUTHORING_OUTPUT_LIMIT_BYTES,
        },
        capabilities: capabilities(),
      },
      null,
      2,
    ) + "\n";
  if (Buffer.byteLength(commonContent, "utf8") > AUTHORING_OUTPUT_LIMIT_BYTES)
    throw new Error("Authoring common input exceeds its limit");
  await atomicWriteContainedText(proposalPath, proposalContent, {
    containedRoot: path.parse(proposalPath).root,
  });
  await atomicWriteContainedText(commonPath, commonContent, {
    containedRoot: path.parse(commonPath).root,
  });
  return {
    schemaVersion: 1,
    kind: "authoring-handoff",
    workflow: plan.name,
    lane: options.lane,
    roleBriefPath,
    inputPaths: handoffInputPaths,
    commonInputPath: commonPath,
    confirmedProposal,
    ...(semanticDossier ? { semanticDossier } : {}),
    outputPath,
    outputLimitBytes: AUTHORING_OUTPUT_LIMIT_BYTES,
    dependencies: [...lane.dependencies],
    upstreamRecords,
    ...(nodeContext ? { nodeContext } : {}),
    hashes: {
      protocolHash: plan.protocolHash,
      authoringPlanHash: plan.authoringPlanHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
      authoringInputHash: options.state.authoring.authoringInputHash,
      ...(plan.semanticDossierHash
        ? { semanticDossierHash: plan.semanticDossierHash }
        : {}),
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
    JSON.stringify(fixtureOutput(state, plan, lane), null, 2) + "\n",
  );
  await recordAuthoringFile({
    state,
    lane,
    file: outputPath,
    confirmed: true,
  });
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
