import { promises as fs } from "node:fs";
import path from "node:path";
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

function entryMarkdown(proposal: FactoryProposal): string {
  const descriptionGoal = proposal.goal.replace(/[.!?]+$/u, "");
  const nodes = proposal.workflow.nodes
    .filter((node) => !node.disabled)
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
  return `---\nname: ${proposal.name}\ndescription: ${JSON.stringify(`Run the ${proposal.name} workflow: ${descriptionGoal}.`)}\n---\n\n# ${proposal.workflow.name}\n\n## Decision Core\n\nRead the workflow protocol and persisted run state before selecting a Node. Resolve the requested route from the preparation and scenario evidence, follow only transitions declared by the protocol, execute exactly one Node at a time, and pause when evidence or a guardrail is missing. A completed handoff may start another cycle only through an explicit transition back to scenario selection.\n\n## Workflow Routes\n\n${routes || "- **default**: follow the active Node order in the workflow protocol."}\n\n## Workflow Nodes\n\n${nodes}\n\n## Runtime contract\n\n- Protocol: \`reference/workflow-protocol.json\`\n- Resolved source evidence: \`reference/resolved-skills.json\`\n- State: \`${proposal.workflow.state.statePath}\`\n- Eval manifest: \`comet/eval.yaml\`\n`;
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
  return `---\nname: ${nodeSkillName(workflow, node.id)}\ndescription: ${JSON.stringify(`Execute the ${node.label} Node of ${workflow}.`)}\n---\n\n# ${node.label}\n\nResponsibility: ${node.responsibility}\n\n## Required bindings\n\n${required}\n\n## Evidence\n\n${schemas}\n\nRecord completion evidence before advancing to the next Node.\n`;
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
    evaluation: { tasks: ["workflow-route-conformance"] },
  };
  await atomicWrite(
    path.join(root, "comet", "eval.yaml"),
    `apiVersion: comet.eval/v1alpha1\nkind: SkillEvalManifest\nmetadata:\n  name: ${proposal.name}\nskill:\n  name: ${proposal.name}\n  source: ..\nevaluation:\n  tasks:\n    - workflow-route-conformance\n`,
  );
  await atomicWrite(
    path.join(root, "reference", "eval-manifest.json"),
    JSON.stringify(evalManifest, null, 2) + "\n",
  );
  return {
    packageRoot: root,
    protocolPath: path.join(root, "reference", "workflow-protocol.json"),
    evalPath: path.join(root, "comet", "eval.yaml"),
  };
}
