import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type {
  FactoryPlan,
  FactoryProposal,
  GeneratedPackageFile,
  NodeProtocol,
  UpgradeMigrationManifest,
  UpgradeSourceEvidence,
} from "../types.js";
import {
  copyDirectory,
  ensureDirectory,
  hashDirectory,
  isWithin,
  listFiles,
  packageRelativePath,
  replaceDirectory,
  sha256,
  slug,
  atomicWrite,
} from "../util.js";
import {
  AUTHORING_PROTOCOL_HASH,
  authoringContentLeaves,
  authoringDag,
  authoringLaneBrief,
  authoringLaneDependencies,
  authoringLaneIds,
  authoringProtocolProjection,
} from "../authoring/protocol.js";
import { normalizeWorkflowRepairPolicy } from "../workflow-runtime/repair.js";
import { deriveAuthoringPlan } from "../authoring/plan.js";
import {
  mapAuthoringPlanPaths,
  mapCandidatePaths,
  mapUpgradeManifestPaths,
  toStoredPaths,
  type ProjectPathMappers,
} from "./project-paths.js";
import type { AuthoringDepth } from "../authoring/types.js";
import {
  assertUpgradeDestinationOutsideSource,
  createUpgradeMigrationManifest,
  inspectUpgradeSource,
} from "./source.js";
import { bundledSourceRoot, bundleSourceSkills } from "./bundle-sources.js";

function nodeSkillName(workflow: string, node: string): string {
  return `${slug(workflow) || "workflow"}-${slug(node) || "node"}`;
}

const WORKFLOW_RUNTIME_CERTIFICATION_TASK = "workflow-runtime-certification";

export interface GeneratedPackage {
  packageRoot: string;
  protocolPath: string;
  evalPath: string;
  authoringPlanPath: string;
  scaffoldHash: string;
  inventory: GeneratedPackageFile[];
  sourceRoot?: string;
  sourceHash?: string;
  assembledPackageHash?: string;
  sourceEvidencePath?: string;
  sourceEvidence?: UpgradeMigrationManifest;
}

