import {
  CheckOutlined,
  CopyOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Tooltip,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { draftingEffectLabels } from "../../api/drafting-jobs.js";
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
import { normalizeBasePath } from "../../app/paths.js";
import { StatusPill, type PillTone } from "../../components/StatusPill.js";
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

const statusTones: Record<DraftingJob["status"], PillTone> = {
  queued: "neutral",
  claimed: "info",
  submitted: "warning",
  accepted: "success",
  rejected: "neutral",
  cancelled: "neutral",
};

export function DraftingJobs({
  basePath,
  path,
  jobsHref,
  view,
  onChanged,
}: {
  basePath: string;
  path: string;
  jobsHref: string;
  view: QuestionnaireView;
  onChanged(): void;
}) {
  const { t, format } = useI18n();
  const location = useLocation();
  const parameters = new URLSearchParams(location.search);
  const linkedJobId = parameters.get("job");
  const isActive = parameters.get("panel") === "suggestions";
  const jobsPath = path.replace(/\/questionnaire$/u, "/drafting-jobs");
  const [jobs, setJobs] = useState<DraftingJob[]>([]);
  const [statuses, setStatuses] = useState<DraftingJob["status"][]>([
    "queued",
    "claimed",
    "submitted",
  ]);
  const [failure, setFailure] = useState<string | null>(null);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
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
  const [decisionJob, setDecisionJob] = useState<DraftingJob | null>(null);
  const canDecide = view.capabilities.compose;
  const visibleJobs = jobs.filter((job) => statuses.includes(job.status));
  const linkedJob = jobs.find((job) => job.id === linkedJobId);
  const revealedVisit = useRef<string | null>(null);
  const scrolledVisit = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive || !linkedJob) return;
    const visit = `${location.key}:${linkedJob.id}`;
    if (revealedVisit.current === visit) return;
    revealedVisit.current = visit;
    setStatuses((current) =>
      current.includes(linkedJob.status)
        ? current
        : [...current, linkedJob.status],
    );
  }, [isActive, location.key, linkedJob?.id, linkedJob?.status]);
  useEffect(() => {
    if (!isActive || !linkedJob || !statuses.includes(linkedJob.status)) return;
    const visit = `${location.key}:${linkedJob.id}`;
    if (scrolledVisit.current === visit) return;
    const card = document.getElementById(`drafting-job-${linkedJob.id}`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "instant" });
    scrolledVisit.current = visit;
  }, [isActive, location.key, linkedJob?.id, linkedJob?.status, statuses]);
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
            (job): job is DraftingJob =>
              job.kind !== "draft-plan" &&
              job.kind !== "authoring-lane" &&
              job.kind !== "review-vote",
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
      await refresh();
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
  const copyAgentPrompt = async (job: DraftingJob) => {
    const base = normalizeBasePath(basePath);
    let prompt: string;
    try {
      const result = await questionnaireRequest<{ prompt: string }>(
        basePath,
        `${jobsPath}/${job.id}/prompt`,
      );
      prompt = `Use the connected Badger MCP for deployment ${window.location.origin}${base === "/" ? "" : base}.\n\n${result.prompt}`;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("prompts.failed"));
      return;
    }
    setCopiedJobId(null);
    setManualPrompt(null);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedJobId(job.id);
    } catch {
      setManualPrompt(prompt);
    }
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
      setDecisionJob(null);
      setSavedJobId(null);
      setReview(null);
      setDiscard(null);
      setEditing(null);
      await refresh();
      onChanged();
    });
  return (
    <section className="drafting-panel" aria-label={t("drafting.title")}>
      <div className="drafting-panel-header">
        <div className="drafting-panel-intro">
          <h2 className="pane-title">{t("drafting.title")}</h2>
          <Tooltip
            title={t("drafting.help")}
            trigger={["hover", "focus"]}
            placement="bottomLeft"
          >
            <Button
              type="text"
              size="small"
              className="drafting-help"
              aria-label={t("drafting.about")}
              icon={<InfoCircleOutlined aria-hidden="true" />}
            />
          </Tooltip>
        </div>
        <Space wrap>
          {canDecide && (
            <Button
              icon={<PlusOutlined aria-hidden="true" />}
              disabled={busy}
              onClick={startRequest}
            >
              {t("drafting.request")}
            </Button>
          )}
          <Button
            type="text"
            icon={<ReloadOutlined aria-hidden="true" />}
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t("workflow.reload")}
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              selectable: true,
              multiple: true,
              selectedKeys: statuses,
              items: (Object.keys(statusTones) as DraftingJob["status"][]).map(
                (status) => ({
                  key: status,
                  label: t(`drafting.state.${status}`),
                  icon: (
                    <CheckOutlined
                      aria-hidden="true"
                      style={{
                        visibility: statuses.includes(status)
                          ? "visible"
                          : "hidden",
                      }}
                    />
                  ),
                  role: "menuitemcheckbox",
                  "aria-checked": statuses.includes(status),
                }),
              ),
              onSelect: ({ selectedKeys }) =>
                setStatuses(selectedKeys as DraftingJob["status"][]),
              onDeselect: ({ selectedKeys }) =>
                setStatuses(selectedKeys as DraftingJob["status"][]),
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<FilterOutlined aria-hidden="true" />}
            >
              {t("drafting.filterStatus")}
            </Button>
          </Dropdown>
        </Space>
      </div>
      {failure && <Alert type="error" showIcon message={failure} />}
      {savedJobId && (
        <Alert type="success" showIcon message={t("drafting.reviewSaved")} />
      )}
      {!visibleJobs.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("drafting.empty")}
        />
      ) : (
        <p className="drafting-summary muted" role="status">
          {format("drafting.summary", {
            total: visibleJobs.length,
            review: visibleJobs.filter((job) => job.status === "submitted")
              .length,
          })}
        </p>
      )}
      <ul className="drafting-jobs-list">
        {visibleJobs.map((job) => {
          const result = job.review?.result ?? job.result;
          const summary = result
            ? "questions" in result
              ? draftQuestions(result)[0]?.text
              : "interfaces" in result
                ? result.facts[0]?.statement
                : "facts" in result
                  ? result.facts[0]?.text
                  : result.text
            : undefined;
          const roundTitle = view.rounds.find(
            (round) => round.id === job.roundId,
          )?.title;
          return (
            <li
              className={`drafting-job${job.id === linkedJobId ? " drafting-job-linked" : ""}`}
              id={`drafting-job-${job.id}`}
              key={job.id}
              data-testid="drafting-job"
            >
              <Link
                className="drafting-job-body"
                to={`${jobsHref}&job=${encodeURIComponent(job.id)}`}
                title={t("drafting.linkHelp")}
                aria-current={job.id === linkedJobId ? "location" : undefined}
              >
                <div className="drafting-job-heading">
                  <h3>{t(kindLabels[job.kind])}</h3>
                  <div className="drafting-job-status">
                    {job.review && (
                      <StatusPill tone="success">
                        <CheckOutlined aria-hidden="true" />
                        {t("drafting.savedEdits")}
                      </StatusPill>
                    )}
                    <StatusPill tone={statusTones[job.status]}>
                      {t(`drafting.state.${job.status}`)}
                    </StatusPill>
                  </div>
                </div>
                {summary && <p className="drafting-job-preview">{summary}</p>}
                <dl className="drafting-job-context">
                  {job.skillId && (
                    <div>
                      <dt>{t("drafting.skill")}</dt>
                      <dd>
                        {view.pins.find((pin) => pin.skillId === job.skillId)
                          ?.skillName ?? job.skillId}
                      </dd>
                    </div>
                  )}
                  {roundTitle && (
                    <div>
                      <dt>{t("drafting.round")}</dt>
                      <dd>{roundTitle}</dd>
                    </div>
                  )}
                  {job.questionId && (
                    <div>
                      <dt>{t("drafting.question")}</dt>
                      <dd>
                        {view.questions.find((q) => q.id === job.questionId)
                          ?.text ?? job.questionId}
                      </dd>
                    </div>
                  )}
                  {job.parentQuestionId && (
                    <div>
                      <dt>{t("drafting.parent")}</dt>
                      <dd>
                        {view.questions.find(
                          (question) => question.id === job.parentQuestionId,
                        )?.text ?? job.parentQuestionId}
                      </dd>
                    </div>
                  )}
                  {job.locale && (
                    <div>
                      <dt>{t("drafting.language")}</dt>
                      <dd>{job.locale}</dd>
                    </div>
                  )}
                </dl>
              </Link>
              {job.status === "claimed" && (
                <p className="muted" role="status">
                  {format("drafting.claimedHelp", {
                    host: job.lease?.agentHost ?? t("drafting.agentPrompt"),
                  })}
                </p>
              )}
              {job.status === "queued" && canDecide && (
                <div className="drafting-job-actions">
                  <Button
                    icon={<CopyOutlined aria-hidden="true" />}
                    disabled={busy}
                    onClick={() => void copyAgentPrompt(job)}
                  >
                    {t("drafting.copyPrompt")}
                  </Button>
                  <span className="muted" role="status">
                    {copiedJobId === job.id && t("drafting.promptCopied")}
                  </span>
                </div>
              )}
              {job.status === "submitted" && (
                <div className="drafting-job-actions">
                  <Button
                    type="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const current = await questionnaireRequest<{
                          job: DraftingJob;
                        }>(basePath, `${jobsPath}/${job.id}`);
                        if (current.job.status !== "submitted") {
                          await refresh();
                          return;
                        }
                        setPreview(null);
                        setEditing(null);
                        setSavedJobId(null);
                        setReview({
                          job: current.job,
                          result: structuredClone(
                            current.job.review?.result ?? current.job.result!,
                          ),
                        });
                      })
                    }
                  >
                    {t("drafting.review")}
                  </Button>
                  {canDecide && (
                    <Space wrap>
                      <Button
                        icon={<CopyOutlined aria-hidden="true" />}
                        disabled={busy}
                        onClick={() => void copyAgentPrompt(job)}
                      >
                        {t("drafting.copyPrompt")}
                      </Button>
                      {copiedJobId === job.id && (
                        <span className="muted" role="status">
                          {t("drafting.promptCopied")}
                        </span>
                      )}
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const current = await questionnaireRequest<{
                              job: DraftingJob;
                            }>(basePath, `${jobsPath}/${job.id}`);
                            setDecisionJob(current.job);
                            await previewDecision(
                              current.job,
                              "accept",
                              current.job.review?.result ?? current.job.result!,
                            );
                          })
                        }
                      >
                        {t("drafting.reviewDecisions")}
                      </Button>
                      <Button
                        type="text"
                        danger
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setReason("");
                          setDiscard(job);
                        }}
                      >
                        {t("drafting.discard")}
                      </Button>
                    </Space>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Modal
        open={manualPrompt !== null}
        title={t("drafting.agentPrompt")}
        width={800}
        footer={null}
        onCancel={() => setManualPrompt(null)}
      >
        <p role="status">{t("drafting.copyPromptFailed")}</p>
        <Input.TextArea
          readOnly
          aria-label={t("drafting.agentPrompt")}
          value={manualPrompt ?? ""}
          rows={16}
          className="mcp-configuration"
          onFocus={(event) => event.currentTarget.select()}
        />
      </Modal>
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
        okText={t("drafting.saveReview")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !review || !hasDraftItems(review.result) }}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() =>
          void run(async () => {
            if (!review) return;
            await questionnaireRequest(
              basePath,
              `${jobsPath}/${review.job.id}/review`,
              "POST",
              {
                revision: review.job.revision,
                result: review.result,
              },
            );
            setSavedJobId(review.job.id);
            setReview(null);
            await refresh();
            onChanged();
          })
        }
      >
        <p className="muted">{t("drafting.reviewHelp")}</p>
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
            effectLabels={draftingEffectLabels(review.job)}
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
        title={t(
          preview?.action === "accept"
            ? "drafting.reviewDecisions"
            : "drafting.preview",
        )}
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
              {view.rounds.find((r) => r.id === decisionJob?.roundId)?.title}
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
            questionId={decisionJob?.questionId}
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
