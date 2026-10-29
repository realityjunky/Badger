import type { FactoryPlan } from "../types.js";
import path from "node:path";
import { sha256, stableValue } from "../util.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import {
  questionnaireRecordHandoff,
  type QuestionnaireRecords,
  type QuestionnaireRecordHandoff,
} from "./questionnaire-records.js";

export const SEMANTIC_DOSSIER_TOPICS = [
  "inputs",
  "prerequisites",
  "bindings",
  "interfaces",
  "requiredSkillCalls",
  "augmentations",
  "outputSchemas",
  "completionEvidence",
  "decisions",
  "guardrails",
  "routes",
  "boundedCycles",
  "capabilities",
  "finalization",
  "executableDisclosures",
  "recoveryPolicy",
] as const;

export interface SemanticFact {
  id: string;
  statement: string;
}

export interface AnswerRevision {
  answerId: string;
  revision: number;
}

export interface FactProvenance {
  confirmedBy: string;
  answerRevisions: AnswerRevision[];
  acknowledgedBy: string;
}

export interface QuestionBase {
  id: string;
  field: string;
  question: string;
}

export interface DeferredQuestion extends QuestionBase {
  resolution: {
    outcome: "deferred";
    scope: "skill" | "out-of-scope";
    skill?: string;
    reason: string;
  };
}

export interface SemanticTopic {
  summary: string;
  factIds: string[];
}

export interface SemanticDossier {
  schemaVersion: 2;
  kind: "semantic-dossier";
  confirmed: boolean;
  workflow: {
    name: string;
    goal: string;
    intent: "new-skill" | "upgrade-existing";
    defaultLocale: "en";
  };
  sources: Array<{
    id: string;
    name: string;
    location: string;
    canonicalPath: string;
    contentHash: string;
    roles: string[];
  }>;
  nodes: Array<{
    id: string;
    order: number;
    responsibility: SemanticTopic;
  }>;
  topics: Record<(typeof SEMANTIC_DOSSIER_TOPICS)[number], SemanticTopic>;
  confirmedUserFacts: Array<SemanticFact & { provenance: FactProvenance }>;
  sourceDerivedFacts: Array<
    SemanticFact & { sourceId: string; evidencePath: string }
  >;
  agentInferences: Array<
    SemanticFact & { confirmed: boolean; provenance?: FactProvenance }
  >;
  unresolvedAssumptions: Array<SemanticFact & { field: string }>;
  remainingQuestions: QuestionBase[];
  deferredQuestions: DeferredQuestion[];
  upgradeSource?: { sourceId: string; recovery: string };
}