function entryMarkdown(proposal: FactoryProposal): string {
  const descriptionGoal = proposal.goal.replace(/[.!?]+$/u, "");
  const executableNodeIds =
    proposal.workflow.evals[0]?.expectedNodeOrder ??
    proposal.workflow.nodes
      .filter((node) => !node.disabled)
      .map((node) => node.id);
  const nodesById = new Map(
    proposal.workflow.nodes.map((node) => [node.id, node]),
  );
  const nodes = executableNodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is NodeProtocol => Boolean(node))
    .map(
      (node, index) =>
        `${index + 1}. **${node.label}** (Node ${node.id}, ${node.kind}) — ${node.responsibility}`,
    )
    .join("\n");
  const routes = (proposal.workflow.evals[0]?.expectedRoutes ?? [])
    .map(
      (route) =>
        `- **${route.id}**: ${route.nodeOrder.map((node) => `\`${node}\``).join(" → ")}`,
    )
    .join("\n");
  const cycles = (proposal.workflow.cycles ?? [])
    .map(
      (cycle) =>
        `- **${cycle.key}**: entry \`${cycle.entry}\`, maximum \`${cycle.maxInstances}\` instance(s), repeat ${cycle.repeatTransitions
          .map((transition) => `\`${transition.from}\` → \`${transition.to}\``)
          .join(", ")}`,
    )
    .join("\n");
  const artifacts = proposal.workflow.capabilities?.features.includes(
    "versioned-artifacts",
  )
    ? proposal.workflow.outputSchemas
        .flatMap((schema) =>
          schema.artifacts.map(
            (artifact) =>
              `- **${schema.id}.${artifact.id}**: \`${artifact.lifetime ?? "attempt"}\` lifetime; declared path ${artifact.paths.map((artifactPath) => `\`${artifactPath}\``).join(", ")}`,
          ),
        )
        .join("\n")
    : "";
  const verifications = proposal.workflow.nodes
    .flatMap((node) =>
      node.guardrails
        .filter((guardrail) => guardrail.verification)
        .map((guardrail) => ({
          node,
          guardrail,
          requirement: guardrail.verification!,
        })),
    )
    .map(
      ({ node, guardrail, requirement }) =>
        `- **${requirement.id ?? guardrail.id}** on Node \`${node.id}\`: \`${Array.isArray(requirement.kind) ? requirement.kind.join(", ") : requirement.kind}\` receipt for role \`${requirement.role}\``,
    )
    .join("\n");
  const durability = proposal.workflow.capabilities?.durability;
  const repairPolicyInput = durability?.repairPolicy ?? durability?.repair;
  const repairPolicy = repairPolicyInput
    ? normalizeWorkflowRepairPolicy(repairPolicyInput)
    : undefined;
  const repairChoices = repairPolicy?.allowedChoices ?? [];
  const repairs = repairPolicy
    ? [
        `- Maximum failures: \`${repairPolicy.maxFailures}\``,
        `- Warning threshold: \`${repairPolicy.warningThreshold}\`; manual stop threshold: \`${repairPolicy.manualStopThreshold}\``,
        `- Allowed choices: ${repairChoices
          .map((choice) =>
            typeof choice === "string" ? `\`${choice}\`` : `\`${choice.id}\``,
          )
          .join(", ")}`,
        `- One-time override: \`${repairPolicy.allowOneTimeOverride}\``,
      ].join("\n")
    : "- None. The workflow does not opt into evidence-bound repair policy.";
  const finalization = proposal.workflow.finalization
    ? [
        `- Declared operations: ${proposal.workflow.finalization.operations.length}`,
        `- Approved roots: ${proposal.workflow.finalization.roots.map((root) => root.id).join(", ")}`,
        `- Confirmation required: ${proposal.workflow.finalization.confirmation?.required !== false}`,
      ].join("\n")
    : "- None. The workflow does not opt into transactional finalization.";
  const executableNodeOrder = executableNodeIds
    .map((nodeId) => `\`${nodeId}\``)
    .join(" → ");
  const upgradeSourceSection = proposal.upgradeSource
    ? "\n## Upgrade Source\n\nThe original Skill package is preserved unchanged under `source/`. The migration manifest at `reference/source-evidence.json` records the source identity and whether each source path was retained, replaced by Badger control-plane material, or wrapped by authored guidance.\n"
    : "";
  const sourceSkills = proposal.candidates
    .flatMap((candidate) =>
      candidate.sources.map(
        (source) =>
          `- **${source.name}**: \`${bundledSourceRoot(source.hash)}/SKILL.md\``,
      ),
    )
    .join("\n");
  return `---
name: ${proposal.name}
description: ${JSON.stringify(`Run the ${proposal.name} workflow: ${descriptionGoal}.`)}
---

# ${proposal.workflow.name}

## Decision Core

<!-- AUTHORING PENDING -->
**Not yet authored.** The workflow-entry lane must add the semantic Decision Core before this scaffold can be assembled. Until then, use the persisted WorkflowRuntime continuation for routing and do not treat this package as authored.

## Badger Control Plane

- Inspect the normalized workflow contract with \`node scripts/badger-plan.mjs\`.
- Check the assembled package with \`node scripts/badger-check.mjs\`.
- The \`badger-hook-guard.mjs\` hook protects the active WorkflowRuntime boundary.
- \`workflow-state.mjs\`, \`workflow-guard.mjs\`, and \`workflow-handoff.mjs\` are thin adapters over WorkflowRuntime; they do not own route or Run state.

## Source Skills

${sourceSkills || "- No source Skills are declared."}

Source locations are relative to this package. Load the bundled Skill for the
active Node's declared binding. Each copy includes its references, scripts, and
configuration; copying a Skill does not execute its scripts.

## Runtime Semantics

Read the WorkflowRuntime continuation before entering a Node. The runtime owns route selection, pending actions, evidence submission, and state transitions. Load only the Node named by the persisted pending action and follow the structured finding required action when one is present.

Continuations include a versioned, bounded finding catalog. A finding has a
stable code, severity, redacted message, optional safe relative path, required
action, and an optional registered operation with an argument array. Treat
\`requiresUserDecision\` as authoritative: automatic repair and retry findings
are not user decisions. \`continue\` means executable machine work is available,
\`await-user\` means a persisted decision is pending, \`blocked\` means an
unresolved stop or repair condition prevents advancement, and \`done\` means the
Run is terminal. The \`blockers\` strings are a legacy projection for older
callers; do not parse them or use them for routing.

## Declared Routes

${routes || "- **default**: the runtime validates the active Node route before starting."}

## Declared Cycles

${cycles || "- None. The workflow is not cyclic."}

Cycle and Attempt identities come from the authoritative WorkflowRuntime. A
repeat transition allocates the next Cycle only when the declared finite budget
allows it; an exhausted budget is a blocker and does not create new state.

## Declared Artifacts

${artifacts || "- None. The workflow does not opt into versioned artifacts."}

WorkflowRuntime records immutable content-bound versions for declared outputs.
Required outputs must name one explicit physical update or accepted version.
Attempt-lifetime paths include the current Attempt id as a path segment. Later
work must select an exact accepted version; generated scripts never infer or
allocate a latest artifact version.

## Verification Receipts

${verifications || "- None. The workflow has no declared verification receipt guard."}

WorkflowRuntime accepts only bounded receipt proposals or exact existing receipt
references. It generates issue time, scope and artifact bindings, and the
content-addressed receipt identity. Failed, skipped, blocked, stale, malformed,
or drifted receipts remain evidence or findings and cannot satisfy a guard.

## Repair Policy

${repairs}

Repeated failure is evaluated from stable evidence identities, not prose or
timestamps. A warning remains automatic work; a manual stop is a persisted
repair decision; and a hard stop cannot be overridden. Generated adapters only
forward failed outcomes and declared decisions to WorkflowRuntime.
Automatic retries use the declared idempotent \`workflow.resume\` operation inside
the same locked transition journal.

## Transactional Finalization

${finalization}

Use \`node scripts/workflow-state.mjs preview --json\` to inspect the bounded,
content-addressed plan. Finalization writes, removes, and moves are protected by
approved roots, exact preconditions, recoverable staging or backups, and the
existing \`submit\`/\`recover\` runtime seam. Every local effect requires a
persisted confirmation; only a durable final receipt permits \`done\`.

Decision Nodes may declare bounded artifact and evidence scope entries. The
runtime captures only accepted version ids, hashes, and producer identities for
those entries when it creates the pending question. Generated scripts render
and forward that scope without exposing artifact contents or validating the
references themselves.

## Executable Node Order

Executable Node Order: ${executableNodeOrder || "(empty)"}

${upgradeSourceSection}

## Workflow Nodes

${nodes}

## Runtime Commands

- Check the authoritative run: \`node scripts/workflow-state.mjs status\`.
- Start a run only when status is \`not-started\`: \`node scripts/workflow-state.mjs init\`.
- Resume a persisted Run: \`node scripts/workflow-state.mjs resume\`.
- Recover an interrupted Run or finalization: \`node scripts/workflow-state.mjs recover\`.
- Explicitly roll back a recoverable finalization: \`node scripts/workflow-state.mjs recover --rollback-finalization\`.
- Read the persisted action and Node: \`node scripts/workflow-state.mjs next\`.
- Preview declared local finalization: \`node scripts/workflow-state.mjs preview --json\`.
- Inspect machine-readable findings with \`--json\`; use each finding's registered operation and argument array rather than constructing a shell command.
- Submit characterized Node evidence: \`node scripts/workflow-state.mjs record <node> '<json evidence>'\`.
- Supply physical updates under \`artifacts\` and explicit accepted version ids under \`artifactVersions\` in the record JSON.
- Supply a bounded verification proposal under \`verification\`, or exact receipt ids under \`verificationReceiptIds\`; the runtime owns receipt identity and issue time.
- Submit a declared human decision: \`node scripts/workflow-state.mjs decide <node> '<json response>'\`.
- For branched workflows, include declared route values in the submission's top-level \`routing\` object; summaries and evidence do not select edges.
- Verify the generated protocol and runtime: \`node scripts/workflow-guard.mjs verify\`.
- Verify the current Node before entry: \`node scripts/workflow-guard.mjs entry <node>\`.
- Validate Node completion without advancing: \`node scripts/workflow-guard.mjs exit <node> '<json evidence>'\`.
- Apply validated completion explicitly: \`node scripts/workflow-guard.mjs exit <node> '<json evidence>' --apply\`.
- Validate and apply a decision through the runtime: \`node scripts/workflow-guard.mjs decision <node> '<json response>' --apply\`.
- Produce a read-only workflow handoff: \`node scripts/workflow-handoff.mjs --json\`.
- Rebuild a deleted or stale compatibility projection explicitly: \`node scripts/workflow-state.mjs status --rebuild --confirm legacy-state\`.
- Use \`BADGER_RUN_ROOT\` or \`--run-root\` for a change-bound Run; use \`--project <dir> --run-id <id>\` for a standalone Run.

The state document at \`${proposal.workflow.state.statePath}\` is a derived compatibility projection. It is never used for routing or recovery and may be rebuilt from the authoritative Run.

## Certification boundary

\`badger eval\` runs current-hash WorkflowRuntime checks, including a
synthetic Phase 3 decision-and-cycle lifecycle. Passing evaluation proves only
deterministic runtime and adapter behavior; it does not authorize domain
execution or package installation.

## Runtime Contract

- Reusable runtime: \`scripts/workflow-runtime.mjs\`
- Protocol: \`reference/workflow-protocol.json\`
- Resolved source evidence: \`reference/resolved-skills.json\`
- Eval manifest: \`badger/eval.yaml\`
`;
}

