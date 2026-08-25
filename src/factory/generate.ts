import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type {
  FactoryPlan,
  FactoryProposal,
  NodeProtocol,
  WorkflowProtocol,
} from "../types.js";
import { buildAuthoringPlan } from "../authoring/lifecycle.js";
import {
  atomicWrite,
  copyDirectory,
  ensureDirectory,
  isWithin,
  sha256,
  slug,
} from "../util.js";

export interface GeneratedPackage {
  bundleRoot: string;
  packageRoot: string;
  protocolPath: string;
  evalPath: string;
  authoringPlanPath: string;
}

function nodeSkillName(workflow: string, node: string): string {
  return `${slug(workflow) || "workflow"}-${slug(node) || "node"}`;
}

function route(protocol: WorkflowProtocol): NodeProtocol[] {
  return protocol.nodes.filter((node) => !node.disabled);
}

function entryName(proposal: FactoryProposal): string {
  return slug(proposal.name) || "workflow";
}

function entryDescription(proposal: FactoryProposal): string {
  const purpose = proposal.goal
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?。！？]+$/u, "");
  return `Use when the user wants the ${proposal.name} managed workflow for ${purpose}, explicitly invokes /${proposal.name}, or persisted workflow state identifies one unambiguous active run. Route through this entry Skill; do not invoke its internal Node Skills directly.`;
}

function nodeDescription(
  proposal: FactoryProposal,
  node: NodeProtocol,
): string {
  const name = nodeSkillName(proposal.name, node.id);
  return `Use only when explicitly invoked as /${name} or routed by the ${proposal.name} entry/runtime to the ${node.id} Node; complete ${node.label} for ${proposal.workflow.name}. Do not use for ordinary standalone tasks or as the workflow entry.`;
}

function checkId(
  kind: "required-skill" | "augmentation",
  node: NodeProtocol,
  skill: string,
): string {
  return `${kind}:${node.id}.${skill}`;
}

function entrySkill(proposal: FactoryProposal): string {
  const protocol = proposal.workflow;
  const nodes = route(protocol);
  const lines = nodes
    .map((node, index) => {
      const required = node.requiredSkillCalls.length
        ? ` Required Skills: ${node.requiredSkillCalls.map((item) => `\`${item.skill}\``).join(", ")}.`
        : "";
      const augmentations = node.augmentations.length
        ? ` Augmentations: ${node.augmentations.map((item) => `\`${item.skill}\` (${item.enforcement})`).join(", ")}.`
        : "";
      const schemas = node.outputSchemas.length
        ? ` Output Schemas: ${node.outputSchemas.map((item) => `\`${item}\``).join(", ")}.`
        : "";
      return `${index + 1}. \`${nodeSkillName(protocol.name, node.id)}\` - ${node.label} (${node.kind}). Responsibility: ${node.responsibility}${required}${augmentations}${schemas}`;
    })
    .join("\n");
  const bindings = nodes
    .map(
      (node) =>
        `- \`${node.id}\`: implementation \`${node.implementation.skill}\` (${node.implementation.operation}); required calls ${node.requiredSkillCalls.map((item) => `\`${item.skill}\``).join(", ") || "none"}; augmentations ${node.augmentations.map((item) => `\`${item.skill}\` (${item.enforcement})`).join(", ") || "none"}.`,
    )
    .join("\n");
  const guardrails = nodes
    .flatMap((node) =>
      node.guardrails.map(
        (item) =>
          `- \`${node.id}.${item.id}\`: ${item.label} (${item.validation}).`,
      ),
    )
    .join("\n");
  return `---
name: ${proposal.name}
description: ${JSON.stringify(entryDescription(proposal))}
---

# ${protocol.name}

## Decision Core

<!-- AUTHORING PENDING -->
**Not yet authored.** The Decision Core for this entry — how to detect the current Node, when to pause for the user, and the red flags — must be authored by the workflow-entry lane. Until then, rely on \`workflow-state.mjs next\` for routing and treat the rest of this file as scaffold only.

## Workflow Nodes

${lines}

## Skill Bindings

${bindings || "- No Skill bindings."}

## Guardrails And Evidence

${guardrails || "- No explicit guardrails."}

## Workflow References

- Route, Output Schemas, required Skill calls, and recovery state: \`reference/workflow-protocol.json\`.
- Resolved source Skill evidence and composition provenance: \`reference/resolved-skills.json\`.

## Runtime And Recovery

### Startup Protocol

1. Run \`node ${proposal.name}/scripts/workflow-state.mjs status\` to read current state.
2. If the workflow is not started, confirm scope with the user, then run \`node ${proposal.name}/scripts/workflow-state.mjs init\`.
3. Run \`node ${proposal.name}/scripts/workflow-state.mjs next\` and load **only** the returned Skill. Do not load multiple Skills at once.

### Resume Rules (every context resume)

- **Re-detect from scratch**: on every context resume, re-run the Startup Protocol. Do not trust conversation history for current-Node detection — context compaction may have discarded critical state.
- **Trust files over state**: if the script says a Node is DONE but its expected artifacts or evidence are missing, treat the Node as incomplete and re-enter it. File evidence is the source of truth.
- **Drift handling**: if the user's request belongs to a different Node than the one returned by \`next\`, pause and confirm which Node to enter. Do not silently follow the script if the user's intent conflicts.

### Node Boundary Rules

- Before leaving a Node, run \`node ${proposal.name}/scripts/workflow-guard.mjs exit <node> --apply\` to advance state and record evidence.
- If the guard fails, do not proceed — present the guard output and ask the user how to fix it.
- If the user wants to redo a completed Node, reset its completion state and re-enter rather than creating a parallel path.

The route, Output Schemas, required Skill calls, and recovery state are defined by \`reference/workflow-protocol.json\`.
`;
}

