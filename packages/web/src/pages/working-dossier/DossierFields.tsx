import { Space, Tag } from "antd";
import { Link } from "react-router-dom";
import type {
  DossierFieldState,
  DossierRoute,
  ReviewedDossierAnswer,
  WorkingDossierContent,
  WorkingDossierView,
} from "@realityjunky/badger";
import { type WorkingDossierField } from "../../api/working-dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { I18n } from "../../i18n/I18nContext.js";
import { EvidenceChanges } from "../../components/EvidenceChanges.js";
import {
  DossierEvidenceLinks,
  type EvidenceContext,
} from "./DossierEvidence.js";

const stateColors: Record<DossierFieldState, string> = {
  source: "success",
  decision: "processing",
  proposed: "warning",
  missing: "warning",
  conflict: "error",
  "not-applicable": "default",
};

export function dossierAnswerId(answer: ReviewedDossierAnswer) {
  return `${answer.questionId}/${answer.resolutionRevision}/${answer.personId}/${answer.revision}`;
}

export function handoffLabel(
  content: WorkingDossierContent,
  producer: string,
  consumer: string,
) {
  return `${content.nodes[producer]?.label ?? producer} → ${content.nodes[consumer]?.label ?? consumer}`;
}

export function routeLabel(
  content: WorkingDossierContent,
  route: DossierRoute,
  t: I18n["t"],
  format: I18n["format"],
) {
  return format("workingDossier.routeLabel", {
    from: content.nodes[route.from]?.label ?? route.from,
    to: content.nodes[route.to]?.label ?? route.to,
    kind: t(`workingDossier.route.${route.kind}`),
  });
}

export function DossierFieldStateTag({ state }: { state?: DossierFieldState }) {
  const { t } = useI18n();
  return (
    <Tag color={state && stateColors[state]}>
      {t(state ? `workingDossier.state.${state}` : "workingDossier.blank")}
    </Tag>
  );
}

export function DossierFieldValue({
  field,
  context,
  questions = [],
  collapseEvidence = false,
}: {
  field: Pick<
    WorkingDossierField,
    "content" | "required" | "blocker" | "evidenceChanges"
  >;
  context: EvidenceContext;
  questions?: WorkingDossierView["questions"];
  collapseEvidence?: boolean;
}) {
  const { t, format } = useI18n();
  const value = field.content;
  return (
    <div className="working-dossier-value">
      <Space wrap>
        <DossierFieldStateTag state={value?.state} />
        {field.required && (
          <span className="muted">{t("workingDossier.required")}</span>
        )}
      </Space>
      {value?.value && <p className="questionnaire-text">{value.value}</p>}
      {value?.reason && <p className="questionnaire-text">{value.reason}</p>}
      {field.blocker && field.blocker !== value?.reason && (
        <p className="working-dossier-blocker">{field.blocker}</p>
      )}
      <DossierEvidenceLinks
        evidence={value?.evidence ?? []}
        context={context}
        collapsible={collapseEvidence}
      />
      <EvidenceChanges changes={field.evidenceChanges} />
      {questions.length > 0 && (
        <ul className="working-dossier-links">
          {questions.map(({ id, text, state }) => (
            <li key={id}>
              <Link to={`/questionnaire/questions/${encodeURIComponent(id)}`}>
                {text}
              </Link>{" "}
              <Tag>
                {t(`questionnaire.state.${state}` as Parameters<typeof t>[0]) ??
                  state}
              </Tag>
            </li>
          ))}
        </ul>
      )}
      {!!value?.answers?.length && (
        <ul className="working-dossier-links">
          {value.answers.map((answer) => (
            <li key={dossierAnswerId(answer)}>
              <Link
                to={`/questionnaire/questions/${encodeURIComponent(answer.questionId)}?${new URLSearchParams({ answerPerson: answer.personId, answerRevision: String(answer.revision), resolutionRevision: String(answer.resolutionRevision) })}`}
              >
                {format("questionnaire.answerRevision", {
                  number: answer.revision,
                })}
                {" · "}
                {format("workingDossier.resolutionRevision", {
                  revision: answer.resolutionRevision,
                })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DossierFieldList({
  showOwner = false,
  fields,
  context,
}: {
  showOwner?: boolean;
  fields: WorkingDossierField[];
  context: EvidenceContext;
}) {
  return (
    <div className="working-dossier-field-list">
      {fields.map((field) => (
        <section
          key={field.id}
          className="working-dossier-field"
          aria-label={field.label}
        >
          <h4>
            {showOwner && (
              <span className="working-dossier-field-owner">
                {field.ownerLabel}
              </span>
            )}
            {field.label}
          </h4>
          <DossierFieldValue field={field} context={context} collapseEvidence />
        </section>
      ))}
    </div>
  );
}
