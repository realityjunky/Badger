import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryPlan, FactoryProposal, NodeProtocol } from "../types.js";
import {
  copyDirectory,
  ensureDirectory,
  isWithin,
  slug,
  atomicWrite,
} from "../util.js";

function nodeSkillName(workflow: string, node: string): string {
  return `${slug(workflow) || "workflow"}-${slug(node) || "node"}`;
}

const WORKFLOW_RUNTIME_CERTIFICATION_TASK = "workflow-runtime-certification";

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
  const executableNodeOrder = executableNodeIds
    .map((nodeId) => `\`${nodeId}\``)
    .join(" → ");
  return `---
name: ${proposal.name}
description: ${JSON.stringify(`Run the ${proposal.name} workflow: ${descriptionGoal}.`)}
---

# ${proposal.workflow.name}

## Decision Core

Read the WorkflowRuntime continuation before entering a Node. The runtime owns route selection, pending actions, evidence submission, and state transitions. Load only the Node named by the persisted pending action and stop when the runtime reports a blocker.

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

Decision Nodes may declare bounded artifact and evidence scope entries. The
runtime captures only accepted version ids, hashes, and producer identities for
those entries when it creates the pending question. Generated scripts render
and forward that scope without exposing artifact contents or validating the
references themselves.

## Executable Node Order

Executable Node Order: ${executableNodeOrder || "(empty)"}

## Workflow Nodes

${nodes}

## Runtime Commands

- Check the authoritative run: \`node scripts/workflow-state.mjs status\`.
- Start a run only when status is \`not-started\`: \`node scripts/workflow-state.mjs init\`.
- Resume a persisted Run: \`node scripts/workflow-state.mjs resume\`.
- Read the persisted action and Node: \`node scripts/workflow-state.mjs next\`.
- Submit characterized Node evidence: \`node scripts/workflow-state.mjs record <node> '<json evidence>'\`.
- Supply physical updates under \`artifacts\` and explicit accepted version ids under \`artifactVersions\` in the record JSON.
- Submit a declared human decision: \`node scripts/workflow-state.mjs decide <node> '<json response>'\`.
- For branched workflows, include declared route values in the submission's top-level \`routing\` object; summaries and evidence do not select edges.
- Verify the generated protocol and runtime: \`node scripts/workflow-guard.mjs verify\`.
- Verify the current Node before entry: \`node scripts/workflow-guard.mjs entry <node>\`.
- Validate Node completion without advancing: \`node scripts/workflow-guard.mjs exit <node> '<json evidence>'\`.
- Apply validated completion explicitly: \`node scripts/workflow-guard.mjs exit <node> '<json evidence>' --apply\`.
- Validate and apply a decision through the runtime: \`node scripts/workflow-guard.mjs decision <node> '<json response>' --apply\`.
- Produce a read-only workflow handoff: \`node scripts/workflow-handoff.mjs --json\`.
- Rebuild a deleted or stale compatibility projection explicitly: \`node scripts/workflow-state.mjs status --rebuild --confirm legacy-state\`.
- Use \`COMET_RUN_ROOT\` or \`--run-root\` for a change-bound Run; use \`--project <dir> --run-id <id>\` for a standalone Run.

The state document at \`${proposal.workflow.state.statePath}\` is a derived compatibility projection. It is never used for routing or recovery and may be rebuilt from the authoritative Run.

## Certification boundary

\`comet-any eval\` runs current-hash WorkflowRuntime checks, including a
synthetic Phase 3 decision-and-cycle lifecycle. Passing evaluation proves only
deterministic runtime and adapter behavior; it does not authorize biological
execution, package installation, Native-derived durability, or Primer Designer
migration.

## Runtime Contract

- Reusable runtime: \`scripts/workflow-runtime.mjs\`
- Protocol: \`reference/workflow-protocol.json\`
- Resolved source evidence: \`reference/resolved-skills.json\`
- Eval manifest: \`comet/eval.yaml\`
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
  return `---\nname: ${nodeSkillName(workflow, node.id)}\ndescription: ${JSON.stringify(`Execute the ${node.label} Node of ${workflow}.`)}\n---\n\n# ${node.label}\n\nResponsibility: ${node.responsibility}\n\n## Required bindings\n\n${required}\n\n## Evidence\n\n${schemas}\n${decision}\nRecord completion evidence before advancing to the next Node.\n`;
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

export async function generatePackage(options: {
  proposal: FactoryProposal;
  plan: FactoryPlan;
  destination: string;
}): Promise<{ packageRoot: string; protocolPath: string; evalPath: string }> {
  const root = path.resolve(options.destination);
  if (options.plan.sourceRoot && isWithin(options.plan.sourceRoot, root)) {
    throw new Error(
      "Generation destination must not be inside the upgrade source package",
    );
  }
  await fs.rm(root, { recursive: true, force: true });
  await ensureDirectory(root);
  const proposal = options.proposal;
  if (
    options.plan.skillCreatorIntent === "upgrade-existing" &&
    options.plan.sourceRoot
  ) {
    await copyDirectory(options.plan.sourceRoot, root);
  }
  await ensureDirectory(path.join(root, "reference"));
  await ensureDirectory(path.join(root, "comet"));
  await ensureDirectory(path.join(root, "scripts"));
  await atomicWrite(path.join(root, "SKILL.md"), entryMarkdown(proposal));
  await atomicWrite(
    path.join(root, "reference", "workflow-protocol.json"),
    JSON.stringify(proposal.workflow, null, 2) + "\n",
  );
  await atomicWrite(
    path.join(root, "reference", "resolved-skills.json"),
    JSON.stringify(proposal.candidates, null, 2) + "\n",
  );
  for (const node of proposal.workflow.nodes.filter((item) => !item.disabled)) {
    const directory = path.join(root, nodeSkillName(proposal.name, node.id));
    await ensureDirectory(directory);
    await atomicWrite(
      path.join(directory, "SKILL.md"),
      nodeMarkdown(proposal.name, node),
    );
  }
  const evalManifest = {
    apiVersion: "comet.eval/v1alpha1",
    kind: "SkillEvalManifest",
    metadata: { name: proposal.name },
    skill: { name: proposal.name, source: root },
    evaluation: {
      tasks: [
        "workflow-route-conformance",
        WORKFLOW_RUNTIME_CERTIFICATION_TASK,
      ],
    },
  };
  await atomicWrite(
    path.join(root, "comet", "eval.yaml"),
    `apiVersion: comet.eval/v1alpha1\nkind: SkillEvalManifest\nmetadata:\n  name: ${proposal.name}\nskill:\n  name: ${proposal.name}\n  source: ..\nevaluation:\n  tasks:\n    - workflow-route-conformance\n    - ${WORKFLOW_RUNTIME_CERTIFICATION_TASK}\n`,
  );
  await atomicWrite(
    path.join(root, "reference", "eval-manifest.json"),
    JSON.stringify(evalManifest, null, 2) + "\n",
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
  return {
    packageRoot: root,
    protocolPath: path.join(root, "reference", "workflow-protocol.json"),
    evalPath: path.join(root, "comet", "eval.yaml"),
  };
}