function schemaText(protocol: WorkflowProtocol, node: NodeProtocol): string {
  if (!node.outputSchemas.length)
    return "- This Node has no declared Output Schema.";
  return node.outputSchemas
    .map((id) => {
      const schema = protocol.outputSchemas.find((item) => item.id === id);
      if (!schema) return `- \`${id}\` (missing schema definition)`;
      const evidence = schema.evidence
        .filter((item) => item.required)
        .map((item) => `\`${item.id}\``)
        .join(", ");
      const artifacts = schema.artifacts
        .filter((item) => item.required)
        .map(
          (item) =>
            `\`${item.id}\` at ${item.paths.map((value) => `\`${value}\``).join(" or ")}`,
        )
        .join("; ");
      return `- \`${schema.id}\`: ${schema.description} Required evidence: ${evidence || "none"}. Required artifacts: ${artifacts || "none"}.`;
    })
    .join("\n");
}

function nodeSkill(proposal: FactoryProposal, node: NodeProtocol): string {
  const nodes = route(proposal.workflow);
  const next = nodes[nodes.findIndex((item) => item.id === node.id) + 1];
  const required = node.requiredSkillCalls.length
    ? node.requiredSkillCalls
        .map((item) => {
          const check = checkId("required-skill", node, item.skill);
          const reason = item.reason ? ` Reason: ${item.reason}` : "";
          if (item.scope === "handoff")
            return `- When delegating this Node, the handoff prompt must require loading \`${item.skill}\` and returning evidence with completed check \`${check}\`.${reason}`;
          return `- Load \`${item.skill}\` during this Node and record completed check \`${check}\`.${reason}`;
        })
        .join("\n")
    : "- This Node has no extra required Skill calls.";
  const augmentations = node.augmentations.length
    ? node.augmentations
        .map(
          (item) =>
            `- \`${item.skill}\` (${item.scope}, ${item.enforcement}): record completed check \`${checkId("augmentation", node, item.skill)}\`.${item.reason ? ` Reason: ${item.reason}` : ""}`,
        )
        .join("\n")
    : "- This Node has no declared augmentations.";
  const guards = node.guardrails.length
    ? node.guardrails
        .map((item) => `- \`${item.id}\`: ${item.label} (${item.validation}).`)
        .join("\n")
    : "- This Node has no explicit guardrails.";
  return `---
name: ${nodeSkillName(proposal.name, node.id)}
description: ${JSON.stringify(nodeDescription(proposal, node))}
---

# ${node.label}

## Node Goal

Complete the \`${node.id}\` Node for \`${proposal.workflow.name}\`.

Responsibility: ${node.responsibility}

## Guidance

<!-- AUTHORING PENDING -->
**Not yet authored.** This substance Node requires its decision content (prerequisites, step-by-step guidance, completion reasoning, red flags) from the skill-core lane. The control-plane sections below are scaffold only; they do not describe *how* to do this Node.

## Entry Check

\`\`\`bash
node ${proposal.name}/scripts/workflow-guard.mjs entry ${node.id}
\`\`\`

## Skill Implementation

Load \`${node.implementation.skill}\` for this Node. Operation: \`${node.implementation.operation}\`.

## Required Skill Calls

${required}

## Augmentations

${augmentations}

## Output Schemas

${schemaText(proposal.workflow, node)}

## Evidence Record

\`\`\`bash
node ${proposal.name}/scripts/workflow-state.mjs record ${node.id} '{"summary":"record the real Node result","completedChecks":[]}'
\`\`\`

## Guardrails

${guards}

## Exit Check

\`\`\`bash
node ${proposal.name}/scripts/workflow-guard.mjs exit ${node.id} --apply
\`\`\`

${next ? `If the script prints \`SKILL: ${nodeSkillName(proposal.name, next.id)}\`, load that Skill next.` : "If the script prints `NEXT: done`, summarize the workflow evidence and stop."}

