import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type {
  FactoryPlan,
  FactoryProposal,
  NodeProtocol,
  WorkflowProtocol,
} from "../types.js";
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

function stateScript(): string {
  return script([
    "import { promises as fs } from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const command = process.argv[2] ?? 'status';",
    "const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "const runRoot = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd();",
    "const protocolPath = path.join(packageRoot, 'reference', 'workflow-protocol.json');",
    "const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');",
    "const route = (protocol) => (protocol.nodes ?? []).filter((node) => !node.disabled);",
    "const nodeName = (protocol, id) => (slug(protocol.name) || 'workflow') + '-' + (slug(id) || 'node');",
    "const statePath = (protocol) => { const value = String(protocol.state?.statePath ?? ''); if (!value || value.startsWith('/') || value.replaceAll('\\\\', '/').split('/').includes('..')) throw new Error('workflow state path must be project-relative'); return path.resolve(runRoot, value); };",
    "const readProtocol = async () => { const protocol = JSON.parse(await fs.readFile(protocolPath, 'utf8')); if (protocol.schemaVersion !== 1 || protocol.kind !== 'workflow-kernel' || !Array.isArray(protocol.nodes)) throw new Error('workflow-protocol.json must use the current schema with nodes'); return protocol; };",
    "const readState = async (protocol) => JSON.parse(await fs.readFile(statePath(protocol), 'utf8'));",
    "const writeState = async (protocol, state) => { const file = statePath(protocol); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file + '.tmp', JSON.stringify(state, null, 2) + '\\n', 'utf8'); await fs.rename(file + '.tmp', file); };",
    "const nextNode = (protocol, state) => { const completed = new Set(Array.isArray(state.completedNodes) ? state.completedNodes : []); return route(protocol).find((node) => !completed.has(node.id)) ?? null; };",
    "const printNext = (protocol, node) => node ? (console.log('NEXT: auto'), console.log('NODE: ' + node.id), console.log('SKILL: ' + nodeName(protocol, node.id))) : console.log('NEXT: done');",
    "const parseEvidence = (value) => { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }; } catch { return { summary: value }; } };",
    "try { const protocol = await readProtocol(); const nodes = route(protocol); if (!nodes.length) throw new Error('workflow protocol has no enabled nodes'); if (command === 'init') { const node = nextNode(protocol, { completedNodes: [] }); await writeState(protocol, { schemaVersion: 1, workflow: protocol.name, status: node ? 'running' : 'completed', currentNode: node?.id ?? null, completedNodes: [], evidence: {}, history: [] }); printNext(protocol, node); } else if (command === 'status') { try { console.log(JSON.stringify(await readState(protocol), null, 2)); } catch (error) { if (error?.code === 'ENOENT') console.log(JSON.stringify({ status: 'not-started' }, null, 2)); else throw error; } } else if (command === 'next') { printNext(protocol, nextNode(protocol, await readState(protocol))); } else if (command === 'record') { const nodeId = process.argv[3]; const node = nodes.find((item) => item.id === nodeId || nodeName(protocol, item.id) === nodeId); if (!node) throw new Error('Unknown workflow Node: ' + nodeId); const state = await readState(protocol); if (state.workflow !== protocol.name || state.status !== 'running' || state.currentNode !== node.id) throw new Error('workflow state is not at the requested Node'); state.evidence = state.evidence && typeof state.evidence === 'object' ? state.evidence : {}; state.history = Array.isArray(state.history) ? state.history : []; state.evidence[node.id] = { ...parseEvidence(process.argv.slice(4).join(' ')), recordedAt: new Date().toISOString() }; state.history.push({ event: 'evidence-recorded', node: node.id, at: new Date().toISOString() }); await writeState(protocol, state); console.log('EVIDENCE: ' + node.id); printNext(protocol, nextNode(protocol, state)); } else throw new Error('Unknown command: ' + command); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }",
  ]);
}