function nodeMarkdown(workflow: string, node: NodeProtocol): string {
  const required =
    node.requiredSkillCalls
      .map(
        (item) => `- Required Skill: \`${item.skill}\` (${item.enforcement})`,
      )
      .join("\n") || "- Required Skills: none";
  const schemas =
    node.outputSchemas
      .map((item) => `- Output Schema: \`${item}\``)
      .join("\n") || "- Output Schemas: none";
  const verifications = node.guardrails
    .filter((guardrail) => guardrail.verification)
    .map((guardrail) => {
      const requirement = guardrail.verification!;
      const kinds = Array.isArray(requirement.kind)
        ? requirement.kind.join(", ")
        : requirement.kind;
      return `- Verification Receipt: \`${requirement.id ?? guardrail.id}\` (${kinds}; role \`${requirement.role}\`)`;
    })
    .join("\n");
  const decisionScope = node.decision
    ? [
        ...(node.decision.scope?.artifacts ?? []).map(
          (entry) =>
            `- Artifact scope: \`${entry.id}\`${entry.required ? " (required)" : " (optional)"}`,
        ),
        ...(node.decision.scope?.evidence ?? []).map(
          (entry) =>
            `- Evidence scope: \`${entry.id}\`${entry.required ? " (required)" : " (optional)"}`,
        ),
      ].join("\n") || "- Decision scope: none"
    : "";
  const decision = node.decision
    ? `\n## Decision\n\nQuestion: ${node.decision.question}\n\n${node.decision.choices
        .map((choice) => `- \`${choice.id}\`: ${choice.label}`)
        .join(
          "\n",
        )}\n\n${decisionScope}\n\nSubmit the typed response through \`scripts/workflow-state.mjs decide\`; WorkflowRuntime validates the choice, inputs, rationale, reviewer attestation, and immutable scope references.\n`
    : "";
  return `---\nname: ${nodeSkillName(workflow, node.id)}\ndescription: ${JSON.stringify(`Execute the ${node.label} Node of ${workflow}.`)}\n---\n\n# ${node.label}\n\nResponsibility: ${node.responsibility}\n\n## Guidance\n\n<!-- AUTHORING PENDING -->\n**Not yet authored.** The skill-core lane must add prerequisites, domain steps, completion reasoning, red flags, and recovery guidance before this scaffold can be assembled.\n\n## Required bindings\n\n${required}\n\n## Evidence\n\n${schemas}\n${verifications ? `\n## Verification\n\n${verifications}\n\nSubmit bounded receipt evidence or exact receipt references through WorkflowRuntime; receipt contents and issue time are runtime-owned.\n` : ""}\n${decision}\nRecord completion evidence before advancing to the next Node.\n`;
}

