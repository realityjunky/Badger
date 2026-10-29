import { canonicalHash, canonicalJson } from "../util.js";
import {
  questionnaireRecordHandoff,
  type QuestionnaireRecords,
  type QuestionnaireRecordHandoff,
} from "./questionnaire-records.js";
import {
  validateSemanticDossier,
  type FactProvenance,
  type SemanticDossier,
} from "./questionnaire.js";

export type DossierSemantics = Pick<
  SemanticDossier,
  "nodes" | "topics" | "upgradeSource"
>;
export interface DossierSnapshot {
  schemaVersion: 1;
  kind: "badger-dossier-version";
  workflowVersionId: string;
  ledger: QuestionnaireRecordHandoff;
  dossier: SemanticDossier;
}
export interface DossierCompositionInput {
  workflowVersionId: string;
  workflow: SemanticDossier["workflow"];
  sources: SemanticDossier["sources"];
  records: QuestionnaireRecords;
  sourceEvidence: Record<string, { sourceId: string; evidencePath: string }>;
  semantics: Record<string, unknown>;
}

/** Compose a candidate; findings must be empty before it can be stored or approved. */
export function composeSemanticDossier(input: DossierCompositionInput) {
  const ledger = questionnaireRecordHandoff(input.records);
  const confirmed = new Set(
    ledger.ledger.confirmedUserFacts.map((f) => f.record.id),
  );
  const facts = (input.records.facts ?? []).filter((f) => confirmed.has(f.id));
  const provenance = (
    fact: (typeof facts)[number] | undefined,
  ): FactProvenance => ({
    confirmedBy: fact?.actorId ?? "",
    answerRevisions:
      fact?.answers.map((a) => ({
        answerId: `${fact.questionId}:${a.personId}`,
        revision: a.revision,
      })) ?? [],
    acknowledgedBy:
      fact?.acknowledgements.find((a) => a.decision === "acknowledged")
        ?.personId ?? "",
  });
  // This is the proposed, confirmed kernel document. Service approval is a
  // separate human gate over the immutable candidate's hash, never this flag.
  const dossier = {
    schemaVersion: 2,
    kind: "semantic-dossier",
    confirmed: true,
    workflow: input.workflow,
    sources: input.sources,
    nodes: input.semantics.nodes ?? [],
    topics: input.semantics.topics ?? {},
    confirmedUserFacts: facts.map((f) => ({
      id: f.id,
      statement: f.statement,
      provenance: provenance(f),
    })),
    sourceDerivedFacts: ledger.items
      .filter(
        (f) =>
          ["source-fact", "source-interface"].includes(f.record.type) &&
          f.state === "source",
      )
      .map((f) => ({
        id: f.record.id,
        statement: f.statement,
        ...input.sourceEvidence[f.record.id],
      })),
    agentInferences: ledger.ledger.agentInferences.map((f) => ({
      id: f.record.id,
      statement: f.statement,
      confirmed: f.state === "confirmed",
      provenance: provenance(
        facts.find((fact) =>
          f.relatedRecords.some(
            (r) => r.type === "question" && r.id === fact.questionId,
          ),
        ),
      ),
    })),
    unresolvedAssumptions: ledger.ledger.unresolvedAssumptions.map((f) => ({
      id: f.record.id,
      statement: f.statement,
      field: f.topic,
    })),
    remainingQuestions: ledger.ledger.remainingQuestions.map((q) => ({
      id: q.record.id,
      question: q.statement,
      field: q.topic,
    })),
    deferredQuestions: ledger.deferredQuestions.map((q) => ({
      id: q.record.id,
      question: q.statement,
      field: q.topic,
      resolution: {
        outcome: "deferred",
        scope:
          q.resolution?.deferredKind === "skill-internal"
            ? "skill"
            : "out-of-scope",
        ...(q.resolution?.skillId
          ? {
              skill: input.sources.find((s) => s.id === q.resolution!.skillId)
                ?.name,
            }
          : {}),
        reason: q.resolution?.reason,
      },
    })),
    ...(input.semantics.upgradeSource === undefined
      ? {}
      : { upgradeSource: input.semantics.upgradeSource }),
  };
  const findings = validateSemanticDossier(dossier);
  const snapshot: DossierSnapshot = {
    schemaVersion: 1,
    kind: "badger-dossier-version",
    workflowVersionId: input.workflowVersionId,
    ledger,
    dossier: dossier as SemanticDossier,
  };
  return {
    snapshot,
    canonicalJson: canonicalJson(snapshot),
    hash: canonicalHash(snapshot),
    findings,
  };
}
export type DossierComposition = ReturnType<typeof composeSemanticDossier>;
