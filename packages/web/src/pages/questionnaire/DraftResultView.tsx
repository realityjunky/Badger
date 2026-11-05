import { Alert, Button, Input } from "antd";
import { Link } from "react-router-dom";
import type { DraftingResult } from "../../api/drafting-jobs.js";
import type {
  QuestionnaireView,
  QuestionContent,
} from "../../api/questionnaire.js";
import type { SourceEvidence } from "../../api/source-study.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function draftQuestions(result: DraftingResult): QuestionContent[] {
  return "questions" in result
    ? result.questions.map((item) =>
        "question" in item ? item.question : item,
      )
    : [];
}
export function changeDraftQuestion(
  result: DraftingResult,
  index: number,
  content: QuestionContent | null,
): DraftingResult {
  if (!("questions" in result)) return result;
  const questions = result.questions.flatMap((item, i) =>
    i !== index
      ? [item]
      : content === null
        ? []
        : ["question" in item ? { ...item, question: content } : content],
  );
  return { questions } as DraftingResult;
}
export function hasDraftItems(result: DraftingResult) {
  if ("questions" in result) return result.questions.length > 0;
  if ("text" in result)
    return !!result.text.trim() && !!result.rationale.trim();
  return (
    result.facts.length > 0 ||
    ("interfaces" in result &&
      (result.interfaces.length > 0 || (result.scriptEffects?.length ?? 0) > 0))
  );
}

export function DraftEvidence({ evidence }: { evidence: SourceEvidence[] }) {
  return (
    <ul>
      {evidence.map((citation, index) => (
        <li key={index}>
          <Link
            to={`/skills/${encodeURIComponent(citation.skillId)}/versions/${encodeURIComponent(citation.hash)}`}
          >
            {citation.path}:{citation.startLine}–{citation.endLine}
          </Link>
          <details>
            <summary>{citation.hash.slice(0, 12)}</summary>
            <code>{citation.hash}</code>
            <br />
            <code>{citation.fileHash}</code>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Edit the proposed meaning while preserving its evidence and answer links. */
export function DraftResultView({
  result,
  view,
  questionId,
  onChange,
}: {
  result: DraftingResult;
  view: QuestionnaireView;
  questionId?: string | null;
  onChange?(result: DraftingResult): void;
}) {
  const { t } = useI18n();
  const text = (
    id: string,
    label: string,
    value: string,
    update: (value: string) => DraftingResult,
    maxLength = 20000,
  ) => (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {onChange ? (
        <Input.TextArea
          id={id}
          value={value}
          maxLength={maxLength}
          autoSize={{ minRows: 2, maxRows: 8 }}
          onChange={(e) => onChange(update(e.target.value))}
        />
      ) : (
        <p className="questionnaire-text">{value}</p>
      )}
    </>
  );
  if ("questions" in result) return null;
  if ("text" in result)
    return (
      <>
        {text(
          "draft-translation-text",
          t("questionnaire.questionText"),
          result.text,
          (value) => ({ ...result, text: value }),
        )}
        {text(
          "draft-translation-rationale",
          t("questionnaire.rationale"),
          result.rationale,
          (value) => ({ ...result, rationale: value }),
          4000,
        )}
      </>
    );
  if ("interfaces" in result)
    return (
      <>
        <h3>{t("study.facts")}</h3>
        {!!result.scriptEffects?.length && (
          <section>
            <h3>{t("effects.title")}</h3>
            <p>{t("effects.routingHelp")}</p>
            {result.scriptEffects.map((row) => (
              <article className="drafting-suggestion" key={row.path}>
                <code>{row.path}</code>
                <p>
                  {row.effects
                    .map((effect) => t(`skills.effect.${effect}`))
                    .join(", ") || t("effects.pending")}
                </p>
                <p>{row.rationale}</p>
                <p>{row.conditionalBehavior}</p>
                {row.uncertainty && <p>{row.uncertainty}</p>}
                <DraftEvidence evidence={row.evidence} />
              </article>
            ))}
          </section>
        )}
        {result.facts.map((fact, index) => (
          <section className="drafting-suggestion" key={index}>
            {text(
              `draft-source-fact-${index}`,
              t("study.statement"),
              fact.statement,
              (value) => ({
                ...result,
                facts: result.facts.map((f, i) =>
                  i === index ? { ...f, statement: value } : f,
                ),
              }),
              8000,
            )}
            <DraftEvidence evidence={fact.evidence} />
          </section>
        ))}
        {result.interfaces.length > 0 && (
          <>
            <Alert type="warning" title={t("prompts.legacyInterfaces")} />
            {onChange && (
              <Button onClick={() => onChange({ ...result, interfaces: [] })}>
                {t("prompts.removeInterfaces")}
              </Button>
            )}
            <h3>{t("study.interfaces")}</h3>
          </>
        )}
        {result.interfaces.map((entry, index) => (
          <section className="drafting-suggestion" key={index}>
            <p>
              {t("study.producer")}:{" "}
              {view.pins.find((p) => p.skillId === entry.producer.skillId)
                ?.skillName ?? entry.producer.skillId}
            </p>
            <p>
              {t("study.consumer")}:{" "}
              {view.pins.find((p) => p.skillId === entry.consumer.skillId)
                ?.skillName ?? entry.consumer.skillId}
            </p>
            {(["artifact", "naming", "validation"] as const).map((key) => (
              <div key={key}>
                {text(
                  `draft-interface-${index}-${key}`,
                  t(`study.${key}`),
                  entry[key],
                  (value) => ({
                    ...result,
                    interfaces: result.interfaces.map((e, i) =>
                      i === index ? { ...e, [key]: value } : e,
                    ),
                  }),
                  4000,
                )}
              </div>
            ))}
            {text(
              `draft-interface-${index}-columns`,
              t("study.columns"),
              entry.columns.join("\n"),
              (value) => ({
                ...result,
                interfaces: result.interfaces.map((e, i) =>
                  i === index
                    ? {
                        ...e,
                        columns: value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }
                    : e,
                ),
              }),
            )}
            <DraftEvidence evidence={entry.evidence} />
          </section>
        ))}
      </>
    );
  return (
    <>
      <p>
        {t("drafting.restatementHelp")} · {view.version.locale}
      </p>
      {result.facts.map((fact, index) => (
        <section className="drafting-suggestion" key={index}>
          {fact.answers.map((link) => {
            const answer = view.answers.find(
              (a) =>
                a.personId === link.personId && a.questionId === questionId,
            );
            return (
              <blockquote key={link.personId}>
                {answer?.personName ?? link.personId} ·{" "}
                {t("drafting.answerRevision")} {link.revision}
                <p>
                  {
                    answer?.revisions.find((r) => r.revision === link.revision)
                      ?.text
                  }
                </p>
              </blockquote>
            );
          })}
          {text(
            `draft-restatement-${index}`,
            t("study.statement"),
            fact.text,
            (value) => ({
              facts: result.facts.map((f, i) =>
                i === index ? { ...f, text: value } : f,
              ),
            }),
          )}
        </section>
      ))}
    </>
  );
}