## Recovery

Read \`reference/workflow-protocol.json\` and the configured workflow state. Resume the first Node that is not listed in \`${proposal.workflow.state.completedNodesField}\`.
`;
}

function resolvedSkills(proposal: FactoryProposal): Record<string, unknown> {
  const resolved = proposal.candidates.map((candidate) => ({
    query: candidate.query,
    preferenceIndex: candidate.preferenceIndex,
    status: candidate.status,
    sources: candidate.sources.map((source) => ({
      name: source.name,
      preferenceIndex: candidate.preferenceIndex,
      platform: "codex",
      scope: source.origin === "global" ? "global" : "project",
      origin: source.origin === "global" ? "global" : "project",
      factory: { query: candidate.query },
      root: source.root,
      description: source.description,
      skillMd: source.skillMd,
      references: source.references,
      scripts: source.scripts,
      hash: source.hash,
    })),
  }));
  return {
    schemaVersion: 1,
    resolvedSkills: resolved,
    sourceSummaries: proposal.candidates.flatMap((candidate) =>
      candidate.sources.map((source) => ({
        name: source.name,
        query: candidate.query,
        description: source.description,
        platform: "codex",
        scope: source.origin === "global" ? "global" : "project",
        origin: source.origin,
        references: source.references,
      })),
    ),
    workflow: {
      kind: proposal.workflow.kind,
      nodes: proposal.workflow.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        implementation: node.implementation,
        requiredSkillCalls: node.requiredSkillCalls,
        outputSchemas: node.outputSchemas,
      })),
    },
    preference: { requiredSkills: [], warnings: [] },
  };
}

function compositionReport(proposal: FactoryProposal): string {
  const resolved = proposal.candidates.length
    ? proposal.candidates
        .map((item) => `- ${item.query}: ${item.status}`)
        .join("\n")
    : "- None";
  return `# Composition Report

## Workflow Contract

- Kind: ${proposal.workflow.kind}
- Nodes: ${proposal.workflow.nodes.length}
- Required Skill Calls: ${proposal.workflow.nodes.reduce((count, node) => count + node.requiredSkillCalls.length, 0)}
- Output Schemas: ${proposal.workflow.outputSchemas.map((item) => item.id).join(", ")}
- Wrapper classification: scaffold-blocked

## Source Skills

${proposal.candidates.map((item) => `- ${item.query}`).join("\n") || "- None"}

## Composition Steps

${proposal.candidates.length ? proposal.candidates.map((item, index) => `- step-${index + 1}: ${item.query} (atomic)`).join("\n") : "- None"}

## Resolved Skills

${resolved}

## Preferences

- Preference mode: not configured
- Preference hash: none
`;
}