async function runtimeAsset(name: string): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../../assets/runtime", name),
    path.resolve(moduleDirectory, "../../../assets/runtime", name),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Runtime asset not found: ${name}`);
}

async function authoringReference(relativePath: string): Promise<string> {
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
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Authoring reference not found: ${relativePath}`);
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function activeNodes(proposal: FactoryProposal): NodeProtocol[] {
  return proposal.workflow.nodes.filter((node) => !node.disabled);
}

function generatedPackagePaths(
  proposal: FactoryProposal,
  hasAuthoringPlan: boolean,
  hasSourceEvidence: boolean,
): string[] {
  const authoredLeaves = authoringContentLeaves({
    activeNodeIds: activeNodes(proposal).map((node) => node.id),
    workflowName: proposal.name,
  }).map(packageRelativePath);
  return [
    ...authoredLeaves,
    "reference/workflow-protocol.json",
    "reference/resolved-skills.json",
    ...(hasAuthoringPlan ? ["reference/authoring-plan.json"] : []),
    "reference/authoring-lanes.json",
    "reference/composition-report.md",
    "reference/eval-manifest.json",
    ...authoringLaneIds().map((lane) => authoringLaneBrief(lane)),
    ...authoringProtocolProjection().controlPlaneScripts.map(
      (script) => script.path,
    ),
    "scripts/workflow-runtime.mjs",
    "reference/package-inventory.json",
    ...(hasSourceEvidence ? ["reference/source-evidence.json"] : []),
    "badger/skill.yaml",
    "badger/guardrails.yaml",
    "badger/checks.yaml",
    "badger/eval.yaml",
  ];
}

function authoringLanesScaffold(
  authoringPlan: ReturnType<typeof deriveAuthoringPlan> | undefined,
): Record<string, unknown> {
  const lanes = authoringPlan
    ? authoringPlan.lanes.map((lane) => ({
        id: lane.id,
        dependencies: lane.dependencies,
        claims: [...lane.claims, ...lane.derivedClaims],
        contentLeaves: lane.contentLeaves,
        status: "PENDING",
      }))
    : authoringLaneIds().map((id) => ({
        id,
        dependencies: [...authoringLaneDependencies(id)],
        claims: [],
        contentLeaves: [],
        status: "LEGACY",
      }));
  return {
    schemaVersion: 1,
    kind: "badger-authoring-lanes",
    authoringProtocolHash:
      authoringPlan?.protocolHash ?? AUTHORING_PROTOCOL_HASH,
    authoringPlanHash: authoringPlan?.authoringPlanHash ?? null,
    workflowProtocolHash: authoringPlan?.workflowProtocolHash ?? null,
    sourceEvidenceHash: authoringPlan?.sourceEvidenceHash ?? null,
    status: authoringPlan ? "pending" : "legacy",
    dag: {
      wave1: [...authoringDag().wave1],
      wave2: [...authoringDag().wave2],
      barrier: [...authoringDag().barrier],
    },
    controlPlane: {
      authority: "Badger assembler",
      scripts: authoringProtocolProjection().controlPlaneScripts.map(
        (script) => ({ ...script }),
      ),
      deterministicBackbone: [
        ...authoringProtocolProjection().deterministicBackbone,
      ],
      distinction: {
        plan: "badger-plan.mjs inspects the normalized WorkflowProtocol without mutating state.",
        check:
          "badger-check.mjs validates generated package completeness and assembled authoring status.",
        hook: "badger-hook-guard.mjs enforces the active WorkflowRuntime hook boundary.",
      },
    },
    lanes,
  };
}

