import { Button, Drawer, Tabs } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import type {
  Concern,
  Question,
  QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { MessageId } from "../../i18n/catalog.js";
import { AnswerContent } from "./AnswerContent.js";
import { AnswerTypeDetails } from "./AnswerTypeDetails.js";
import { EvidenceChanges } from "../../components/EvidenceChanges.js";
import { RecordOriginLink } from "../../components/RecordOriginLink.js";

/** Evidence and immutable revision history for the open question. */
export function QuestionInspector({
  question,
  concern,
  view,
  basePath,
  path,
  active,
}: {
  question?: Question;
  concern?: Concern;
  view: QuestionnaireView | null;
  basePath: string;
  path: string | null;
  active: boolean;
}) {
  const { t, format, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sourceConcern =
    question &&
    view?.concerns.find((c) => c.resolution?.questionId === question.id);
  return (
    <>
      <Button
        disabled={!question && !concern}
        aria-haspopup="dialog"
        aria-expanded={open && active}
        onClick={() => setOpen(true)}
      >
        {t("questionnaire.inspector")}
      </Button>
      <Drawer
        title={t("questionnaire.inspector")}
        open={open && active}
        onClose={() => setOpen(false)}
        size={expanded ? "100vw" : "min(600px, 100vw)"}
        className="questionnaire-inspector-drawer"
        extra={
          <Button
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {t(
              expanded
                ? "questionnaire.restoreInspector"
                : "questionnaire.expandInspector",
            )}
          </Button>
        }
      >
        <aside
          className="questionnaire-inspector"
          data-testid="inspector-pane"
          aria-label={t("questionnaire.inspector")}
        >
          <h2 className="pane-title">{question?.text ?? concern?.text}</h2>
          {question && view && (
            <>
              <RecordOriginLink
                origin={question.origin}
                workflowId={view.workflow.id}
                kind="question"
              />
              <EvidenceChanges changes={question.evidenceChanges} />
            </>
          )}
          {sourceConcern && (
            <Link
              to={`/questionnaire/concerns/${encodeURIComponent(sourceConcern.id)}`}
            >
              {t("questionnaire.sourceConcern")}
            </Link>
          )}
          {question?.source && (
            <section>
              <h3>
                {t("drafting.importedFrom")} {question.source.number}
              </h3>
              <Link
                to={`/skills/${encodeURIComponent(question.source.skillId)}/versions/${encodeURIComponent(question.source.hash)}`}
              >
                {question.source.path}:{question.source.startLine}–
                {question.source.endLine}
              </Link>
              <p>
                {format("questionnaire.questionRevision", {
                  number: question.source.questionRevision,
                })}
              </p>
            </section>
          )}
          {!!question?.translations?.length && (
            <section>
              <h3>{t("drafting.translations")}</h3>
              {question.translations.map((translation) => (
                <details
                  key={translation.id}
                  open={translation.questionRevision === question.revision}
                >
                  <summary>
                    {translation.locale} ·{" "}
                    {format("questionnaire.questionRevision", {
                      number: translation.questionRevision,
                    })}
                  </summary>
                  <p className="questionnaire-text" lang={translation.locale}>
                    {translation.text}
                  </p>
                  <p lang={translation.locale}>{translation.rationale}</p>
                </details>
              ))}
            </section>
          )}
          {concern && (
            <>
              <h3>{t("questionnaire.sourceConcern")}</h3>
              <p className="questionnaire-text">{concern.text}</p>
              <p>
                {concern.personName} ·{" "}
                {new Date(concern.createdAt).toLocaleString(locale)}
              </p>
              {concern.resolution && (
                <p>
                  {t(`questionnaire.concernState.${concern.state}`)} ·{" "}
                  {new Date(concern.resolution.createdAt).toLocaleString(
                    locale,
                  )}
                </p>
              )}
            </>
          )}
          {!concern && (
            <Tabs
              className="underline-tabs"
              items={[
                {
                  key: "evidence",
                  label: t("questionnaire.evidence"),
                  children: question ? (
                    <>
                      <p>
                        <strong>{t("questionnaire.topic")}</strong>{" "}
                        {t(
                          `questionnaire.topic.${question.topic}` as MessageId,
                        )}
                      </p>
                      <AnswerTypeDetails type={question.answerType} />
                      <h3>{t("questionnaire.targets")}</h3>
                      <ul>
                        {question.targets.map((target, index) => (
                          <li key={index}>
                            {t(`questionnaire.target.${target.kind}`)}:{" "}
                            {target.id === view?.workflow.id
                              ? view.workflow.name
                              : target.id}
                          </li>
                        ))}
                      </ul>
                      <h3>{t("questionnaire.evidence")}</h3>
                      {question.evidence.length ? (
                        <ul>
                          {question.evidence.map((link, index) => (
                            <li key={index}>
                              <Link
                                to={`/skills/${encodeURIComponent(link.skillId)}/versions/${encodeURIComponent(link.versionHash)}`}
                              >
                                {link.path}:{link.startLine}–{link.endLine}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">{t("questionnaire.noEvidence")}</p>
                      )}
                    </>
                  ) : (
                    <p className="muted">{t("questionnaire.selectQuestion")}</p>
                  ),
                },
                {
                  key: "history",
                  label: t("questionnaire.history"),
                  children: (
                    <>
                      {question?.revisions.map((revision) => (
                        <details
                          className="questionnaire-history"
                          key={revision.revision}
                        >
                          <summary>
                            {format("questionnaire.questionRevision", {
                              number: revision.revision,
                            })}{" "}
                            ·{" "}
                            {new Date(revision.createdAt).toLocaleString(
                              locale,
                            )}
                          </summary>
                          <p className="questionnaire-text">{revision.text}</p>
                          <AnswerTypeDetails type={revision.answerType} />
                          <p>{revision.rationale}</p>
                        </details>
                      ))}
                      {view?.answers
                        .filter((a) => a.questionId === question?.id)
                        .map((a) => (
                          <div key={a.personId}>
                            <h3>{a.personName}</h3>
                            {a.revisions.map((r) => (
                              <details
                                className="questionnaire-history"
                                key={r.revision}
                              >
                                <summary>
                                  {format("questionnaire.answerRevision", {
                                    number: r.revision,
                                  })}{" "}
                                  ·{" "}
                                  {t(
                                    r.state === "draft"
                                      ? "questionnaire.state.draft"
                                      : "questionnaire.save.submitted",
                                  )}{" "}
                                  ·{" "}
                                  {t(
                                    r.channel === "web"
                                      ? "questionnaire.channel.web"
                                      : "questionnaire.channel.agent",
                                  )}
                                </summary>
                                {path && (
                                  <AnswerContent
                                    answer={r}
                                    type={
                                      question?.revisions.find(
                                        (revision) =>
                                          revision.revision ===
                                          r.questionRevision,
                                      )?.answerType
                                    }
                                    basePath={basePath}
                                    path={path}
                                  />
                                )}
                                <p className="muted">
                                  {format("questionnaire.questionRevision", {
                                    number: r.questionRevision,
                                  })}{" "}
                                  ·{" "}
                                  {new Date(r.createdAt).toLocaleString(locale)}
                                </p>
                              </details>
                            ))}
                          </div>
                        ))}
                    </>
                  ),
                },
              ]}
            />
          )}
        </aside>
      </Drawer>
    </>
  );
}