export interface QuestionnaireDiagnostic {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSemanticDossier(
  value: unknown,
): QuestionnaireDiagnostic[] {
  const diagnostics: QuestionnaireDiagnostic[] = [];
  const report = (path: string, message: string) =>
    diagnostics.push({ path, message });
  if (!isRecord(value))
    return [{ path: "dossier", message: "Dossier must be an object" }];
  if (value.schemaVersion !== 2)
    report(
      "schemaVersion",
      value.schemaVersion === 1
        ? "Semantic dossier version 1 is retired; migrate the dossier to version 2"
        : "Expected semantic dossier version 2",
    );
  if (value.kind !== "semantic-dossier")
    report("kind", "Expected semantic-dossier");
  if (value.confirmed !== true)
    report("confirmed", "Workflow owner must confirm the dossier");
  if (!isRecord(value.workflow))
    report("workflow", "Workflow identity is required");
  else {
    for (const field of ["name", "goal"]) {
      if (!isText(value.workflow[field]))
        report(`workflow.${field}`, "Required nonempty text");
    }
    if (
      !["new-skill", "upgrade-existing"].includes(String(value.workflow.intent))
    )
      report("workflow.intent", "Invalid Creator intent");
    if (value.workflow.defaultLocale !== "en")
      report("workflow.defaultLocale", "Expected en");
  }
  const entries = (field: string): Record<string, unknown>[] => {
    const list = value[field];
    if (!Array.isArray(list)) {
      report(field, "Required array");
      return [];
    }
    const ids = new Set<string>();
    return list.filter((entry, index): entry is Record<string, unknown> => {
      if (!isRecord(entry)) {
        report(`${field}.${index}`, "Required object");
        return false;
      }
      if (!isText(entry.id) || ids.has(entry.id))
        report(`${field}.${index}.id`, "Required unique identity");
      else ids.add(entry.id);
      return true;
    });
  };
  const sources = entries("sources");
  for (const source of sources) {
    if (
      !isText(source.canonicalPath) ||
      !path.isAbsolute(source.canonicalPath) ||
      path.normalize(source.canonicalPath) !== source.canonicalPath ||
      source.canonicalPath.includes("\0")
    ) {
      report(
        `sources.${source.id}.canonicalPath`,
        "Canonical source path must be normalized and absolute",
      );
    }
    for (const field of ["name", "location", "canonicalPath"]) {
      if (!isText(source[field]))
        report(
          `sources.${source.id}.${field}`,
          "Required explicit source identity",
        );
    }
    if (
      typeof source.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(source.contentHash)
    )
      report(
        `sources.${source.id}.contentHash`,
        "Required SHA-256 source hash",
      );
    if (
      !Array.isArray(source.roles) ||
      !source.roles.length ||
      !source.roles.every(isText)
    )
      report(`sources.${source.id}.roles`, "Required source roles");
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourceNames = new Set(sources.map((source) => source.name));
  const ledgerIds = new Map<string, string>();
  const factIds = new Set<string>();
  const registerId = (
    id: unknown,
    path: string,
    category: string,
    fact: boolean,
  ) => {
    if (!isText(id)) return;
    const previous = ledgerIds.get(id);
    if (previous !== undefined && previous !== category)
      report(path, "Ledger IDs must be unique across categories");
    if (previous === undefined) ledgerIds.set(id, category);
    if (fact) factIds.add(id);
  };
  const validateFactProvenance = (provenance: unknown, path: string) => {
    if (!isRecord(provenance)) {
      report(
        path,
        "Required provenance: confirming person, answer revisions, and acknowledgement",
      );
      return;
    }
    if (!isText(provenance.confirmedBy))
      report(`${path}.confirmedBy`, "Required confirming person");
    if (
      !Array.isArray(provenance.answerRevisions) ||
      !provenance.answerRevisions.length ||
      !provenance.answerRevisions.every(
        (revision) =>
          isRecord(revision) &&
          isText(revision.answerId) &&
          typeof revision.revision === "number" &&
          Number.isInteger(revision.revision) &&
          revision.revision > 0,
      )
    )
      report(`${path}.answerRevisions`, "Required positive answer revisions");
    if (!isText(provenance.acknowledgedBy))
      report(
        `${path}.acknowledgedBy`,
        "Required acknowledgement by the answering Field expert",
      );
  };
  for (const category of [
    "confirmedUserFacts",
    "sourceDerivedFacts",
    "agentInferences",
    "unresolvedAssumptions",
    "remainingQuestions",
  ]) {
    const facts = entries(category);
    for (const fact of facts) {
      const prefix = `${category}.${fact.id}`;
      registerId(fact.id, `${prefix}.id`, category, true);
      if (
        !isText(
          fact[category === "remainingQuestions" ? "question" : "statement"],
        )
      )
        report(prefix, "Required statement or question");
      if (
        category === "sourceDerivedFacts" &&
        (!sourceIds.has(fact.sourceId) || !isText(fact.evidencePath))
      )
        report(
          prefix,
          "Source fact requires a declared source and evidence path",
        );
      if (category === "agentInferences" && fact.confirmed !== true)
        report(prefix, "Inference requires explicit user confirmation");
      if (
        category === "confirmedUserFacts" ||
        (category === "agentInferences" && fact.confirmed === true)
      )
        validateFactProvenance(fact.provenance, `${prefix}.provenance`);
      if (["unresolvedAssumptions", "remainingQuestions"].includes(category)) {
        if (!isText(fact.field))
          report(`${prefix}.field`, "Required unresolved field");
        report(prefix, "Unresolved or contradictory field prevents completion");
      }
    }
  }
  const deferredQuestions = entries("deferredQuestions");
  for (const question of deferredQuestions) {
    const prefix = `deferredQuestions.${question.id}`;
    registerId(question.id, `${prefix}.id`, "deferredQuestions", false);
    if (!isText(question.field))
      report(`${prefix}.field`, "Required deferred field");
    if (!isText(question.question))
      report(prefix, "Required deferred question");
    const resolution = question.resolution;
    if (
      !isRecord(resolution) ||
      resolution.outcome !== "deferred" ||
      !["skill", "out-of-scope"].includes(String(resolution.scope)) ||
      !isText(resolution.reason) ||
      (resolution.scope === "skill" &&
        (!isText(resolution.skill) || !sourceNames.has(resolution.skill)))
    )
      report(
        `${prefix}.resolution`,
        "A deferred question requires its resolution: deferred, with a reason and, for a Skill backlog, a declared Skill name",
      );
  }
  const topic = (entry: unknown, field: string) => {
    if (!isRecord(entry) || !isText(entry.summary)) {
      report(
        field,
        "Required semantic summary; explicitly explain non-applicability",
      );
      return;
    }
    if (
      !Array.isArray(entry.factIds) ||
      !entry.factIds.length ||
      !entry.factIds.every((id) => isText(id) && factIds.has(id))
    )
      report(`${field}.factIds`, "Required references to the fact ledger");
  };
  for (const field of SEMANTIC_DOSSIER_TOPICS)
    topic(
      isRecord(value.topics) ? value.topics[field] : undefined,
      `topics.${field}`,
    );
  const nodes = entries("nodes");
  if (!nodes.length)
    report("nodes", "At least one Node responsibility is required");
  const orders = new Set<number>();
  for (const node of nodes) {
    if (
      typeof node.order !== "number" ||
      !Number.isInteger(node.order) ||
      node.order < 0 ||
      orders.has(node.order)
    )
      report(
        `nodes.${node.id}.order`,
        "Required unique nonnegative Node order",
      );
    else orders.add(node.order);
    topic(node.responsibility, `nodes.${node.id}.responsibility`);
  }
  if (
    isRecord(value.workflow) &&
    value.workflow.intent === "upgrade-existing"
  ) {
    if (
      !isRecord(value.upgradeSource) ||
      !sourceIds.has(value.upgradeSource.sourceId) ||
      !isText(value.upgradeSource.recovery)
    )
      report(
        "upgradeSource",
        "Upgrade requires a declared source identity and recovery policy",
      );
  }
  return diagnostics;
}

export function assertValidSemanticDossier(
  value: unknown,
): asserts value is SemanticDossier {
  const diagnostics = validateSemanticDossier(value);
  if (diagnostics.length)
    throw new Error(
      diagnostics.map(({ path, message }) => `${path}: ${message}`).join("\n"),
    );
}

export function semanticDossierHash(dossier: unknown): string {
  return sha256(JSON.stringify(stableValue(dossier ?? null)));
}

export function validateDossierPlan(
  dossier: SemanticDossier,
  plan: FactoryPlan,
): QuestionnaireDiagnostic[] {
  const diagnostics: QuestionnaireDiagnostic[] = [];
  if (
    !isRecord(plan) ||
    plan.schemaVersion !== 1 ||
    !isRecord(plan.workflow) ||
    plan.workflow.kind !== "workflow-kernel" ||
    !Array.isArray(plan.skillSources) ||
    !plan.skillSources.every(
      (source) =>
        isRecord(source) && isText(source.name) && isText(source.location),
    )
  ) {
    return [
      {
        path: "factoryPlan",
        message:
          "Required version 1 workflow-kernel FactoryPlan with explicit sources",
      },
    ];
  }
  if (
    plan.skillCreatorIntent === "upgrade-existing" &&
    !isText(plan.sourceRoot)
  )
    diagnostics.push({
      path: "factoryPlan.sourceRoot",
      message: "Upgrade requires sourceRoot",
    });
  try {
    const normalized = normalizeWorkflow(plan.workflow);
    const activeIds = normalized.protocol.nodes
      .filter((node) => !node.disabled)
      .map((node) => node.id);
    const dossierIds = [...dossier.nodes]
      .sort((left, right) => left.order - right.order)
      .map((node) => node.id);
    if (JSON.stringify(activeIds) !== JSON.stringify(dossierIds))
      diagnostics.push({
        path: "nodes",
        message:
          "Dossier Node identities and ordering contradict the normalized FactoryPlan",
      });
  } catch (error) {
    diagnostics.push({
      path: "factoryPlan.workflow",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  for (const [field, expected, actual] of [
    ["workflow.name", plan.workflow.name, dossier.workflow.name],
    ["goal", plan.goal, dossier.workflow.goal],
    ["workflow.goal", plan.workflow.goal, dossier.workflow.goal],
    ["workflow.intent", plan.skillCreatorIntent, dossier.workflow.intent],
    [
      "workflow.defaultLocale",
      plan.defaultLocale,
      dossier.workflow.defaultLocale,
    ],
  ]) {
    if (expected !== actual)
      diagnostics.push({
        path: field,
        message: "Dossier contradicts FactoryPlan",
      });
  }
  const declarations = plan.skillSources.map(({ name, location }) => ({
    name,
    location,
  }));
  const sources = dossier.sources.map(({ name, location }) => ({
    name,
    location,
  }));
  const sorted = (list: typeof sources) =>
    list.sort((left, right) => left.name.localeCompare(right.name));
  if (
    JSON.stringify(stableValue(sorted(declarations))) !==
    JSON.stringify(stableValue(sorted(sources)))
  )
    diagnostics.push({
      path: "sources",
      message: "Dossier must describe exactly the explicit FactoryPlan sources",
    });
  return diagnostics;
}

export interface QuestionnaireHandoff {
  schemaVersion: 1;
  kind: "badger-questionnaire-handoff";
  status: "incomplete" | "complete" | "stopped";
  projectRoot: string;
  existingContext: string | null;
  dossier: unknown;
  dossierHash: string;
  factoryPlan: FactoryPlan | null;
  diagnostics: QuestionnaireDiagnostic[];
  nextAction: "questionnaire-refinement" | "factory-plan-confirmation";
  nextReadOnlyCommand: null;
}

interface DossierHandoffInput {
  projectRoot: string;
  dossier: unknown;
  factoryPlan?: FactoryPlan;
  existingContext?: string;
  stopped?: boolean;
}
export function createQuestionnaireHandoff(input: {
  records: QuestionnaireRecords;
}): QuestionnaireRecordHandoff;
export function createQuestionnaireHandoff(
  input: DossierHandoffInput,
): QuestionnaireHandoff;
export function createQuestionnaireHandoff(
  input: DossierHandoffInput | { records: QuestionnaireRecords },
): QuestionnaireHandoff | QuestionnaireRecordHandoff {
  if ("records" in input) return questionnaireRecordHandoff(input.records);
  const diagnostics = validateSemanticDossier(input.dossier);
  if (!isText(input.projectRoot))
    diagnostics.push({
      path: "projectRoot",
      message: "Project root is required",
    });
  if (!input.factoryPlan)
    diagnostics.push({
      path: "factoryPlan",
      message: "FactoryPlan is required for completion",
    });
  else if (!diagnostics.length)
    diagnostics.push(
      ...validateDossierPlan(
        input.dossier as SemanticDossier,
        input.factoryPlan,
      ),
    );
  const status =
    input.stopped === true
      ? "stopped"
      : diagnostics.length
        ? "incomplete"
        : "complete";
  const dossier = structuredClone(input.dossier);
  return {
    schemaVersion: 1,
    kind: "badger-questionnaire-handoff",
    status,
    projectRoot: input.projectRoot,
    existingContext: input.existingContext ?? null,
    dossier,
    dossierHash: semanticDossierHash(dossier),
    factoryPlan: input.factoryPlan
      ? {
          ...structuredClone(input.factoryPlan),
          ...(status === "complete"
            ? { semanticDossier: dossier as SemanticDossier }
            : {}),
        }
      : null,
    diagnostics,
    nextAction:
      status === "complete"
        ? "factory-plan-confirmation"
        : "questionnaire-refinement",
    nextReadOnlyCommand: null,
  };
}