function skillDefinition(proposal: FactoryProposal): Record<string, unknown> {
  const nodes = activeNodes(proposal);
  return {
    apiVersion: "badger/v1alpha1",
    kind: "Skill",
    metadata: {
      name: proposal.name,
      version: "1.0.0",
      description: `Run the ${proposal.name} workflow for ${proposal.goal.replace(/[.!?]+$/u, "")}.`,
    },
    goal: {
      statement: proposal.workflow.goal,
      inputs: [],
      outputs: [{ name: "result", description: "Generated workflow result" }],
      success: [
        "The generated workflow completes according to its WorkflowRuntime protocol",
      ],
    },
    orchestration: {
      mode: "deterministic",
    },
    skills: nodes.map((node) => ({
      id: nodeSkillName(proposal.name, node.id),
    })),
    agents: [],
    tools: [],
  };
}

function guardrailDefinition(
  proposal: FactoryProposal,
): Record<string, unknown> {
  return {
    allowedSkills: [
      proposal.name,
      ...activeNodes(proposal).map((node) =>
        nodeSkillName(proposal.name, node.id),
      ),
    ],
    allowedAgents: [],
    allowedTools: [],
    maxIterations: Math.max(activeNodes(proposal).length * 4 + 4, 8),
    maxRetriesPerAction: 2,
    confirmationRequiredFor: [],
  };
}

function runtimeChecks(): Record<string, unknown> {
  return {
    runtime: [
      {
        id: "workflow-complete",
        scope: "completion",
        type: "state_equals",
        field: "status",
        equals: "completed",
      },
    ],
  };
}

function evalManifest(proposal: FactoryProposal): Record<string, unknown> {
  return {
    apiVersion: "badger.eval/v1alpha1",
    kind: "SkillEvalManifest",
    metadata: { name: proposal.name },
    skill: { name: proposal.name, source: "." },
    evaluation: {
      tasks: [
        "authoring-assembly",
        "workflow-route-conformance",
        WORKFLOW_RUNTIME_CERTIFICATION_TASK,
      ],
      controlPlaneScripts:
        authoringProtocolProjection().controlPlaneScripts.map((script) => ({
          id: script.id,
          path: script.path,
          claim: script.claim,
          kind: script.kind,
        })),
    },
  };
}

function badgerPlanScript(): string {
  return `#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(packageRoot, "reference", "workflow-protocol.json");

function fail(message) {
  throw new Error(message);
}

const protocol = JSON.parse(await fs.readFile(protocolPath, "utf8"));
if (protocol.schemaVersion !== 1 || protocol.kind !== "workflow-kernel" || !Array.isArray(protocol.nodes)) {
  fail("workflow-protocol.json must use the current workflow-kernel schema");
}
const nodes = protocol.nodes.filter((node) => !node.disabled);
console.log(JSON.stringify({
  schemaVersion: 1,
  kind: "badger-workflow-plan",
  workflow: protocol.name,
  protocolPath: "reference/workflow-protocol.json",
  workflowProtocol: protocol,
  nodes: nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    implementation: node.implementation,
    requiredSkillCalls: node.requiredSkillCalls ?? [],
    outputSchemas: node.outputSchemas ?? [],
  })),
}, null, 2));
`.replaceAll("\\n", "\n");
}

function badgerHookGuardScript(): string {
  return `#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const event = process.argv[2] ?? "before_tool";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = process.env.BADGER_RUN_ROOT
  ? path.resolve(process.env.BADGER_RUN_ROOT)
  : process.cwd();
const protocolPath = path.join(packageRoot, "reference", "workflow-protocol.json");

function fail(message) {
  throw new Error(message);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function statePath(protocol) {
  const value = String(protocol.state?.statePath ?? "");
  const portable = value.replaceAll("\\\\", "/");
  if (!value || portable.startsWith("/") || portable.split("/").includes("..")) fail("workflow state path must be project-relative");
  const target = path.resolve(runRoot, value);
  if (!isWithin(runRoot, target)) fail("workflow state path must remain inside the run root");
  return target;
}

const protocol = JSON.parse(await fs.readFile(protocolPath, "utf8"));
if (protocol.schemaVersion !== 1 || protocol.kind !== "workflow-kernel" || !Array.isArray(protocol.nodes)) fail("workflow-protocol.json must use the current workflow-kernel schema");
const file = statePath(protocol);
const stats = await fs.lstat(file).catch(() => null);
if (!stats || !stats.isFile() || stats.isSymbolicLink()) fail("workflow state must be a regular file");
const state = JSON.parse(await fs.readFile(file, "utf8"));
if (state.workflow !== protocol.name) fail("workflow state does not match this workflow protocol");
if (state.status !== "running" && state.status !== "waiting") fail("workflow is not active; current status is " + String(state.status));
const nodes = protocol.nodes.filter((node) => !node.disabled);
const completed = new Set(Array.isArray(state.completedNodes) ? state.completedNodes : []);
const current = state.currentNode ?? nodes.find((node) => !completed.has(node.id))?.id ?? null;
if (!current || !nodes.some((node) => node.id === current)) fail("workflow state has no valid current Node");
console.log("workflow-hook-guard-ok");
console.log("EVENT: " + event);
console.log("NODE: " + current);
`.replaceAll("\\n", "\n");
}