function manifest(proposal: FactoryProposal): Record<string, unknown> {
  const entry = entryName(proposal);
  const nodes = route(proposal.workflow).map((node) =>
    nodeSkillName(proposal.name, node.id),
  );
  return {
    apiVersion: "comet/v1alpha1",
    kind: "SkillBundle",
    metadata: {
      name: proposal.name,
      version: "1.0.0",
      description: proposal.goal,
      defaultLocale: "en",
      locales: ["en"],
    },
    skills: [
      { id: entry, path: `skills/${entry}`, visibility: "entry" },
      ...nodes.map((id) => ({
        id,
        path: `skills/${id}`,
        visibility: "internal",
      })),
    ],
    resources: {
      rules: [
        {
          id: `${entry}-orchestration`,
          path: `rules/${entry}-orchestration.md`,
          mode: "always",
          required: true,
        },
      ],
      hooks: [
        {
          id: `${entry}-before-write-guard`,
          path: `hooks/${entry}-before-write-guard.yaml`,
        },
        {
          id: `${entry}-before-tool-guard`,
          path: `hooks/${entry}-before-tool-guard.yaml`,
        },
      ],
      references: [
        `skills/${entry}/reference/resolved-skills.json`,
        `skills/${entry}/reference/workflow-protocol.json`,
        `skills/${entry}/reference/decision-points.md`,
        `skills/${entry}/reference/recovery.md`,
        `skills/${entry}/reference/authoring-lanes.json`,
        `skills/${entry}/reference/skill-review.md`,
        `skills/${entry}/reference/composition-report.md`,
        `skills/${entry}/reference/subagents/script-author.md`,
      ],
      scripts: [
        ["comet-plan", "write"],
        ["comet-check", "read"],
        ["comet-hook-guard", "read"],
        ["workflow-state", "write"],
        ["workflow-guard", "read"],
        ["workflow-handoff", "read"],
      ].map(([id, sideEffect]) => ({
        id,
        path: `skills/${entry}/scripts/${id}.mjs`,
        sideEffect,
        runtime: "node",
      })),
      assets: [],
      agents: [],
    },
    platforms: {
      requires: ["skills", "scripts", "rules", "hooks", "references"],
      optional: [],
      overrides: [],
    },
    engine: { enabled: false },
  };
}

function orchestrationRule(entry: string): string {
  return `# ${entry} Orchestration

This Bundle is generated by the Comet Skill Creator and uses a portable control plane.

- Entry Skill: \`skills/${entry}/SKILL.md\`
- Plan script: \`skills/${entry}/scripts/comet-plan.mjs\`
- Check script: \`skills/${entry}/scripts/comet-check.mjs\`
- Hook guard script: \`skills/${entry}/scripts/comet-hook-guard.mjs\`
- Workflow state script: \`skills/${entry}/scripts/workflow-state.mjs\`
- Workflow guard script: \`skills/${entry}/scripts/workflow-guard.mjs\`
- Workflow handoff script: \`skills/${entry}/scripts/workflow-handoff.mjs\`

Run the generated Skill through its workflow protocol and keep resolved Skill evidence in \`skills/${entry}/reference/\`.
`;
}

function hook(event: "before_write" | "before_tool"): string {
  return `event: ${event}
matcher: ${event === "before_write" ? "Write|Edit" : '"*"'}
script: comet-hook-guard
failure: block
requiresConfirmation: false
`;
}

