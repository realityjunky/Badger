import { Tabs } from "antd";
import { Link } from "react-router-dom";
import type { Question, QuestionnaireView } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { MessageId } from "../../i18n/catalog.js";

/** Evidence and immutable revision history for the open question. */
export function QuestionInspector({
  question,
  view,
}: {
  question?: Question;
  view: QuestionnaireView | null;
}) {
  const { t, format, locale } = useI18n();
  return (
    <aside
      className="pane inspector-pane"
      data-testid="inspector-pane"
      aria-label={t("questionnaire.inspector")}
    >
      <h2 className="pane-title">{t("questionnaire.inspector")}</h2>
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
                  {t(`questionnaire.topic.${question.topic}` as MessageId)}
                </p>
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
                      · {new Date(revision.createdAt).toLocaleString(locale)}
                    </summary>
                    <p className="questionnaire-text">{revision.text}</p>
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
                          <p className="questionnaire-text">{r.text}</p>
                          <p className="muted">
                            {format("questionnaire.questionRevision", {
                              number: r.questionRevision,
                            })}{" "}
                            · {new Date(r.createdAt).toLocaleString(locale)}
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
    </aside>
  );
}