function badgerCheckScript(
  proposal: FactoryProposal,
  hasAuthoringPlan: boolean,
  hasSourceEvidence: boolean,
  sourcePaths: readonly string[],
): string {
  const required = generatedPackagePaths(
    proposal,
    hasAuthoringPlan,
    hasSourceEvidence,
  );
  const expectedScripts = authoringProtocolProjection().controlPlaneScripts.map(
    (script) => ({
      ...script,
    }),
  );
  return `#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ${JSON.stringify(required, null, 2)};
const expectedScripts = ${JSON.stringify(expectedScripts, null, 2)};
const sourcePaths = new Set(${JSON.stringify(sourcePaths, null, 2)});

function fail(message) {
  throw new Error(message);
}

async function readRegular(relative) {
  const file = path.join(packageRoot, relative);
  const stats = await fs.lstat(file).catch(() => null);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) fail("Missing generated package file: " + relative);
  return fs.readFile(file, "utf8");
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const next = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) fail("Generated package contains a symbolic link: " + next);
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
    else fail("Generated package contains a special file: " + next);
  }
  return files;
}

for (const relative of required) await readRegular(relative);
const protocol = JSON.parse(await readRegular("reference/workflow-protocol.json"));
if (protocol.schemaVersion !== 1 || protocol.kind !== "workflow-kernel" || !Array.isArray(protocol.nodes)) fail("workflow-protocol.json is invalid");
const lanes = JSON.parse(await readRegular("reference/authoring-lanes.json"));
if (lanes.status !== "assembled") fail("authoring lanes are not assembled");
if (JSON.stringify(lanes.controlPlane?.scripts ?? []) !== JSON.stringify(expectedScripts)) fail("Badger control-plane script mapping is invalid");
const inventory = JSON.parse(await readRegular("reference/package-inventory.json"));
if (inventory.status !== "assembled") fail("package inventory is not assembled");
const inventoryPaths = new Set((inventory.files ?? []).map((file) => file.path));
for (const relative of required) if (!inventoryPaths.has(relative)) fail("Package inventory is missing: " + relative);
const actualPaths = await listFiles(packageRoot);
const expectedPaths = new Set(required);
for (const relative of actualPaths) {
  if (!inventoryPaths.has(relative)) fail("Package inventory is missing: " + relative);
  if (!expectedPaths.has(relative) && !sourcePaths.has(relative)) fail("Unexpected generated package file: " + relative);
}
for (const relative of inventoryPaths) {
  if (!actualPaths.includes(relative)) fail("Package inventory contains a missing file: " + relative);
}
for (const relative of required.filter((file) => file.endsWith(".md"))) {
  if ((await readRegular(relative)).includes("AUTHORING PENDING")) fail("Pending authoring marker remains: " + relative);
}
console.log("badger-package-check-ok");
`.replaceAll("\\n", "\n");
}