function script(lines: string[]): string {
  return `#!/usr/bin/env node\n${lines.join("\n")}\n`;
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

function checkScript(protocol: WorkflowProtocol): string {
  const required = [
    "SKILL.md",
    ...route(protocol).map(
      (node) => `../${nodeSkillName(protocol.name, node.id)}/SKILL.md`,
    ),
    "reference/resolved-skills.json",
    "reference/workflow-protocol.json",
    "reference/decision-points.md",
    "reference/recovery.md",
    "reference/authoring-lanes.json",
    "reference/skill-review.md",
    "reference/composition-report.md",
    "reference/subagents/script-author.md",
    "scripts/comet-plan.mjs",
    "scripts/comet-check.mjs",
    "scripts/comet-hook-guard.mjs",
    "scripts/workflow-state.mjs",
    "scripts/workflow-guard.mjs",
    "scripts/workflow-handoff.mjs",
    "comet/skill.yaml",
    "comet/guardrails.yaml",
    "comet/checks.yaml",
    "comet/eval.yaml",
  ];
  return `#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const required = ${JSON.stringify(required, null, 2)};

async function main() {
  const missing = [];
  for (const relative of required) {
    try {
      const stats = await fs.stat(path.join(packageRoot, relative));
      if (!stats.isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length > 0) {
    console.error('Missing required workflow contract files: ' + missing.join(', '));
    process.exit(1);
  }
  const protocol = JSON.parse(await fs.readFile(path.join(packageRoot, 'reference', 'workflow-protocol.json'), 'utf8'));
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    throw new Error('workflow-protocol.json must use the current schema with nodes');
  }
  console.log('workflow-contract-ok');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;
}

function handoffScript(): string {
  return `#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

async function main() {
  const protocol = JSON.parse(await fs.readFile(path.join(packageRoot, 'reference', 'workflow-protocol.json'), 'utf8'));
  console.log(JSON.stringify({
    workflow: protocol.name,
    nodes: protocol.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      requiredSkillCalls: node.requiredSkillCalls ?? [],
      augmentations: node.augmentations ?? [],
      outputSchemas: node.outputSchemas ?? [],
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;
}

function skillDefinition(proposal: FactoryProposal): Record<string, unknown> {
  const nodes = route(proposal.workflow);
  return {
    apiVersion: "comet/v1alpha1",
    kind: "Skill",
    metadata: {
      name: proposal.name,
      version: "1.0.0",
      description: entryDescription(proposal),
    },
    goal: {
      statement: proposal.workflow.goal,
      inputs: [],
      outputs: [{ name: "result", description: "Generated workflow result" }],
      success: [
        "The generated workflow completes according to its workflow protocol",
      ],
    },
    orchestration: {
      mode: "deterministic",
      entry: nodes[0] ? `node-1-${slug(nodes[0].id)}` : "complete",
      steps: nodes.length
        ? nodes.map((node, index) => ({
            id: `node-${index + 1}-${slug(node.id)}`,
            action: {
              type: "invoke_skill",
              ref: nodeSkillName(proposal.name, node.id),
            },
            ...(nodes[index + 1]
              ? { next: `node-${index + 2}-${slug(nodes[index + 1]!.id)}` }
              : {}),
          }))
        : [{ id: "complete", action: { type: "checkpoint" } }],
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
  const nodes = route(proposal.workflow).map((node) =>
    nodeSkillName(proposal.name, node.id),
  );
  return {
    allowedSkills: [proposal.name, ...nodes],
    allowedAgents: [],
    allowedTools: [],
    maxIterations: Math.max(nodes.length + 2, 5),
    maxRetriesPerAction: 2,
    confirmationRequiredFor: [],
  };
}

function evalDefinition(proposal: FactoryProposal): Record<string, unknown> {
  const nodes = route(proposal.workflow);
  const nodeSkills = nodes.map((node) => nodeSkillName(proposal.name, node.id));
  const schemas = new Map(
    proposal.workflow.outputSchemas.map((item) => [item.id, item]),
  );
  const expectedEvidence = nodes
    .flatMap((node) => [
      ...node.requiredSkillCalls.map((item) => ({
        node: node.id,
        check: checkId("required-skill", node, item.skill),
        enforcement: item.enforcement,
      })),
      ...node.augmentations.map((item) => ({
        node: node.id,
        check: checkId("augmentation", node, item.skill),
        enforcement: item.enforcement,
      })),
      ...node.outputSchemas.flatMap((schemaId) =>
        (schemas.get(schemaId)?.evidence ?? [])
          .filter((item) => item.required)
          .map((item) => ({
            node: node.id,
            check: `output-schema:${node.id}.${schemaId}.${item.id}`,
            schema: schemaId,
            evidence: item.id,
          })),
      ),
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const expectedArtifacts = nodes.flatMap((node) =>
    node.outputSchemas.flatMap((schemaId) =>
      (schemas.get(schemaId)?.artifacts ?? [])
        .filter((item) => item.required)
        .map((item) => ({
          node: node.id,
          schema: schemaId,
          artifact: item.id,
          paths: item.paths,
        })),
    ),
  );
  return {
    apiVersion: "comet.eval/v1alpha1",
    kind: "SkillEvalManifest",
    metadata: {
      name: proposal.name,
      description: entryDescription(proposal),
      draftHash: "<current-bundle-hash>",
    },
    skill: { name: proposal.name, source: "..", profile: "authoring-skill" },
    evaluation: {
      recommendedTasks: ["authoring-skill-smoke", "workflow-route-conformance"],
      baselineTreatments: ["CONTROL"],
      qualityGates: {
        minWeightedScore: 0.8,
        minPassAt1: 0.6,
        maxInstabilityGap: 0.4,
      },
      requiredOutputSchemas: [
        ...new Set(nodes.flatMap((node) => node.outputSchemas)),
      ],
      expectedEvidence,
      requiredSkills: [proposal.name, ...nodeSkills],
      generatedNodeSkills: nodeSkills,
      expectedArtifacts,
      routeConformance: {
        task: "workflow-route-conformance",
        expectedNodeOrder:
          proposal.workflow.evals[0]?.expectedNodeOrder ??
          nodes.map((node) => node.id),
      },
    },
    interaction: { mode: "none", maxTurns: 8 },
  };
}

async function writeArtifact(
  bundleRoot: string,
  packageRoot: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.resolve(packageRoot, relative);
  if (!isWithin(bundleRoot, target))
    throw new Error(`Generated artifact escapes Bundle root: ${relative}`);
  await atomicWrite(target, content);
}

export async function generatePackage(options: {
  proposal: FactoryProposal;
  plan: FactoryPlan;
  destination: string;
}): Promise<GeneratedPackage> {
  const bundleRoot = path.resolve(options.destination);
  if (options.plan.sourceRoot && isWithin(options.plan.sourceRoot, bundleRoot))
    throw new Error(
      "Generation destination must not be inside the upgrade source package",
    );
  await fs.rm(bundleRoot, { recursive: true, force: true });
  await ensureDirectory(bundleRoot);
  const entry = entryName(options.proposal);
  const packageRoot = path.join(bundleRoot, "skills", entry);
  if (
    options.plan.skillCreatorIntent === "upgrade-existing" &&
    options.plan.sourceRoot
  ) {
    await ensureDirectory(path.dirname(packageRoot));
    await copyDirectory(path.resolve(options.plan.sourceRoot), packageRoot);
  } else await ensureDirectory(packageRoot);

  const nodes = route(options.proposal.workflow);
  const manifestDocument = manifest(options.proposal);
  await atomicWrite(
    path.join(bundleRoot, "bundle.yaml"),
    stringify(manifestDocument),
  );
  await writeArtifact(
    bundleRoot,
    packageRoot,
    "SKILL.md",
    entrySkill(options.proposal),
  );
  for (const node of nodes)
    await writeArtifact(
      bundleRoot,
      packageRoot,
      `../${nodeSkillName(options.proposal.name, node.id)}/SKILL.md`,
      nodeSkill(options.proposal, node),
    );

  const protocol = options.proposal.workflow;
  const authoringPlan = buildAuthoringPlan(protocol, entry);
  const references: Array<[string, string]> = [
    [
      "reference/resolved-skills.json",
      JSON.stringify(resolvedSkills(options.proposal), null, 2) + "\n",
    ],
    [
      "reference/workflow-protocol.json",
      JSON.stringify(protocol, null, 2) + "\n",
    ],
    [
      "reference/decision-points.md",
      "# Workflow Decision Classification\n\nNo decision points have been authored. Do not infer that every Node or Output Schema requires confirmation. Classify each candidate as a genuine user decision, automatic handling, a stop condition, or a manual handoff; pause only when at least two valid choices change scope, behavior, accepted risk, or an irreversible outcome.\n",
    ],
    [
      "reference/recovery.md",
      `# Workflow Recovery\n\n- State model: \`${protocol.state.kind}\`\n- State path: \`${protocol.state.statePath}\`\n- Resume by reading the first incomplete Workflow Node.\n`,
    ],
    [
      "reference/authoring-lanes.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          protocolHash: sha256(JSON.stringify(protocol)),
          lanes: [
            { lane: "script" },
            { lane: "reference" },
            { lane: "pause-points" },
            { lane: "workflow-entry" },
            { lane: "skill-core" },
            { lane: "skill-review" },
          ],
          review: {
            passed: null,
            evidenceSource: "deterministic-check-only",
            voters: null,
            lenses: [],
            rounds: null,
            blockingFindings: [],
            warnings: ["No LLM authoring review recorded for this Bundle"],
          },
        },
        null,
        2,
      ) + "\n",
    ],
    [
      "reference/skill-review.md",
      "# Skill Review\n\nEvidence source: deterministic-check-only.\n\nNo LLM authoring review has been recorded for this Bundle yet. This file is an honest placeholder, not a review approval. Run the `/comet-any` skill-review lane and record its verdict via `comet creator authoring-record <name> --lane skill-review --file <review.json>` to replace this with a real multi-vote review summary.\n",
    ],
    ["reference/composition-report.md", compositionReport(options.proposal)],
    [
      "reference/subagents/script-author.md",
      "# Script Author Brief\n\nAuthor the script contract for one comet-any authoring lane. This is a portable role brief for platforms that do not support Claude Code custom agents.\n\n- Read the assigned workflow protocol and lane instructions.\n- Write only the assigned report path.\n- Do not publish, install, or run destructive commands.\n",
    ],
  ];
  for (const [relative, content] of references)
    await writeArtifact(bundleRoot, packageRoot, relative, content);

  const authoringPlanPath = path.join(
    path.dirname(path.dirname(bundleRoot)),
    "authoring",
    entry,
    "plan.json",
  );
  await atomicWrite(
    authoringPlanPath,
    JSON.stringify(authoringPlan, null, 2) + "\n",
  );

  const scripts: Array<[string, string]> = [
    ["scripts/comet-plan.mjs", script(["import './workflow-state.mjs';"])],
    ["scripts/comet-check.mjs", checkScript(protocol)],
    [
      "scripts/comet-hook-guard.mjs",
      await runtimeAsset("comet-hook-guard.mjs"),
    ],
    ["scripts/workflow-state.mjs", await runtimeAsset("workflow-state.mjs")],
    ["scripts/workflow-guard.mjs", await runtimeAsset("workflow-guard.mjs")],
    ["scripts/workflow-handoff.mjs", handoffScript()],
  ];
  for (const [relative, content] of scripts)
    await writeArtifact(bundleRoot, packageRoot, relative, content);

  await atomicWrite(
    path.join(bundleRoot, "rules", `${entry}-orchestration.md`),
    orchestrationRule(entry),
  );
  await atomicWrite(
    path.join(bundleRoot, "hooks", `${entry}-before-write-guard.yaml`),
    hook("before_write"),
  );
  await atomicWrite(
    path.join(bundleRoot, "hooks", `${entry}-before-tool-guard.yaml`),
    hook("before_tool"),
  );
  await writeArtifact(
    bundleRoot,
    packageRoot,
    "comet/skill.yaml",
    stringify(skillDefinition(options.proposal)),
  );
  await writeArtifact(
    bundleRoot,
    packageRoot,
    "comet/guardrails.yaml",
    stringify(guardrailDefinition(options.proposal)),
  );
  await writeArtifact(
    bundleRoot,
    packageRoot,
    "comet/checks.yaml",
    stringify({
      runtime: [
        {
          id: "completed",
          scope: "completion",
          type: "state_equals",
          field: "status",
          equals: "completed",
        },
      ],
    }),
  );
  await writeArtifact(
    bundleRoot,
    packageRoot,
    "comet/eval.yaml",
    stringify(evalDefinition(options.proposal)),
  );
  return {
    bundleRoot,
    packageRoot,
    protocolPath: path.join(packageRoot, "reference", "workflow-protocol.json"),
    evalPath: path.join(packageRoot, "comet", "eval.yaml"),
    authoringPlanPath,
  };
}
