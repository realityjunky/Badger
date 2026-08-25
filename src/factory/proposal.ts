import { promises as fs } from "node:fs";
import path from "node:path";
import type { FactoryPlan, FactoryProposal, SkillCandidate } from "../types.js";
import { findSkills } from "../skill/find.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { sha256 } from "../util.js";

export async function readPlan(file: string): Promise<FactoryPlan> {
  const value = JSON.parse(
    await fs.readFile(path.resolve(file), "utf8"),
  ) as FactoryPlan;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.goal ||
    !value.workflow ||
    !value.skillCreatorIntent
  )
    throw new Error(`Invalid Factory plan: ${file}`);
  if (value.skillCreatorIntent === "upgrade-existing" && !value.sourceRoot)
    throw new Error("upgrade-existing plans require sourceRoot");
  if (value.workflow.kind !== "workflow-kernel")
    throw new Error("Standalone Comet-any supports workflow-kernel plans only");
  return value;
}

export async function buildProposal(options: {
  projectRoot: string;
  planPath: string;
  homeDir?: string;
}): Promise<FactoryProposal> {
  const plan = await readPlan(options.planPath);
  const normalized = normalizeWorkflow(plan.workflow);
  const candidates = await findSkills({
    projectRoot: options.projectRoot,
    homeDir: options.homeDir,
    preferences: plan.preferredSkills.map((query, preferenceIndex) => ({
      query,
      preferenceIndex,
    })),
  });
  const blockers: string[] = [];
  for (const skill of candidates)
    if (skill.status !== "available")
      blockers.push(
        `Unresolved Skill candidate: ${skill.query} (${skill.status})`,
      );
  const sourceRoot = plan.sourceRoot
    ? path.resolve(options.projectRoot, plan.sourceRoot)
    : undefined;
  if (plan.skillCreatorIntent === "upgrade-existing" && sourceRoot) {
    try {
      await fs.access(path.join(sourceRoot, "SKILL.md"));
    } catch {
      blockers.push(`Upgrade source is not a Skill directory: ${sourceRoot}`);
    }
  }
  return {
    schemaVersion: 1,
    name: plan.workflow.name,
    goal: plan.goal,
    intent: plan.skillCreatorIntent,
    planHash: sha256(JSON.stringify(plan)),
    workflow: normalized.protocol,
    candidates,
    blockers,
    warnings:
      plan.skillCreatorIntent === "upgrade-existing"
        ? ["Upgrade mode copies the source package before generation."]
        : [],
    canInitialize: blockers.length === 0,
  };
}