export async function inventoryPackage(
  root: string,
  authoredPaths: readonly string[] = [],
): Promise<GeneratedPackageFile[]> {
  const authored = new Set(authoredPaths.map(packageRelativePath));
  const files = await listFiles(root);
  return Promise.all(
    files.map(async (relativePath) => {
      const portablePath = relativePath.replaceAll("\\", "/");
      const content = await fs.readFile(path.join(root, relativePath));
      return {
        path: portablePath,
        bytes: content.byteLength,
        sha256: sha256(content),
        owner:
          portablePath.startsWith("source/") ||
          portablePath.startsWith("sources/")
            ? "source"
            : authored.has(portablePath)
              ? "authored"
              : "auto",
      } satisfies GeneratedPackageFile;
    }),
  ).then((entries) =>
    entries.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

export async function writePackageInventory(
  root: string,
  status: "scaffold" | "assembled",
  authoredPaths: readonly string[] = [],
): Promise<void> {
  const authored = new Set(authoredPaths.map(packageRelativePath));
  const files = [
    ...(await listFiles(root)).map((relativePath) =>
      relativePath.replaceAll("\\", "/"),
    ),
    "reference/package-inventory.json",
  ]
    .filter((relativePath, index, all) => all.indexOf(relativePath) === index)
    .sort();
  await atomicWrite(
    path.join(root, "reference", "package-inventory.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "badger-package-inventory",
        status,
        files: files.map((relativePath) => ({
          path: relativePath,
          owner:
            relativePath.startsWith("source/") ||
            relativePath.startsWith("sources/")
              ? "source"
              : authored.has(relativePath)
                ? "authored"
                : "auto",
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

async function writeScaffold(options: {
  proposal: FactoryProposal;
  plan: FactoryPlan;
  root: string;
  storedPaths: ProjectPathMappers;
  sourceEvidence?: UpgradeSourceEvidence;
  authoringDepth?: AuthoringDepth;
}): Promise<{
  authoringPlanPath: string;
  sourceRoot?: string;
  sourceHash?: string;
  sourceEvidencePath?: string;
  sourceEvidence?: UpgradeMigrationManifest;
}> {
  const root = path.resolve(options.root);
  const proposal = options.proposal;
  const authoringPlanPath = path.join(root, "reference", "authoring-plan.json");
  const authoringPlan = HASH_PATTERN.test(proposal.planHash)
    ? deriveAuthoringPlan({ proposal, depth: options.authoringDepth })
    : undefined;
  const sourcePaths = options.sourceEvidence
    ? options.sourceEvidence.files.flatMap((file) => [
        file.path,
        `source/${file.path}`,
      ])
    : [];
  if (options.sourceEvidence) {
    await fs.cp(options.sourceEvidence.root, root, {
      recursive: true,
      force: false,
    });
    await fs.rm(path.join(root, "source"), { recursive: true, force: true });
    await copyDirectory(options.sourceEvidence.root, path.join(root, "source"));
  }
  sourcePaths.push(...(await bundleSourceSkills(root, proposal.candidates)));
  const bundledRoots = new Map(
    proposal.candidates.flatMap((candidate) =>
      candidate.sources.map((source) => [
        source.root,
        bundledSourceRoot(source.hash),
      ]),
    ),
  );
  const packagePaths: ProjectPathMappers = {
    ...options.storedPaths,
    source: (value) =>
      bundledRoots.get(value) ?? options.storedPaths.source(value),
  };
  await ensureDirectory(path.join(root, "reference"));
  await ensureDirectory(path.join(root, "badger"));
  await ensureDirectory(path.join(root, "scripts"));
  await atomicWrite(path.join(root, "SKILL.md"), entryMarkdown(proposal));
  await atomicWrite(
    path.join(root, "reference", "workflow-protocol.json"),
    JSON.stringify(proposal.workflow, null, 2) + "\n",
  );
  await atomicWrite(
    path.join(root, "reference", "resolved-skills.json"),
    JSON.stringify(
      proposal.candidates.map((candidate) =>
        mapCandidatePaths(candidate, packagePaths),
      ),
      null,
      2,
    ) + "\n",
  );
  if (authoringPlan) {
    await atomicWrite(
      authoringPlanPath,
      JSON.stringify(
        mapAuthoringPlanPaths(authoringPlan, packagePaths),
        null,
        2,
      ) + "\n",
    );
  }
  for (const lane of authoringLaneIds()) {
    const brief =
      authoringPlan?.lanes.find((item) => item.id === lane)?.brief ??
      authoringLaneBrief(lane);
    await atomicWrite(path.join(root, brief), await authoringReference(brief));
  }
  await atomicWrite(
    path.join(root, "reference", "authoring-lanes.json"),
    JSON.stringify(authoringLanesScaffold(authoringPlan), null, 2) + "\n",
  );
  await atomicWrite(
    path.join(root, "reference", "decision-points.md"),
    "# Decision Points\n\n<!-- AUTHORING PENDING -->\nNo decision points have been authored. Classify each candidate as a genuine user decision, automatic handling, a stop condition, or a manual handoff before adding guidance.\n",
  );
  await atomicWrite(
    path.join(root, "reference", "recovery.md"),
    "# Recovery\n\n<!-- AUTHORING PENDING -->\nNo authoring recovery guidance has been recorded. Resume from the persisted Creator and WorkflowRuntime state rather than conversation history.\n",
  );
  await atomicWrite(
    path.join(root, "reference", "skill-review.md"),
    "# Skill Review\n\n<!-- AUTHORING PENDING -->\nNo authoring review has been recorded. This scaffold is not authored, assembled, evaluated, or publishable.\n",
  );
  await atomicWrite(
    path.join(root, "reference", "composition-report.md"),
    authoringPlan
      ? `# Composition Report\n\nAuthoring evidence will be rendered here after the six lane records are validated.\n\n- Authoring Protocol: \`${authoringPlan.protocolHash}\`\n- Workflow Protocol: \`${authoringPlan.workflowProtocolHash}\`\n- Source evidence: \`${authoringPlan.sourceEvidenceHash}\`\n`
      : "# Composition Report\n\nThis legacy scaffold has no authoring plan.\n",
  );
  const sourceMigration = options.sourceEvidence
    ? createUpgradeMigrationManifest(
        options.sourceEvidence,
        generatedPackagePaths(proposal, Boolean(authoringPlan), true),
      )
    : undefined;
  if (sourceMigration) {
    await atomicWrite(
      path.join(root, "reference", "source-evidence.json"),
      JSON.stringify(
        mapUpgradeManifestPaths(sourceMigration, options.storedPaths),
        null,
        2,
      ) + "\n",
    );
  }
  for (const node of activeNodes(proposal)) {
    await atomicWrite(
      path.join(root, nodeSkillName(proposal.name, node.id), "SKILL.md"),
      nodeMarkdown(proposal.name, node),
    );
  }
  const evalDocument = evalManifest(proposal);
  await atomicWrite(
    path.join(root, "badger", "skill.yaml"),
    stringify(skillDefinition(proposal)),
  );
  await atomicWrite(
    path.join(root, "badger", "guardrails.yaml"),
    stringify(guardrailDefinition(proposal)),
  );
  await atomicWrite(
    path.join(root, "badger", "checks.yaml"),
    stringify(runtimeChecks()),
  );
  await atomicWrite(
    path.join(root, "badger", "eval.yaml"),
    stringify(evalDocument),
  );
  await atomicWrite(
    path.join(root, "reference", "eval-manifest.json"),
    JSON.stringify(evalDocument, null, 2) + "\n",
  );
  await atomicWrite(
    path.join(root, "scripts", "workflow-runtime.mjs"),
    await runtimeAsset("workflow-runtime.mjs"),
  );
  await atomicWrite(
    path.join(root, "scripts", "workflow-state.mjs"),
    await runtimeAsset("workflow-state.mjs"),
  );
  await atomicWrite(
    path.join(root, "scripts", "workflow-guard.mjs"),
    await runtimeAsset("workflow-guard.mjs"),
  );
  await atomicWrite(
    path.join(root, "scripts", "workflow-handoff.mjs"),
    await runtimeAsset("workflow-handoff.mjs"),
  );
  await atomicWrite(
    path.join(root, "scripts", "badger-plan.mjs"),
    badgerPlanScript(),
  );
  await atomicWrite(
    path.join(root, "scripts", "badger-check.mjs"),
    badgerCheckScript(
      proposal,
      Boolean(authoringPlan),
      Boolean(options.sourceEvidence),
      sourcePaths,
    ),
  );
  await atomicWrite(
    path.join(root, "scripts", "badger-hook-guard.mjs"),
    badgerHookGuardScript(),
  );
  await writePackageInventory(root, "scaffold");
  return {
    authoringPlanPath,
    ...(options.sourceEvidence
      ? { sourceRoot: options.sourceEvidence.root }
      : {}),
    ...(options.sourceEvidence
      ? { sourceHash: options.sourceEvidence.hash }
      : {}),
    ...(sourceMigration
      ? {
          sourceEvidencePath: path.join(
            root,
            "reference",
            "source-evidence.json",
          ),
        }
      : {}),
    ...(sourceMigration ? { sourceEvidence: sourceMigration } : {}),
  };
}

export async function generatePackage(options: {
  proposal: FactoryProposal;
  plan: FactoryPlan;
  destination: string;
  projectRoot: string;
  sourceRoots?: readonly string[];
  authoringDepth?: AuthoringDepth;
}): Promise<GeneratedPackage> {
  const root = path.resolve(options.destination);
  const sourceRoot = options.plan.sourceRoot
    ? path.resolve(options.projectRoot, options.plan.sourceRoot)
    : undefined;
  if (sourceRoot && isWithin(sourceRoot, root)) {
    throw new Error(
      "Generation destination must not be inside the upgrade source package",
    );
  }
  const sourceEvidence = sourceRoot
    ? await inspectUpgradeSource(sourceRoot, {
        projectRoot: options.projectRoot,
        roots: options.sourceRoots ?? [],
      })
    : undefined;
  if (
    sourceEvidence &&
    options.proposal.upgradeSource &&
    sourceEvidence.hash !== options.proposal.upgradeSource.hash
  ) {
    throw new Error(
      "The upgrade source changed since the proposal was built; rerun propose and init",
    );
  }
  if (sourceRoot) {
    await assertUpgradeDestinationOutsideSource(sourceRoot, root);
  }
  const proposal = sourceEvidence
    ? {
        ...options.proposal,
        sourceRoot,
        upgradeSource: sourceEvidence,
      }
    : options.proposal;
  await ensureDirectory(path.dirname(root));
  const stagingRoot = await fs.mkdtemp(
    path.join(path.dirname(root), `.${path.basename(root)}.scaffold-`),
  );
  let moved = false;
  try {
    const scaffold = await writeScaffold({
      proposal,
      plan: options.plan,
      root: stagingRoot,
      storedPaths: toStoredPaths(options.projectRoot),
      ...(sourceEvidence ? { sourceEvidence } : {}),
      ...(options.authoringDepth
        ? { authoringDepth: options.authoringDepth }
        : {}),
    });
    const scaffoldHash = await hashDirectory(stagingRoot);
    const inventory = await inventoryPackage(stagingRoot);
    await replaceDirectory(stagingRoot, root);
    moved = true;
    return {
      packageRoot: root,
      protocolPath: path.join(root, "reference", "workflow-protocol.json"),
      evalPath: path.join(root, "badger", "eval.yaml"),
      authoringPlanPath: scaffold.authoringPlanPath.replace(stagingRoot, root),
      scaffoldHash,
      inventory,
      ...(sourceRoot ? { sourceRoot } : {}),
      ...(sourceEvidence ? { sourceHash: sourceEvidence.hash } : {}),
      ...(scaffold.sourceEvidencePath
        ? {
            sourceEvidencePath: scaffold.sourceEvidencePath.replace(
              stagingRoot,
              root,
            ),
          }
        : {}),
      ...(scaffold.sourceEvidence
        ? { sourceEvidence: scaffold.sourceEvidence }
        : {}),
    };
  } finally {
    if (!moved) await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
