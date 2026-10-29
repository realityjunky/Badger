import type { FactoryPlan, SkillSourceDeclaration } from "../types.js";
import { canonicalHash, canonicalJson } from "../util.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { parsePlan } from "../workflow-kernel/foundation.js";
import {
  validateDossierPlan,
  type QuestionnaireDiagnostic,
  type SemanticDossier,
} from "./questionnaire.js";

export interface PlanCompositionInput {
  workflowVersionId: string;
  dossierHash: string;
  dossier: SemanticDossier;
  skillSources: SkillSourceDeclaration[];
}

/** Bind identity by construction, leaving implementation choices for drafting. */
export function deriveFactoryPlan(input: PlanCompositionInput): FactoryPlan {
  const { dossier } = input;
  return structuredClone({
    schemaVersion: 1,
    goal: dossier.workflow.goal,
    skillCreatorIntent: dossier.workflow.intent,
    defaultLocale: dossier.workflow.defaultLocale,
    skillSources: input.skillSources,
    semanticDossier: dossier,
    ...(dossier.upgradeSource
      ? {
          sourceRoot: dossier.sources.find(
            (source) => source.id === dossier.upgradeSource!.sourceId,
          )?.location,
        }
      : {}),
    workflow: {
      kind: "workflow-kernel",
      name: dossier.workflow.name,
      goal: dossier.workflow.goal,
      customNodes: [...dossier.nodes]
        .sort((a, b) => a.order - b.order)
        .map((node) => ({
          id: node.id,
          label: node.id,
          kind: "action",
          responsibility: node.responsibility.summary,
          implementation: { skill: "", operation: "default", scope: "main" },
          operations: ["require", "augment", "override", "disable"],
          outputSchemas: [],
          guardrails: [],
        })),
      outputSchemas: [],
    },
  });
}

export interface PlanSnapshot {
  schemaVersion: 1;
  kind: "badger-plan-version";
  workflowVersionId: string;
  dossierHash: string;
  plan: FactoryPlan;
}

/** Preview incomplete edits too; only a candidate without findings may be stored. */
export function composeFactoryPlan(
  input: PlanCompositionInput,
  value: unknown,
) {
  const plan = structuredClone(value) as FactoryPlan;
  const findings: QuestionnaireDiagnostic[] = validateDossierPlan(
    input.dossier,
    plan,
  );
  try {
    parsePlan(plan, "plan version");
    const normalized = normalizeWorkflow(plan.workflow);
    const expectedIds = [...input.dossier.nodes]
      .sort((a, b) => a.order - b.order)
      .map((node) => node.id);
    if (
      canonicalHash(plan.workflow.customNodes.map((node) => node.id)) !==
      canonicalHash(expectedIds)
    )
      findings.push({
        path: "workflow.customNodes",
        message:
          "Keep exactly the dossier's ordered Node identities, including disabled declarations",
      });
    const sources = new Set(input.skillSources.map((source) => source.name));
    for (const node of normalized.protocol.nodes.filter(
      (node) => !node.disabled,
    )) {
      for (const [role, bindings] of [
        ["implementation", [node.implementation]],
        ["requiredSkillCalls", node.requiredSkillCalls],
        ["augmentations", node.augmentations],
      ] as const)
        for (const binding of bindings)
          if (!sources.has(binding.skill))
            findings.push({
              path: `workflow.customNodes.${node.id}.${role}`,
              message:
                "Choose an implementation or supporting Skill from the pinned sources",
            });
    }
  } catch (error) {
    findings.push({
      path: "factoryPlan",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    canonicalHash(plan?.semanticDossier ?? null) !==
    canonicalHash(input.dossier)
  )
    findings.push({
      path: "semanticDossier",
      message: "The plan must retain the exact approved Semantic dossier",
    });
  const sortedSources = (sources: SkillSourceDeclaration[]) =>
    [...sources].sort((a, b) => a.name.localeCompare(b.name));
  if (
    !Array.isArray(plan?.skillSources) ||
    !plan.skillSources.every(
      (source) =>
        source !== null &&
        typeof source === "object" &&
        typeof source.name === "string",
    ) ||
    canonicalHash(sortedSources(plan.skillSources)) !==
      canonicalHash(sortedSources(input.skillSources))
  )
    findings.push({
      path: "skillSources",
      message:
        "Keep the pinned source locations and script declarations unchanged",
    });
  const upgradeRoot = input.dossier.upgradeSource
    ? input.dossier.sources.find(
        (source) => source.id === input.dossier.upgradeSource!.sourceId,
      )?.location
    : undefined;
  if (plan?.sourceRoot !== upgradeRoot)
    findings.push({
      path: "sourceRoot",
      message: "Keep the dossier's pinned upgrade source",
    });
  const snapshot: PlanSnapshot = {
    schemaVersion: 1,
    kind: "badger-plan-version",
    workflowVersionId: input.workflowVersionId,
    dossierHash: input.dossierHash,
    plan,
  };
  return {
    snapshot,
    canonicalJson: canonicalJson(snapshot),
    hash: canonicalHash(snapshot),
    findings,
  };
}
export type PlanComposition = ReturnType<typeof composeFactoryPlan>;

/** The Agent's output contract is derived from the same approved inputs. */
export function factoryPlanDraftSchema(input: PlanCompositionInput) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "object",
        required: [
          "schemaVersion",
          "goal",
          "skillCreatorIntent",
          "defaultLocale",
          "skillSources",
          "semanticDossier",
          "workflow",
        ],
        properties: {
          schemaVersion: { const: 1 },
          goal: { const: input.dossier.workflow.goal },
          skillCreatorIntent: { const: input.dossier.workflow.intent },
          defaultLocale: { const: input.dossier.workflow.defaultLocale },
          skillSources: { const: input.skillSources },
          semanticDossier: { const: input.dossier },
          workflow: {
            type: "object",
            required: ["kind", "name", "goal", "customNodes"],
            properties: {
              kind: { const: "workflow-kernel" },
              name: { const: input.dossier.workflow.name },
              goal: { const: input.dossier.workflow.goal },
              customNodes: {
                type: "array",
                minItems: 1,
                items: { type: "object" },
              },
            },
          },
        },
      },
    },
  };
}
