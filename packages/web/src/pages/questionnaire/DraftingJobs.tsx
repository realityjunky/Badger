import { Alert, Button, Input, Modal, Select, Space, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  questionnaireRequest,
  type QuestionnaireView,
  type QuestionContent,
} from "../../api/questionnaire.js";
import type {
  DraftingJob,
  DraftingDecisionPreview,
} from "../../api/drafting-jobs.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { QuestionComposer } from "./QuestionComposer.js";
import { AnswerTypeDetails } from "./AnswerTypeDetails.js";
import type { MessageId } from "../../i18n/catalog.js";

export function DraftingJobs({
  basePath,
  path,
  view,
  onChanged,
}: {
  basePath: string;
  path: string;
  view: QuestionnaireView;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const jobsPath = path.replace(/\/questionnaire$/u, "/drafting-jobs");
  const [jobs, setJobs] = useState<DraftingJob[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [roundId, setRoundId] = useState<string>();
  const [parentId, setParentId] = useState<string>();
  const [review, setReview] = useState<{
    job: DraftingJob;
    questions: QuestionContent[];
  } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [discard, setDiscard] = useState<DraftingJob | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<DraftingDecisionPreview | null>(null);
  const confirmationRequestId = useRef("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await questionnaireRequest<{ jobs: DraftingJob[] }>(
        basePath,
        jobsPath,
      );
      if (request === sequence.current) {
        setJobs(result.jobs);
        setFailure(null);
      }
    } catch (error) {
      if (request === sequence.current) {
        setJobs([]);
        setFailure(
          error instanceof Error ? error.message : t("questionnaire.failed"),
        );
      }
    }
  }, [basePath, jobsPath]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh, view]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const draftRounds = view.rounds.filter((r) => r.state === "draft");
  const startRequest = () => {
    setRoundId(draftRounds[0]?.id);
    setParentId(undefined);
    setRequesting(true);
  };
  const previewDecision = async (
    job: DraftingJob,
    action: "accept" | "reject",
    decision: object,
  ) => {
    const result = await questionnaireRequest<{
      preview: DraftingDecisionPreview;
    }>(basePath, `${jobsPath}/${job.id}/${action}-preview`, "POST", {
      revision: job.revision,
      ...decision,
    });
    setPreview(result.preview);
    confirmationRequestId.current = crypto.randomUUID();
  };
  const commit = () =>
    run(async () => {
      if (!preview) return;
      await questionnaireRequest(
        basePath,
        `${jobsPath}/${preview.jobId}/${preview.action}`,
        "POST",
        {
          revision: preview.revision,
          ...preview.decision,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
          requestId: confirmationRequestId.current,
        },
      );
      setPreview(null);
      setReview(null);
      setDiscard(null);
      setEditing(null);
      await refresh();
      onChanged();
    });
  return (
    <section aria-label={t("drafting.title")}>
      <h2 className="pane-title">{t("drafting.title")}</h2>
      <p className="muted">{t("drafting.help")}</p>
      {failure && <Alert type="error" showIcon message={failure} />}
      <Space wrap>
        <Button disabled={busy} onClick={startRequest}>
          {t("drafting.request")}
        </Button>
        <Button disabled={busy} onClick={() => void refresh()}>
          {t("workflow.reload")}
        </Button>
      </Space>
      {!jobs.length && <p className="muted">{t("drafting.empty")}</p>}
      <ul className="questionnaire-concerns">
        {jobs.map((job) => (
          <li key={job.id}>
            <Space wrap>
              <span>
                {t(
                  job.kind === "draft-questions"
                    ? "drafting.questions"
                    : "drafting.followUps",
                )}
              </span>
              <span>
                {view.rounds.find((round) => round.id === job.roundId)?.title}
              </span>
              {job.parentQuestionId && (
                <span>
                  {
                    view.questions.find(
                      (question) => question.id === job.parentQuestionId,
                    )?.text
                  }
                </span>
              )}
              <Tag>{t(`drafting.state.${job.status}`)}</Tag>
              {job.status === "submitted" && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setPreview(null);
                      setEditing(null);
                      setReview({
                        job,
                        questions: structuredClone(job.result!.questions),
                      });
                    }}
                  >
                    {t("drafting.review")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setDiscard(job);
                    }}
                  >
                    {t("drafting.discard")}
                  </Button>
                </>
              )}
            </Space>
          </li>
        ))}
      </ul>
      <Modal
        open={requesting}
        title={t("drafting.request")}
        okText={t("drafting.request")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !roundId }}
        onCancel={() => {
          if (!busy) setRequesting(false);
        }}
        onOk={() =>
          void run(async () => {
            await questionnaireRequest(basePath, jobsPath, "POST", {
              kind: parentId ? "draft-follow-ups" : "draft-questions",
              roundId,
              ...(parentId ? { parentQuestionId: parentId } : {}),
              confirmed: true,
            });
            setRequesting(false);
            await refresh();
          })
        }
      >
        {!draftRounds.length && (
          <Alert type="info" message={t("drafting.needRound")} />
        )}
        <label className="field-label" htmlFor="drafting-round">
          {t("drafting.round")}
        </label>
        <Select
          id="drafting-round"
          className="questionnaire-version"
          value={roundId}
          onChange={setRoundId}
          options={draftRounds.map((r) => ({ value: r.id, label: r.title }))}
        />
        <label className="field-label" htmlFor="drafting-parent">
          {t("drafting.parent")}
        </label>
        <Select
          id="drafting-parent"
          className="questionnaire-version"
          allowClear
          value={parentId}
          onChange={setParentId}
          options={view.questions
            .filter((q) => q.state !== "draft")
            .map((q) => ({ value: q.id, label: q.text }))}
        />
        {failure && <Alert type="error" message={failure} />}
      </Modal>
      <Modal
        open={review !== null && editing === null && preview === null}
        title={t("drafting.review")}
        width={800}
        okText={t("drafting.preview")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !review?.questions.length }}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() =>
          void run(async () => {
            if (review)
              await previewDecision(review.job, "accept", {
                questions: review.questions,
              });
          })
        }
      >
        {review?.questions.map((q, index) => (
          <section key={index} className="drafting-suggestion">
            <h3>{q.text}</h3>
            <p className="questionnaire-text">{q.rationale}</p>
            <AnswerTypeDetails type={q.answerType} />
            <p>
              {t(`questionnaire.topic.${q.topic}` as MessageId)} · {q.priority}
            </p>
            <Space wrap>
              <Button onClick={() => setEditing(index)}>
                {t("drafting.edit")}
              </Button>
              <Button
                onClick={() =>
                  setReview({
                    ...review,
                    questions: review.questions.filter((_, i) => i !== index),
                  })
                }
              >
                {t("drafting.remove")}
              </Button>
            </Space>
          </section>
        ))}
        {failure && <Alert type="error" message={failure} />}
      </Modal>
      {review && editing !== null && (
        <Modal
          open
          title={t("drafting.edit")}
          width={900}
          footer={null}
          onCancel={() => setEditing(null)}
          destroyOnHidden
        >
          <QuestionComposer
            key={`${review.job.id}:${editing}`}
            basePath={basePath}
            path={path}
            roundId={review.job.roundId}
            suggestion={review.questions[editing]}
            view={view}
            onSaved={() => undefined}
            onCancel={() => setEditing(null)}
            onDraft={(content) => {
              setReview({
                ...review,
                questions: review.questions.map((q, i) =>
                  i === editing ? content : q,
                ),
              });
              setEditing(null);
            }}
          />
        </Modal>
      )}
      <Modal
        open={discard !== null && preview === null}
        title={t("drafting.discard")}
        okText={t("drafting.preview")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !reason.trim() }}
        onCancel={() => {
          if (!busy) setDiscard(null);
        }}
        onOk={() =>
          void run(async () => {
            if (discard) await previewDecision(discard, "reject", { reason });
          })
        }
      >
        <label className="field-label" htmlFor="drafting-reason">
          {t("drafting.reason")}
        </label>
        <Input.TextArea
          id="drafting-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={4000}
        />
        {failure && <Alert type="error" message={failure} />}
      </Modal>
      <Modal
        open={preview !== null}
        title={t("drafting.preview")}
        width={800}
        okText={t(
          preview?.action === "accept" ? "drafting.accept" : "drafting.discard",
        )}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        onCancel={() => {
          if (!busy) setPreview(null);
        }}
        onOk={() => void commit()}
      >
        {preview && "questions" in preview.decision ? (
          <>
            <p>{t("drafting.acceptHelp")}</p>
            <p>
              {view.rounds.find((r) => r.id === review?.job.roundId)?.title}
            </p>
            {preview.decision.questions.map((q, index) => (
              <section key={index}>
                <h3>{q.text}</h3>
                <p className="questionnaire-text">{q.rationale}</p>
                <AnswerTypeDetails type={q.answerType} />
                <dl>
                  <dt>{t("questionnaire.topic")}</dt>
                  <dd>{t(`questionnaire.topic.${q.topic}` as MessageId)}</dd>
                  <dt>{t("questionnaire.priority")}</dt>
                  <dd>{q.priority}</dd>
                  <dt>{t("questionnaire.targets")}</dt>
                  <dd>
                    {q.targets
                      .map((target) => `${target.kind}: ${target.id}`)
                      .join(", ")}
                  </dd>
                  <dt>{t("questionnaire.assignees")}</dt>
                  <dd>
                    {q.assignees
                      .map((a) =>
                        a.kind === "role"
                          ? a.role
                          : (view.assignees.find(
                              (p) => p.personId === a.personId,
                            )?.name ?? a.personId),
                      )
                      .join(", ")}
                  </dd>
                  <dt>{t("questionnaire.evidence")}</dt>
                  <dd>
                    {q.evidence
                      .map(
                        (e) =>
                          `${e.path}:${e.startLine}–${e.endLine} (${e.versionHash})`,
                      )
                      .join(", ") || "—"}
                  </dd>
                </dl>
              </section>
            ))}
          </>
        ) : (
          <p className="questionnaire-text">
            {preview && "reason" in preview.decision
              ? preview.decision.reason
              : ""}
          </p>
        )}
        {failure && <Alert type="error" message={failure} />}
      </Modal>
    </section>
  );
}
