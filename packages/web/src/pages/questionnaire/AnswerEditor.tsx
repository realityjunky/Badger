import { Alert, Button, Space } from "antd";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  questionnaireRequest,
  type Answer,
  type Question,
  type QuestionnaireView,
  type AnswerValue,
  type AnswerAttachment,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { StructuredAnswerControl } from "./StructuredAnswerControl.js";
import { AnswerAttachments } from "./AnswerAttachments.js";

export interface AnswerEditorHandle {
  flush(): Promise<Answer | null>;
}
type SaveState = "idle" | "saving" | "saved" | "submitted" | "failed";
interface Draft {
  text: string;
  value: AnswerValue;
  attachments: AnswerAttachment[];
}

/** Serial saves keep typing during a request, and never replay a stale edit. */
export const AnswerEditor = forwardRef<
  AnswerEditorHandle,
  {
    basePath: string;
    path: string;
    question: Question;
    answer?: Answer;
    personId: string;
    attachmentLimits: QuestionnaireView["attachmentLimits"];
    disabled: boolean;
    onSubmitted(): void;
  }
>(function AnswerEditor(
  {
    basePath,
    path,
    question,
    answer,
    personId,
    attachmentLimits,
    disabled,
    onSubmitted,
  },
  ref,
) {
  const { t } = useI18n();
  const initial = {
    text: answer?.text ?? "",
    value: answer?.questionRevision === question.revision ? answer.value : null,
    attachments: answer?.attachments ?? [],
  };
  const [draft, setDraft] = useState<Draft>(initial);
  const currentDraft = useRef<Draft>(initial);
  const boundType = useRef(
    question.answerType ?? { kind: "free-text" as const },
  );
  const [uploading, setUploading] = useState(false);
  const uploadInProgress = useRef(false);
  const [state, setState] = useState<SaveState>(
    answer?.state === "submitted" ? "submitted" : answer ? "saved" : "idle",
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stored = useRef<Answer | null>(answer ?? null);
  const boundRevision = useRef(question.revision);
  const pending = useRef<Draft | null>(null);
  const running = useRef<Promise<Answer | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback((): Promise<Answer | null> => {
    if (uploadInProgress.current) return Promise.resolve(null);
    if (timer.current !== null) clearTimeout(timer.current);
    if (running.current !== null) return running.current;
    if (pending.current === null) return Promise.resolve(stored.current);
    const drain = async () => {
      try {
        while (pending.current !== null) {
          const sending = pending.current;
          pending.current = null;
          setState("saving");
          try {
            const result = await questionnaireRequest<{ answer: Answer }>(
              basePath,
              `${path}/questions/${encodeURIComponent(question.id)}/answer`,
              "PUT",
              {
                revision: stored.current?.revision ?? 0,
                questionRevision: boundRevision.current,
                ...(boundType.current.kind === "free-text"
                  ? { text: sending.text }
                  : { value: sending.value }),
                attachments: sending.attachments.map((file) => file.id),
              },
            );
            stored.current = result.answer;
          } catch (error) {
            pending.current ??= sending;
            setFailure(error instanceof Error ? error.message : "");
            setState("failed");
            return null;
          }
        }
        setFailure(null);
        setState("saved");
        return stored.current;
      } finally {
        running.current = null;
      }
    };
    running.current = drain();
    return running.current;
  }, [basePath, path, question.id]);
  const latestFlush = useRef(flush);
  latestFlush.current = flush;
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      void latestFlush.current();
    },
    [],
  );
  useEffect(() => {
    if (
      uploadInProgress.current ||
      pending.current !== null ||
      running.current !== null ||
      state === "failed"
    )
      return;
    if (answer && answer.revision > (stored.current?.revision ?? 0)) {
      stored.current = answer;
      const next = {
        text: answer.text,
        value:
          answer.questionRevision === boundRevision.current
            ? answer.value
            : null,
        attachments: answer.attachments,
      };
      currentDraft.current = next;
      setDraft(next);
      setState(answer.state === "submitted" ? "submitted" : "saved");
    }
  }, [answer, state, uploading]);
  const stale = boundRevision.current !== question.revision;
  const reload = async () => {
    let current: QuestionnaireView;
    try {
      current = await questionnaireRequest<QuestionnaireView>(basePath, path);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "");
      return;
    }
    const currentQuestion = current.questions.find((q) => q.id === question.id);
    if (!currentQuestion?.canAnswer) {
      setFailure(t("questionnaire.questionChanged"));
      return;
    }
    const loaded = current.answers.find(
      (a) => a.questionId === question.id && a.personId === personId,
    );
    if (timer.current !== null) clearTimeout(timer.current);
    pending.current = null;
    stored.current = loaded ?? null;
    boundRevision.current = currentQuestion.revision;
    boundType.current = currentQuestion.answerType ?? { kind: "free-text" };
    const next = {
      text: loaded?.text ?? "",
      value:
        loaded?.questionRevision === currentQuestion.revision
          ? loaded.value
          : null,
      attachments: loaded?.attachments ?? [],
    };
    currentDraft.current = next;
    setDraft(next);
    setFailure(null);
    setState(
      loaded?.state === "submitted" ? "submitted" : loaded ? "saved" : "idle",
    );
    onSubmitted();
  };
  const change = (update: Partial<Draft>) => {
    const next = { ...currentDraft.current, ...update };
    currentDraft.current = next;
    setDraft(next);
    pending.current = next;
    setState("saving");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };
  const submit = async () => {
    setSubmitting(true);
    try {
      const saved = await flush();
      if (!saved) return;
      const result = await questionnaireRequest<{ answers: Answer[] }>(
        basePath,
        `${path}/questions/${encodeURIComponent(question.id)}/submit`,
        "POST",
        { revision: saved.revision, questionRevision: boundRevision.current },
      );
      stored.current = result.answers[0];
      setState("submitted");
      setFailure(null);
      onSubmitted();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "");
      setState("failed");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="questionnaire-answer-editor">
      <label className="field-label" id="answer-label" htmlFor="answer-box">
        {t("questionnaire.answer")}
      </label>
      {boundType.current.kind === "free-text" ? (
        <textarea
          id="answer-box"
          className="answer-box"
          data-testid="answer-box"
          value={draft.text}
          maxLength={50000}
          readOnly={stale || submitting || disabled}
          aria-describedby="answer-help answer-status"
          onChange={(event) => {
            change({ text: event.target.value });
          }}
        />
      ) : (
        <StructuredAnswerControl
          type={boundType.current}
          value={draft.value}
          disabled={stale || submitting || disabled}
          onChange={(value) => change({ value })}
        />
      )}
      <AnswerAttachments
        basePath={basePath}
        path={path}
        questionId={question.id}
        questionRevision={boundRevision.current}
        attachments={draft.attachments}
        limits={attachmentLimits}
        disabled={stale || submitting || disabled}
        onChange={(attachments) => change({ attachments })}
        onBusy={(busy) => {
          uploadInProgress.current = busy;
          setUploading(busy);
          if (!busy && pending.current !== null) void latestFlush.current();
        }}
      />
      <p className="muted" id="answer-help">
        {t("questionnaire.draftHelp")}
      </p>
      <p id="answer-status" role="status" data-testid="answer-save-state">
        {t(`questionnaire.save.${state}`)}
      </p>
      {(failure || stale) && (
        <Alert
          type="warning"
          showIcon
          message={stale ? t("questionnaire.questionChanged") : failure}
          description={t("questionnaire.keepDraft")}
        />
      )}
      <Space wrap>
        <Button
          type="primary"
          disabled={
            disabled ||
            uploading ||
            (boundType.current.kind === "free-text"
              ? !draft.text.trim()
              : boundType.current.kind === "file"
                ? !draft.attachments.length
                : draft.value === null) ||
            stale ||
            state === "failed"
          }
          loading={submitting}
          onClick={() => void submit()}
        >
          {t("questionnaire.submitAnswer")}
        </Button>
        {failure && !stale && (
          <Button onClick={() => void flush()}>
            {t("questionnaire.retrySave")}
          </Button>
        )}
        {(failure || stale) && (
          <Button
            disabled={disabled || running.current !== null}
            onClick={() => void reload()}
          >
            {t("questionnaire.reloadDraft")}
          </Button>
        )}
      </Space>
    </div>
  );
});
