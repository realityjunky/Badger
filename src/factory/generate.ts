import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryPlan, FactoryProposal, NodeProtocol } from "../types.js";
import {
  copyDirectory,
  ensureDirectory,
  hashDirectory,
  isWithin,
  slug,
  atomicWrite,
} from "../util.js";
import { normalizeWorkflowRepairPolicy } from "../workflow-runtime/repair.js";
import { deriveAuthoringPlan } from "../authoring/plan.js";

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
  sourceRoot?: string;
  sourceHash?: string;
  assembledPackageHash?: string;
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
  return `---
name: ${proposal.name}
description: ${JSON.stringify(`Run the ${proposal.name} workflow: ${descriptionGoal}.`)}
---

# ${proposal.workflow.name}

## Decision Core

<!-- AUTHORING PENDING -->
**Not yet authored.** The workflow-entry lane must add the semantic Decision Core before this scaffold can be assembled. Until then, use the persisted WorkflowRuntime continuation for routing and do not treat this package as authored.

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
deterministic runtime and adapter behavior; it does not authorize biological
execution, package installation, Native-derived durability, or Primer Designer
migration.

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
    path.resolve(moduleDirectory, "../../assets/skills/badger", relativePath),
    path.resolve(
      moduleDirectory,
      "../../../assets/skills/badger",
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

export async function generatePackage(options: {
  proposal: FactoryProposal;
  plan: FactoryPlan;
  destination: string;
}): Promise<GeneratedPackage> {
  const root = path.resolve(options.destination);
  const sourceRoot = options.plan.sourceRoot
    ? path.resolve(options.plan.sourceRoot)
    : undefined;
  if (sourceRoot && isWithin(sourceRoot, root)) {
    throw new Error(
      "Generation destination must not be inside the upgrade source package",
    );
  }
  const sourceHash = sourceRoot ? await hashDirectory(sourceRoot) : undefined;
  await fs.rm(root, { recursive: true, force: true });
  await ensureDirectory(root);
  const proposal = options.proposal;
  if (options.plan.skillCreatorIntent === "upgrade-existing" && sourceRoot) {
    await fs.cp(sourceRoot, root, { recursive: true, force: false });
    await copyDirectory(sourceRoot, path.join(root, "source"));
  }
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
    JSON.stringify(proposal.candidates, null, 2) + "\n",
  );
  const authoringPlanPath = path.join(root, "reference", "authoring-plan.json");
  if (/^[a-f0-9]{64}$/u.test(proposal.planHash)) {
    const authoringPlan = deriveAuthoringPlan({ proposal });
    await atomicWrite(
      authoringPlanPath,
      JSON.stringify(authoringPlan, null, 2) + "\n",
    );
    for (const lane of authoringPlan.lanes) {
      await atomicWrite(
        path.join(root, lane.brief),
        await authoringReference(lane.brief),
      );
    }
    await atomicWrite(
      path.join(root, "reference", "authoring-lanes.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          authoringProtocolHash: authoringPlan.protocolHash,
          authoringPlanHash: authoringPlan.authoringPlanHash,
          workflowProtocolHash: authoringPlan.workflowProtocolHash,
          status: "pending",
          lanes: authoringPlan.lanes.map((lane) => ({
            id: lane.id,
            dependencies: lane.dependencies,
            status: "PENDING",
          })),
        },
        null,
        2,
      ) + "\n",
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
      `# Composition Report\n\nAuthoring evidence will be rendered here after the six lane records are validated.\n\n- Authoring Protocol: \`${authoringPlan.protocolHash}\`\n- Workflow Protocol: \`${authoringPlan.workflowProtocolHash}\`\n- Source evidence: \`${authoringPlan.sourceEvidenceHash}\`\n`,
    );
    if (sourceRoot && sourceHash) {
      await atomicWrite(
        path.join(root, "reference", "source-evidence.json"),
        JSON.stringify(
          { schemaVersion: 1, sourceRoot, sourceHash, preservedAt: "scaffold" },
          null,
          2,
        ) + "\n",
      );
    }
  }
  for (const node of proposal.workflow.nodes.filter((item) => !item.disabled)) {
    const directory = path.join(root, nodeSkillName(proposal.name, node.id));
    await ensureDirectory(directory);
    await atomicWrite(
      path.join(directory, "SKILL.md"),
      nodeMarkdown(proposal.name, node),
    );
  }
  const evalManifest = {
    apiVersion: "badger.eval/v1alpha1",
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
    path.join(root, "badger", "eval.yaml"),
    `apiVersion: badger.eval/v1alpha1\nkind: SkillEvalManifest\nmetadata:\n  name: ${proposal.name}\nskill:\n  name: ${proposal.name}\n  source: ..\nevaluation:\n  tasks:\n    - workflow-route-conformance\n    - ${WORKFLOW_RUNTIME_CERTIFICATION_TASK}\n`,
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
  const scaffoldHash = await hashDirectory(root);
  return {
    packageRoot: root,
    protocolPath: path.join(root, "reference", "workflow-protocol.json"),
    evalPath: path.join(root, "badger", "eval.yaml"),
    authoringPlanPath,
    scaffoldHash,
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(sourceHash ? { sourceHash } : {}),
  };
}
