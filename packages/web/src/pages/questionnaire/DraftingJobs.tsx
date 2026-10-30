import { Alert, Button, Input, Modal, Select, Space, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  questionnaireRequest,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import type {
  DraftingJob,
  DraftingDecisionPreview,
  AnyDraftingJob,
  DraftingKind,
  DraftingResult,
} from "../../api/drafting-jobs.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { QuestionComposer } from "./QuestionComposer.js";
import { AnswerTypeDetails } from "./AnswerTypeDetails.js";
import type { MessageId } from "../../i18n/catalog.js";
import {
  DraftEvidence,
  DraftResultView,
  changeDraftQuestion,
  draftQuestions,
  hasDraftItems,
} from "./DraftResultView.js";

const kindLabels: Record<DraftingKind, MessageId> = {
  "draft-questions": "drafting.questions",
  "draft-follow-ups": "drafting.followUps",
  "source-study": "drafting.sourceStudy",
  "restate-answer": "drafting.restatement",
  "translate-question": "drafting.translation",
  "import-open-questions": "drafting.import",
};

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
  const [kind, setKind] = useState<DraftingKind>("draft-questions");
  const [skillId, setSkillId] = useState<string>();
  const [questionId, setQuestionId] = useState<string>();
  const [targetLocale, setTargetLocale] = useState("zh-CN");
  const [review, setReview] = useState<{
    job: DraftingJob;
    result: DraftingResult;
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
      const result = await questionnaireRequest<{ jobs: AnyDraftingJob[] }>(
        basePath,
        jobsPath,
      );
      if (request === sequence.current) {
        setJobs(
          result.jobs.filter(
            (job): job is DraftingJob => job.kind !== "draft-plan",
          ),
        );
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
  const needsRound = [
    "draft-questions",
    "draft-follow-ups",
    "import-open-questions",
  ].includes(kind);
  const needsSkill =
    kind === "source-study" || kind === "import-open-questions";
  const needsQuestion =
    kind === "restate-answer" || kind === "translate-question";
  const eligibleQuestions = view.questions.filter(
    (q) =>
      kind !== "restate-answer" ||
      ["answered", "needs-reconfirmation"].includes(q.state),
  );
  const startRequest = () => {
    setRoundId(draftRounds[0]?.id);
    setParentId(undefined);
    setKind("draft-questions");
    setSkillId(view.pins[0]?.skillId);
    setQuestionId(undefined);
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
              <span>{t(kindLabels[job.kind])}</span>
              {job.skillId && (
                <span>
                  {view.pins.find((pin) => pin.skillId === job.skillId)
                    ?.skillName ?? job.skillId}
                </span>
              )}
              {job.questionId && (
                <span>
                  {view.questions.find((q) => q.id === job.questionId)?.text}
                </span>
              )}
              {job.locale && <Tag>{job.locale}</Tag>}
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
                        result: structuredClone(job.result!),
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
        okButtonProps={{
          disabled:
            (needsRound && !roundId) ||
            (needsSkill && !skillId) ||
            (needsQuestion && !questionId) ||
            (kind === "draft-follow-ups" && !parentId) ||
            (kind === "translate-question" && !targetLocale.trim()),
        }}
        onCancel={() => {
          if (!busy) setRequesting(false);
        }}
        onOk={() =>
          void run(async () => {
            await questionnaireRequest(basePath, jobsPath, "POST", {
              kind,
              ...(needsRound ? { roundId } : {}),
              ...(needsSkill ? { skillId } : {}),
              ...(needsQuestion ? { questionId } : {}),
              ...(kind === "translate-question"
                ? { locale: targetLocale }
                : {}),
              ...(kind === "draft-follow-ups"
                ? { parentQuestionId: parentId }
                : {}),
              confirmed: true,
            });
            setRequesting(false);
            await refresh();
          })
        }
      >
        <label className="field-label" htmlFor="drafting-kind">
          {t("drafting.kind")}
        </label>
        <Select
          id="drafting-kind"
          className="questionnaire-version"
          value={kind}
          onChange={(value) => {
            setKind(value);
            setQuestionId(undefined);
          }}
          options={(Object.keys(kindLabels) as DraftingKind[]).map((value) => ({
            value,
            label: t(kindLabels[value]),
          }))}
        />
        {needsSkill && (
          <>
            <label className="field-label" htmlFor="drafting-skill">
              {t("drafting.skill")}
            </label>
            <Select
              id="drafting-skill"
              className="questionnaire-version"
              value={skillId}
              onChange={setSkillId}
              options={view.pins.map((pin) => ({
                value: pin.skillId,
                label: `${pin.skillName} · ${pin.hash.slice(0, 12)}`,
              }))}
            />
          </>
        )}
        {needsQuestion && (
          <>
            <label className="field-label" htmlFor="drafting-question">
              {t("drafting.question")}
            </label>
            <Select
              id="drafting-question"
              className="questionnaire-version"
              value={questionId}
              onChange={setQuestionId}
              options={eligibleQuestions.map((q) => ({
                value: q.id,
                label: q.text,
              }))}
            />
          </>
        )}
        {kind === "translate-question" && (
          <>
            <label className="field-label" htmlFor="drafting-locale">
              {t("drafting.locale")}
            </label>
            <Input
              id="drafting-locale"
              value={targetLocale}
              maxLength={100}
              onChange={(e) => setTargetLocale(e.target.value)}
            />
          </>
        )}
        {needsRound && !draftRounds.length && (
          <Alert type="info" message={t("drafting.needRound")} />
        )}
        {needsRound && (
          <>
            <label className="field-label" htmlFor="drafting-round">
              {t("drafting.round")}
            </label>
            <Select
              id="drafting-round"
              className="questionnaire-version"
              value={roundId}
              onChange={setRoundId}
              options={draftRounds.map((r) => ({
                value: r.id,
                label: r.title,
              }))}
            />
          </>
        )}
        {kind === "draft-follow-ups" && (
          <>
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
          </>
        )}
        {failure && <Alert type="error" message={failure} />}
      </Modal>
      <Modal
        open={review !== null && editing === null && preview === null}
        title={t("drafting.review")}
        width={800}
        okText={t("drafting.preview")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !review || !hasDraftItems(review.result) }}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() =>
          void run(async () => {
            if (review)
              await previewDecision(review.job, "accept", review.result);
          })
        }
      >
        {review?.job.questionId && (
          <p>
            {view.questions.find((q) => q.id === review.job.questionId)?.text} ·{" "}
            {review.job.locale ?? view.version.locale}
          </p>
        )}
        {review && (
          <DraftResultView
            result={review.result}
            view={view}
            questionId={review.job.questionId}
            onChange={(result) => setReview({ ...review, result })}
          />
        )}
        {review &&
          "questions" in review.result &&
          review.result.questions.map((item, index) => {
            const q = "question" in item ? item.question : item;
            return (
              <section key={index} className="drafting-suggestion">
                {"question" in item && (
                  <>
                    <p>
                      {t("drafting.sourceNumber")} {item.number}
                    </p>
                    <DraftEvidence evidence={[item.source]} />
                  </>
                )}
                <h3>{q.text}</h3>
                <p className="questionnaire-text">{q.rationale}</p>
                <AnswerTypeDetails type={q.answerType} />
                <p>
                  {t(`questionnaire.topic.${q.topic}` as MessageId)} ·{" "}
                  {q.priority}
                </p>
                <Space wrap>
                  <Button onClick={() => setEditing(index)}>
                    {t("drafting.edit")}
                  </Button>
                  <Button
                    onClick={() =>
                      setReview({
                        ...review,
                        result: changeDraftQuestion(review.result, index, null),
                      })
                    }
                  >
                    {t("drafting.remove")}
                  </Button>
                </Space>
              </section>
            );
          })}
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
            roundId={review.job.roundId!}
            suggestion={draftQuestions(review.result)[editing]}
            view={view}
            onSaved={() => undefined}
            onCancel={() => setEditing(null)}
            onDraft={(content) => {
              setReview({
                ...review,
                result: changeDraftQuestion(review.result, editing, content),
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
          preview?.action === "accept"
            ? "drafting.acceptResult"
            : "drafting.discard",
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
            {preview.decision.questions.map((item, index) => {
              const q = "question" in item ? item.question : item;
              return (
                <section key={index}>
                  {"question" in item && (
                    <>
                      <p>
                        {t("drafting.sourceNumber")} {item.number}
                      </p>
                      <DraftEvidence evidence={[item.source]} />
                    </>
                  )}
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
              );
            })}
          </>
        ) : preview && !("reason" in preview.decision) ? (
          <DraftResultView
            result={preview.decision}
            view={view}
            questionId={review?.job.questionId}
          />
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
