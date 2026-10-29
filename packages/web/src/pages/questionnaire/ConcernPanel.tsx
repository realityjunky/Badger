import { Alert, Button, Input, Select, Tag } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  questionnaireRequest,
  type Concern,
  type ConcernDecision,
  type ConcernOutcome,
  type ConcernResolutionPreview,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { ConcernResolutionDialog } from "./ConcernResolutionDialog.js";

export function ConcernPanel({
  basePath,
  path,
  concern,
  view,
  onQuestion,
  onChanged,
}: {
  basePath: string;
  path: string;
  concern: Concern;
  view: QuestionnaireView;
  onQuestion(roundId: string): void;
  onChanged(): void;
}) {
  const { t, locale } = useI18n();
  const rounds = view.rounds.filter((r) => r.state === "draft");
  const [outcome, setOutcome] = useState<ConcernOutcome>("question");
  const [roundId, setRoundId] = useState<string>();
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ConcernResolutionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selectedRound = rounds.find((r) => r.id === (roundId ?? rounds[0]?.id));
  const review = async () => {
    if (busy || outcome === "question") return;
    setBusy(true);
    setFailure(null);
    const decision: ConcernDecision =
      outcome === "declined"
        ? { revision: concern.revision, outcome, reason }
        : { revision: concern.revision, outcome };
    try {
      const result = await questionnaireRequest<{
        preview: ConcernResolutionPreview;
      }>(
        basePath,
        `${path}/concerns/${encodeURIComponent(concern.id)}/resolve-preview`,
        "POST",
        decision,
      );
      setPreview(result.preview);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const linkedQuestion = view.questions.find(
    (q) => q.id === concern.resolution?.questionId,
  );
  return (
    <>
      <h2 className="pane-title">{t("questionnaire.concern")}</h2>
      <article className="questionnaire-record" data-testid="concern-record">
        <p className="muted">
          {concern.personName} ·{" "}
          {new Date(concern.createdAt).toLocaleString(locale)}
        </p>
        <p className="questionnaire-text">{concern.text}</p>
        <Tag>{t(`questionnaire.concernState.${concern.state}`)}</Tag>
        {concern.resolution && (
          <>
            <p className="muted">
              {new Date(concern.resolution.createdAt).toLocaleString(locale)}
            </p>
            {concern.resolution.reason && (
              <p className="questionnaire-text">{concern.resolution.reason}</p>
            )}
            {concern.state === "fact-source" && (
              <p>{t("questionnaire.factSourceHelp")}</p>
            )}
            {linkedQuestion ? (
              <Link
                to={`/questionnaire/questions/${encodeURIComponent(linkedQuestion.id)}`}
              >
                {t("questionnaire.openQuestion")}
              </Link>
            ) : (
              concern.state === "question" && (
                <p className="muted">
                  {t("questionnaire.questionAwaitingPublication")}
                </p>
              )
            )}
          </>
        )}
      </article>
      {view.capabilities.resolveConcern && concern.state === "open" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (outcome === "question" && selectedRound)
              onQuestion(selectedRound.id);
            else void review();
          }}
        >
          {failure && <Alert type="error" showIcon message={failure} />}
          <label className="field-label" htmlFor="concern-outcome">
            {t("questionnaire.resolution")}
          </label>
          <Select
            id="concern-outcome"
            className="questionnaire-select"
            value={outcome}
            onChange={setOutcome}
            options={(["question", "fact-source", "declined"] as const).map(
              (value) => ({
                value,
                label: t(`questionnaire.outcome.${value}`),
              }),
            )}
          />
          {outcome === "question" && (
            <>
              <label className="field-label" htmlFor="concern-round">
                {t("questionnaire.draftRound")}
              </label>
              <Select
                id="concern-round"
                className="questionnaire-select"
                value={selectedRound?.id}
                onChange={setRoundId}
                options={rounds.map((r) => ({ value: r.id, label: r.title }))}
              />
              {rounds.length === 0 && (
                <p className="muted">{t("questionnaire.needDraftRound")}</p>
              )}
            </>
          )}
          {outcome === "declined" && (
            <>
              <label className="field-label" htmlFor="concern-reason">
                {t("questionnaire.declineReason")}
              </label>
              <Input.TextArea
                id="concern-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={4000}
                autoSize={{ minRows: 3, maxRows: 12 }}
                disabled={busy}
              />
            </>
          )}
          <Button
            className="questionnaire-actions"
            htmlType="submit"
            loading={busy}
            disabled={
              outcome === "question"
                ? !selectedRound
                : outcome === "declined" && !reason.trim()
            }
          >
            {t(
              outcome === "question"
                ? "questionnaire.draftQuestion"
                : "questionnaire.reviewResolution",
            )}
          </Button>
        </form>
      )}
      {preview && (
        <ConcernResolutionDialog
          basePath={basePath}
          path={path}
          preview={preview}
          onCancel={() => setPreview(null)}
          onCommitted={() => {
            setPreview(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