function guardScript(): string {
  return String.raw`#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const command = process.argv[2] ?? 'verify';
const nodeId = process.argv[3] ?? null;
const apply = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const runRoot = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd();
const protocolPath = path.join(packageRoot, 'reference', 'workflow-protocol.json');

function fail(message) {
  throw new Error(message);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function nodeName(protocol, id) {
  return (slug(protocol.name) || 'workflow') + '-' + (slug(id) || 'node');
}

function route(protocol) {
  return (protocol.nodes ?? []).filter((node) => !node.disabled);
}

function statePath(protocol) {
  const value = String(protocol.state?.statePath ?? '');
  const portable = value.replaceAll('\\', '/');
  if (!value || portable.startsWith('/') || portable.split('/').includes('..')) {
    fail('workflow state path must be project-relative');
  }
  return path.resolve(runRoot, value);
}

function schemaMap(protocol) {
  return new Map((protocol.outputSchemas ?? []).map((schema) => [schema.id, schema]));
}

function evidenceFor(state, id) {
  const value = state.evidence && typeof state.evidence === 'object' ? state.evidence[id] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function hasEvidenceField(evidence, id) {
  if (Object.prototype.hasOwnProperty.call(evidence, id)) return true;
  const schemaEvidence = evidence.schemaEvidence;
  return !!(
    schemaEvidence &&
    typeof schemaEvidence === 'object' &&
    !Array.isArray(schemaEvidence) &&
    Object.prototype.hasOwnProperty.call(schemaEvidence, id)
  );
}

function missingRequiredChecks(node, evidence) {
  const completed = Array.isArray(evidence.completedChecks) ? evidence.completedChecks : [];
  return [
    ...(node.requiredSkillCalls ?? []).map((binding) => 'required-skill:' + node.id + '.' + binding.skill),
    ...(node.augmentations ?? [])
      .filter((binding) => binding.enforcement !== 'advisory')
      .map((binding) => 'augmentation:' + node.id + '.' + binding.skill),
  ].filter((check) => !completed.includes(check));
}

function missingSchemaEvidence(protocol, node, evidence) {
  const schemas = schemaMap(protocol);
  const missing = [];
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const field of schema?.evidence ?? []) {
      if (field.required && !hasEvidenceField(evidence, field.id)) {
        missing.push(schemaId + '.' + field.id);
      }
    }
  }
  return missing;
}

function patternMatcher(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replaceAll('.', '\\.'))
    .join('.*');
  return new RegExp('^' + escaped + '$', 'u');
}

async function pathPatternExists(root, pattern) {
  const portable = String(pattern).replaceAll('\\', '/');
  if (!portable || portable.startsWith('/') || portable.split('/').includes('..')) {
    fail('workflow artifact path must be project-relative');
  }
  const parts = portable.split('/');
  async function walk(current, index) {
    if (index === parts.length) return true;
    const part = parts[index];
    if (!part.includes('*')) {
      const target = path.join(current, part);
      let stats;
      try {
        stats = await fs.lstat(target);
      } catch {
        return false;
      }
      if (stats.isSymbolicLink()) fail('workflow artifact path crosses a symbolic link');
      return walk(target, index + 1);
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    const matcher = patternMatcher(part);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail('workflow artifact path crosses a symbolic link');
      if (matcher.test(entry.name) && await walk(path.join(current, entry.name), index + 1)) return true;
    }
    return false;
  }
  return walk(root, 0);
}

async function missingRequiredArtifacts(protocol, node) {
  const schemas = schemaMap(protocol);
  const missing = [];
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const artifact of schema?.artifacts ?? []) {
      if (!artifact.required) continue;
      const present = await Promise.all(
        (artifact.paths ?? []).map((pattern) => pathPatternExists(runRoot, pattern)),
      );
      if (!present.some(Boolean)) missing.push(schemaId + '.' + artifact.id);
    }
  }
  return missing;
}

async function main() {
  const protocol = JSON.parse(await fs.readFile(protocolPath, 'utf8'));
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    fail('workflow-protocol.json must use the current schema with nodes');
  }
  if (command === 'verify') {
    console.log('workflow-guard-ok');
    return;
  }
  if (command !== 'entry' && command !== 'exit') fail('Unknown command: ' + command);
  if (!nodeId) fail(command + ' requires a Node id.');
  const node = route(protocol).find((item) => item.id === nodeId || nodeName(protocol, item.id) === nodeId);
  if (!node) fail('Unknown workflow Node: ' + nodeId);
  const file = statePath(protocol);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  if (state.workflow !== protocol.name) fail('workflow state does not match this workflow protocol');
  if (state.status !== 'running') fail('workflow is not running');
  if (command === 'entry') {
    const current = state.currentNode ?? route(protocol).find((item) => !state.completedNodes?.includes(item.id))?.id ?? null;
    if (current !== node.id && !state.completedNodes?.includes(node.id)) fail('BLOCKED: current Node is ' + String(current) + ', cannot enter ' + node.id + '.');
    console.log('ENTRY OK: ' + node.id);
    return;
  }
  if (state.currentNode !== node.id) fail('BLOCKED: current Node is ' + String(state.currentNode) + ', cannot exit ' + node.id + '.');
  const evidence = evidenceFor(state, node.id);
  if (!evidence) fail('BLOCKED: missing evidence for Node ' + node.id + '.');
  const missingSchema = missingSchemaEvidence(protocol, node, evidence);
  if (missingSchema.length) fail('BLOCKED: missing Output Schema evidence: ' + missingSchema.join(', '));
  const missingChecks = missingRequiredChecks(node, evidence);
  if (missingChecks.length) fail('BLOCKED: missing required Skill evidence: ' + missingChecks.join(', '));
  const missingArtifacts = await missingRequiredArtifacts(protocol, node);
  if (missingArtifacts.length) fail('BLOCKED: missing Output Schema artifacts: ' + missingArtifacts.join(', '));
  if (!apply) {
    console.log('ALL CHECKS PASSED');
    console.log('APPLY: rerun with --apply to update workflow state');
    return;
  }
  const completed = new Set(Array.isArray(state.completedNodes) ? state.completedNodes : []);
  completed.add(node.id);
  state.completedNodes = route(protocol).filter((item) => completed.has(item.id)).map((item) => item.id);
  const next = route(protocol).find((item) => !completed.has(item.id)) ?? null;
  state.currentNode = next?.id ?? null;
  state.status = next ? 'running' : 'completed';
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ event: 'exit-applied', node: node.id, at: new Date().toISOString() });
  await fs.writeFile(file + '.tmp', JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(file + '.tmp', file);
  console.log('ALL CHECKS PASSED');
  if (next) {
    console.log('NEXT: auto');
    console.log('NODE: ' + next.id);
    console.log('SKILL: ' + nodeName(protocol, next.id));
  } else {
    console.log('NEXT: done');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
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

  const scripts: Array<[string, string]> = [
    ["scripts/comet-plan.mjs", script(["import './workflow-state.mjs';"])],
    ["scripts/comet-check.mjs", checkScript(protocol)],
    [
      "scripts/comet-hook-guard.mjs",
      script([
        "import { promises as fs } from 'node:fs';",
        "import path from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const runRoot = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd(); const protocol = JSON.parse(await fs.readFile(path.join(packageRoot, 'reference', 'workflow-protocol.json'), 'utf8')); const stateValue = String(protocol.state?.statePath ?? ''); if (!stateValue || stateValue.startsWith('/') || stateValue.replaceAll('\\\\', '/').split('/').includes('..')) throw new Error('workflow state path must be project-relative'); const state = JSON.parse(await fs.readFile(path.resolve(runRoot, stateValue), 'utf8')); if (state.workflow !== protocol.name || state.status !== 'running') throw new Error('workflow is not running'); console.log('workflow-hook-guard-ok'); console.log('EVENT: ' + (process.argv[2] ?? 'before_tool')); console.log('NODE: ' + state.currentNode);",
      ]),
    ],
    ["scripts/workflow-state.mjs", stateScript()],
    ["scripts/workflow-guard.mjs", guardScript()],
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
  };
}
