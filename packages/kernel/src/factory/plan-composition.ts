import type { FactoryPlan, SkillSourceDeclaration } from "../types.js";
import { canonicalHash, canonicalJson } from "../util.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { parsePlan } from "../workflow-kernel/foundation.js";
import { compileWorkflowMap } from "./workflow-map.js";
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
    workflow: dossier.workingDossier?.content.contract
      ? compileWorkflowMap(
          dossier.workingDossier.content,
          dossier.workingDossier.pins,
          dossier.workflow.name,
          dossier.workflow.goal,
        )
      : {
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
              implementation: {
                skill: "",
                operation: "default",
                scope: "main",
              },
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

/** Surface legacy prose for human review without changing the stored Plan or its approval. */
export function legacyAttestationReferences(plan: FactoryPlan) {
  const references: { node: string; text: string }[] = [];
  for (const node of plan.workflow.customNodes) {
    const text = [
      node.responsibility,
      ...node.guardrails
        .filter((rule) => !rule.prerequisite)
        .map((rule) => rule.label),
    ];
    for (const statement of text) {
      if (
        /SCRIPT_EFFECTS_PENDING|uploader.{0,40}attest|script.effect.{0,35}(review|approv)|上传者.{0,20}(确认|审核)|脚本.{0,12}(影响|效果).{0,12}(审核|批准)/iu.test(
          statement,
        )
      )
        references.push({ node: node.id, text: statement });
    }
  }
  return references;
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
    if (
      input.dossier.workingDossier?.content.contract &&
      canonicalHash(deriveFactoryPlan(input).workflow) !==
        canonicalHash(plan.workflow)
    )
      findings.push({
        path: "workflow",
        message:
          "Revise the executable behavior in the workflow map and rebuild its Plan.",
      });
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
      for (const rule of node.guardrails) {
        if (rule.prerequisite === undefined) continue;
        const authority = rule.prerequisite;
        const supported =
          authority &&
          typeof authority === "object" &&
          ("platformRule" in authority
            ? Object.keys(authority).length === 1 &&
              ((authority.platformRule === "verification.verifierPin" &&
                !!rule.verification?.verifierPin) ||
                (authority.platformRule === "approvalRequirements" &&
                  !!node.approvalRequirements?.length))
            : input.dossier.confirmedUserFacts.some(
                (fact) =>
                  fact.id === authority.factId &&
                  fact.statement === authority.statement,
              ));
        if (!supported) {
          findings.push({
            path: `workflow.customNodes.${node.id}.guardrails.${rule.id}.prerequisite`,
            message:
              "A mandatory workflow prerequisite must cite the exact confirmed Dossier fact or the applicable verifier or approval requirement on this Node. Skill Library review status is advisory.",
          });
        }
      }
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
