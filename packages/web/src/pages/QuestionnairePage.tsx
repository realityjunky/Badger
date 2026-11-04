import { SearchOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
} from "antd";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  questionnairePath,
  questionnaireRequest,
  QuestionnaireError,
  type Question,
  type Concern,
  type QuestionnaireVersion,
  type QuestionnaireView,
  type Round,
  type RoundPreview,
} from "../api/questionnaire.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";
import {
  AnswerEditor,
  type AnswerEditorHandle,
} from "./questionnaire/AnswerEditor.js";
import { QuestionComposer } from "./questionnaire/QuestionComposer.js";
import { DraftingJobs } from "./questionnaire/DraftingJobs.js";
import { QuestionResolution } from "./questionnaire/QuestionResolution.js";
import { QuestionInspector } from "./questionnaire/QuestionInspector.js";
import { AnswerContent } from "./questionnaire/AnswerContent.js";
import { AnswerTypeDetails } from "./questionnaire/AnswerTypeDetails.js";
import { QuestionThread } from "./questionnaire/QuestionThread.js";
import { ConcernPanel } from "./questionnaire/ConcernPanel.js";
import { QuestionnaireLedger } from "./questionnaire/QuestionnaireLedger.js";
import {
  QuestionnaireTabs,
  type QuestionnaireTab,
} from "./questionnaire/QuestionnaireTabs.js";

export function QuestionnairePage() {
  const { t, format, locale } = useI18n();
  const { connected, notice } = useLiveUpdates();
  const basePath = readBasePath(document);
  const { questionId, concernId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const requestedWorkflowId = query.get("workflow");
  const requestedVersionId = query.get("version");
  const [versions, setVersions] = useState<QuestionnaireVersion[]>([]);
  const [selection, setSelection] = useState<{
    workflowId: string;
    versionId: string;
  } | null>(null);
  const [view, setView] = useState<QuestionnaireView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roundsCollapsed, setRoundsCollapsed] = useState(
    () => window.matchMedia("(max-width: 767px)").matches,
  );
  const roundsContentId = useId();
  const [busy, setBusy] = useState(false);
  const [newRound, setNewRound] = useState(false);
  const [roundTitle, setRoundTitle] = useState("");
  const [newConcern, setNewConcern] = useState(false);
  const [concernText, setConcernText] = useState("");
  const [editing, setEditing] = useState<{
    roundId: string;
    question?: Question;
    concern?: Concern;
  } | null>(null);
  const [publication, setPublication] = useState<{
    round: Round;
    preview: RoundPreview;
  } | null>(null);
  const [settings, setSettings] = useState(false);
  const [roundLimit, setRoundLimit] = useState<number | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const answerEditor = useRef<AnswerEditorHandle>(null);
  const requestSequence = useRef(0);
  const path = selection
    ? questionnairePath(selection.workflowId, selection.versionId)
    : null;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const catalog = await questionnaireRequest<{
          versions: QuestionnaireVersion[];
        }>(basePath, "/questionnaire", "GET", undefined, controller.signal);
        const recordId = questionId ?? concernId;
        const linked = recordId
          ? await questionnaireRequest<{
              workflowId: string;
              versionId: string;
            }>(
              basePath,
              `/questionnaire/${questionId ? "questions" : "concerns"}/${encodeURIComponent(recordId)}`,
              "GET",
              undefined,
              controller.signal,
            )
          : null;
        if (controller.signal.aborted) return;
        setVersions(catalog.versions);
        const selected =
          linked ??
          catalog.versions.find(
            (v) =>
              v.workflowId === requestedWorkflowId &&
              v.versionId === requestedVersionId,
          ) ??
          catalog.versions[0] ??
          null;
        setSelection(selected);
      } catch (error) {
        if (!controller.signal.aborted) {
          setView(null);
          setSelection(null);
          setFailure(
            error instanceof Error ? error.message : t("questionnaire.failed"),
          );
        }
      }
    })();
    return () => controller.abort();
  }, [
    basePath,
    questionId,
    concernId,
    requestedWorkflowId,
    requestedVersionId,
  ]);

  const reload = useCallback(async () => {
    if (path === null) return null;
    const sequence = ++requestSequence.current;
    try {
      const loaded = await questionnaireRequest<QuestionnaireView>(
        basePath,
        path,
      );
      // A newer refresh owns the display, but this caller still needs its
      // records (for example, a submission awaiting its saved drafts).
      if (sequence !== requestSequence.current) return loaded;
      setView(loaded);
      setFailure(null);
      return loaded;
    } catch (error) {
      if (sequence === requestSequence.current) {
        if (
          error instanceof QuestionnaireError &&
          [401, 403, 404].includes(error.status)
        )
          setView(null);
        setFailure(
          error instanceof Error ? error.message : t("questionnaire.failed"),
        );
      }
      return null;
    }
  }, [basePath, path]);
  useEffect(() => {
    setView(null);
    setEditing(null);
    setPublication(null);
    void reload();
    return () => {
      requestSequence.current++;
    };
  }, [reload]);
  useEffect(() => {
    if (selection && notice.versionIds.includes(selection.versionId))
      void reload();
  }, [notice, selection?.versionId, reload]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, 10000);
    const focus = () => void reload();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [reload]);

  const roundId = questionId
    ? view?.questions.find((q) => q.id === questionId)?.roundId
    : (query.get("round") ?? view?.rounds[0]?.id);
  const round = view?.rounds.find((r) => r.id === roundId);
  const selected = concernId
    ? undefined
    : questionId
      ? view?.questions.find((q) => q.id === questionId)
      : view?.questions.find((q) => q.roundId === roundId);
  const selectedConcern = view?.concerns.find((c) => c.id === concernId);
  const compose = view?.capabilities.compose === true;
  const activeTab: QuestionnaireTab =
    query.get("panel") === "ledger"
      ? "ledger"
      : query.get("panel") === "suggestions" && compose
        ? "suggestions"
        : "questions";
  const ownAnswer = view?.answers.find(
    (a) => a.questionId === selected?.id && a.personId === view.personId,
  );
  const submitted =
    view?.answers
      .filter((a) => a.questionId === selected?.id)
      .map((a) => ({
        ...a,
        revisions: a.revisions.filter((r) => r.state === "submitted"),
      }))
      .filter((a) => a.revisions.length > 0) ?? [];
  const versionQuery = selection
    ? `workflow=${encodeURIComponent(selection.workflowId)}&version=${encodeURIComponent(selection.versionId)}`
    : "";
  const changePanel = (tab: QuestionnaireTab) => {
    const parameters = new URLSearchParams(location.search);
    if (selection) {
      parameters.set("workflow", selection.workflowId);
      parameters.set("version", selection.versionId);
    }
    if (tab === "questions") parameters.delete("panel");
    else parameters.set("panel", tab);
    navigate({ pathname: location.pathname, search: parameters.toString() });
  };
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
  const submitRound = async () => {
    if (!view || !path || !round) return;
    if (
      selected?.canAnswer &&
      answerEditor.current &&
      !(await answerEditor.current.flush())
    )
      throw new Error(t("questionnaire.saveBeforeSubmit"));
    const current = await reload();
    if (!current) return;
    const inputs = [];
    for (const q of current.questions.filter(
      (q) => q.roundId === round.id && q.canAnswer,
    )) {
      const answer = current.answers.find(
        (a) => a.questionId === q.id && a.personId === current.personId,
      );
      if (!answer || answer.questionRevision !== q.revision)
        throw new Error(t("questionnaire.saveBeforeSubmit"));
      if (answer.state === "draft")
        inputs.push({
          questionId: q.id,
          questionRevision: q.revision,
          revision: answer.revision,
        });
    }
    if (inputs.length === 0) return;
    await questionnaireRequest(
      basePath,
      `${path}/rounds/${encodeURIComponent(round.id)}/submit`,
      "POST",
      { answers: inputs },
    );
    await reload();
  };
  const openQuestion = (question: Question) => {
    setEditing(null);
    navigate(`/questionnaire/questions/${encodeURIComponent(question.id)}`);
    void reload();
  };

  return (
    <div className="page page-registry" data-testid="page-questionnaire">
      <PageHeader
        title={t("page.questionnaire.title")}
        description={t("page.questionnaire.description")}
      />
      <div className="questionnaire-toolbar">
        <Select
          className="questionnaire-version"
          aria-label={t("questionnaire.workflowVersion")}
          placeholder={t("questionnaire.chooseVersion")}
          value={
            selection
              ? `${selection.workflowId}/${selection.versionId}`
              : undefined
          }
          options={versions.map((v) => ({
            value: `${v.workflowId}/${v.versionId}`,
            label: `${v.workflowName} · v${v.number}`,
          }))}
          onChange={(value) => {
            const chosen = versions.find(
              (v) => `${v.workflowId}/${v.versionId}` === value,
            )!;
            navigate(
              `/questionnaire?workflow=${encodeURIComponent(chosen.workflowId)}&version=${encodeURIComponent(chosen.versionId)}`,
            );
          }}
        />
        {view && (
          <Tag>
            {t(
              compose
                ? "questionnaire.mode.engineer"
                : "questionnaire.mode.expert",
            )}
          </Tag>
        )}
        <span className="muted" role="status">
          {t(connected ? "questionnaire.live" : "questionnaire.polling")}
        </span>
        <Button onClick={() => void reload()}>{t("workflow.reload")}</Button>
        {view?.capabilities.raiseConcern && (
          <Button
            onClick={() => {
              setConcernText("");
              setNewConcern(true);
            }}
          >
            {t("questionnaire.raiseConcern")}
          </Button>
        )}
      </div>
      {failure && <Alert type="error" showIcon message={failure} />}
      <QuestionnaireTabs
        key={path ?? "unselected"}
        activeTab={activeTab}
        onChange={changePanel}
        suggestions={
          view && path && compose ? (
            <DraftingJobs
              key={path}
              basePath={basePath}
              path={path}
              view={view}
              onChanged={() => void reload()}
            />
          ) : undefined
        }
        ledger={
          view && path ? (
            <QuestionnaireLedger
              basePath={basePath}
              path={path}
              view={view}
              sinceRound={query.get("sinceRound")}
              onSinceRound={(id) => {
                const parameters = new URLSearchParams(location.search);
                if (id) parameters.set("sinceRound", id);
                else parameters.delete("sinceRound");
                navigate({
                  pathname: location.pathname,
                  search: parameters.toString(),
                });
              }}
              onChanged={reload}
            />
          ) : null
        }
      >
        <div className="questionnaire-reading-toolbar">
          <Button
            aria-expanded={!roundsCollapsed}
            aria-controls={roundsContentId}
            onClick={() => setRoundsCollapsed((value) => !value)}
          >
            {t(
              roundsCollapsed
                ? "questionnaire.showRounds"
                : "questionnaire.hideRounds",
            )}
          </Button>
          <QuestionInspector
            basePath={basePath}
            path={path}
            question={selected}
            concern={selectedConcern}
            view={view}
            active={activeTab === "questions"}
          />
        </div>
        <div
          className="questionnaire-layout"
          data-testid="questionnaire-layout"
          data-rounds-collapsed={roundsCollapsed}
        >
          <section
            className="pane explorer-pane"
            data-testid="explorer-pane"
            aria-label={t("questionnaire.explorer")}
            id={roundsContentId}
            hidden={roundsCollapsed}
          >
            <Input
              allowClear
              prefix={<SearchOutlined aria-hidden="true" />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("questionnaire.searchQuestions")}
              aria-label={t("questionnaire.searchQuestions")}
              data-testid="question-search"
            />
            <h2 className="pane-title">{t("questionnaire.rounds")}</h2>
            {compose && (
              <Space wrap>
                <Button
                  onClick={() => {
                    setNewRound(true);
                    setRoundTitle("");
                  }}
                >
                  {t("questionnaire.newRound")}
                </Button>
                <Button
                  onClick={() => {
                    setRoundLimit(view?.settings.roundSizeLimit ?? null);
                    setSettingsRevision(view?.settings.revision ?? 0);
                    setSettings(true);
                  }}
                >
                  {t("questionnaire.roundLimit")}
                </Button>
              </Space>
            )}
            {!view?.rounds.length && (
              <p className="muted">{t("questionnaire.empty")}</p>
            )}
            <ol className="questionnaire-rounds">
              {view?.rounds.map((r) => (
                <li key={r.id}>
                  <Link
                    className="questionnaire-round-link"
                    to={`/questionnaire?${versionQuery}&round=${encodeURIComponent(r.id)}`}
                    onClick={() => setEditing(null)}
                    aria-current={round?.id === r.id ? "true" : undefined}
                  >
                    {r.number}. {r.title}{" "}
                    <Tag>{t(`questionnaire.state.${r.state}`)}</Tag>
                  </Link>
                  <ol className="questionnaire-questions">
                    {view.questions
                      .filter(
                        (q) =>
                          q.roundId === r.id &&
                          (!search ||
                            `${q.text} ${q.topic}`
                              .toLowerCase()
                              .includes(search.toLowerCase())),
                      )
                      .map((q) => (
                        <li key={q.id}>
                          <Link
                            to={`/questionnaire/questions/${encodeURIComponent(q.id)}`}
                            aria-current={
                              selected?.id === q.id ? "page" : undefined
                            }
                            onClick={() => setEditing(null)}
                          >
                            {q.text}
                          </Link>
                          <span className="questionnaire-question-meta">
                            {q.priority} · {t(`questionnaire.state.${q.state}`)}
                          </span>
                        </li>
                      ))}
                  </ol>
                </li>
              ))}
            </ol>
            <h2 className="pane-title">{t("questionnaire.concerns")}</h2>
            {!view?.concerns.length && (
              <p className="muted">{t("questionnaire.noConcerns")}</p>
            )}
            <ul className="questionnaire-concerns">
              {view?.concerns.map((concern) => (
                <li key={concern.id}>
                  <Link
                    to={`/questionnaire/concerns/${encodeURIComponent(concern.id)}`}
                    aria-current={concern.id === concernId ? "page" : undefined}
                    onClick={() => setEditing(null)}
                  >
                    {concern.text}
                  </Link>
                  <span className="questionnaire-question-meta">
                    {t(`questionnaire.concernState.${concern.state}`)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section
            className="pane main-pane"
            data-testid="main-pane"
            aria-label={t("questionnaire.thread")}
          >
            {view && path && compose && editing ? (
              <QuestionComposer
                key={
                  editing.question?.id ??
                  editing.concern?.id ??
                  `new:${editing.roundId}`
                }
                basePath={basePath}
                path={path}
                roundId={editing.roundId}
                question={editing.question}
                concern={editing.concern}
                view={view}
                onSaved={openQuestion}
                onCancel={() => setEditing(null)}
              />
            ) : selectedConcern && view && path ? (
              <ConcernPanel
                key={selectedConcern.id}
                basePath={basePath}
                path={path}
                concern={selectedConcern}
                view={view}
                onChanged={() => void reload()}
                onQuestion={(roundId) =>
                  setEditing({ roundId, concern: selectedConcern })
                }
              />
            ) : (
              <>
                <h2 className="pane-title">
                  {round?.title ?? t("questionnaire.thread")}
                </h2>
                <Space wrap>
                  {compose && round?.state === "draft" && (
                    <>
                      <Button onClick={() => setEditing({ roundId: round.id })}>
                        {t("questionnaire.newQuestion")}
                      </Button>
                      <Button
                        disabled={
                          busy ||
                          !view?.questions.some((q) => q.roundId === round.id)
                        }
                        onClick={() =>
                          void run(async () => {
                            const result = await questionnaireRequest<{
                              preview: RoundPreview;
                            }>(
                              basePath,
                              `${path}/rounds/${encodeURIComponent(round.id)}/publish-preview`,
                            );
                            setPublication({ round, preview: result.preview });
                          })
                        }
                      >
                        {t("questionnaire.reviewRound")}
                      </Button>
                    </>
                  )}
                  {round?.state === "published" &&
                    view?.questions.some(
                      (q) => q.roundId === round.id && q.canAnswer,
                    ) && (
                      <Button
                        loading={busy}
                        onClick={() => void run(submitRound)}
                      >
                        {t("questionnaire.submitRound")}
                      </Button>
                    )}
                </Space>
                {selected ? (
                  <>
                    <article className="questionnaire-record">
                      <h3>{selected.text}</h3>
                      <Tag>{t(`questionnaire.state.${selected.state}`)}</Tag>
                      <p>{selected.rationale}</p>
                      {compose &&
                        (!selected.resolvedAt ||
                          selected.state === "confirmed") && (
                          <Button
                            onClick={() =>
                              setEditing({
                                roundId: selected.roundId,
                                question: selected,
                              })
                            }
                          >
                            {t("questionnaire.editQuestion")}
                          </Button>
                        )}
                    </article>
                    <div className="questionnaire-answers">
                      {submitted.map((a) => (
                        <article
                          className="questionnaire-answer"
                          key={a.personId}
                        >
                          <h3>
                            {format("questionnaire.answerFrom", {
                              name: a.personName,
                            })}
                          </h3>
                          <p className="muted">
                            {new Date(
                              a.revisions.at(-1)!.createdAt,
                            ).toLocaleString(locale)}{" "}
                            ·{" "}
                            {t(
                              a.revisions.at(-1)!.channel === "mcp"
                                ? "questionnaire.channel.agent"
                                : "questionnaire.channel.web",
                            )}
                            {a.revisions.at(-1)!.agentHost
                              ? ` (${a.revisions.at(-1)!.agentHost})`
                              : ""}
                          </p>
                          <AnswerContent
                            answer={a.revisions.at(-1)!}
                            type={
                              selected.revisions.find(
                                (r) => r.revision === a.questionRevision,
                              )?.answerType
                            }
                            basePath={basePath}
                            path={path!}
                          />
                        </article>
                      ))}
                    </div>
                    {path && view && (
                      <QuestionResolution
                        key={`${selected.id}:${selected.revision}:${selected.resolutionRevision}`}
                        question={selected}
                        view={view}
                        path={path}
                        basePath={basePath}
                        reload={reload}
                      />
                    )}
                    {selected.canAnswer && path && view && (
                      <AnswerEditor
                        key={`answer:${selected.id}`}
                        ref={answerEditor}
                        basePath={basePath}
                        path={path}
                        question={selected}
                        answer={ownAnswer}
                        personId={view.personId}
                        attachmentLimits={view.attachmentLimits}
                        disabled={busy}
                        onSubmitted={() => void reload()}
                      />
                    )}
                    {path && view && (
                      <QuestionThread
                        key={`thread:${selected.id}`}
                        basePath={basePath}
                        path={path}
                        questionId={selected.id}
                        view={view}
                        onChanged={() => void reload()}
                      />
                    )}
                  </>
                ) : (
                  <p className="empty-state">
                    {t(
                      view
                        ? "questionnaire.selectQuestion"
                        : "questionnaire.chooseVersion",
                    )}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </QuestionnaireTabs>
      <Modal
        open={newConcern}
        title={t("questionnaire.raiseConcern")}
        okText={t("questionnaire.raiseConcern")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !concernText.trim() || !path }}
        onCancel={() => {
          if (!busy) setNewConcern(false);
        }}
        onOk={() =>
          void run(async () => {
            const { concern } = await questionnaireRequest<{
              concern: Concern;
            }>(basePath, `${path}/concerns`, "POST", { text: concernText });
            setNewConcern(false);
            navigate(
              `/questionnaire/concerns/${encodeURIComponent(concern.id)}`,
            );
            await reload();
          })
        }
      >
        <p>{t("questionnaire.concernHelp")}</p>
        {failure && <Alert type="error" showIcon message={failure} />}
        <label className="field-label" htmlFor="new-concern">
          {t("questionnaire.concernText")}
        </label>
        <Input.TextArea
          id="new-concern"
          value={concernText}
          maxLength={20000}
          autoSize={{ minRows: 4, maxRows: 12 }}
          disabled={busy}
          onChange={(event) => setConcernText(event.target.value)}
        />
      </Modal>
      <Modal
        open={newRound}
        title={t("questionnaire.newRound")}
        onCancel={() => setNewRound(false)}
        confirmLoading={busy}
        okText={t("questionnaire.createRound")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !roundTitle.trim() }}
        onOk={() =>
          void run(async () => {
            const result = await questionnaireRequest<{ round: Round }>(
              basePath,
              `${path}/rounds`,
              "POST",
              { title: roundTitle },
            );
            setNewRound(false);
            navigate(
              `/questionnaire?${versionQuery}&round=${encodeURIComponent(result.round.id)}`,
            );
            await reload();
          })
        }
      >
        <label className="field-label" htmlFor="round-title">
          {t("questionnaire.roundTitle")}
        </label>
        <Input
          id="round-title"
          value={roundTitle}
          maxLength={200}
          onChange={(event) => setRoundTitle(event.target.value)}
        />
      </Modal>
      <Modal
        open={publication !== null}
        title={t("questionnaire.reviewRound")}
        onCancel={() => setPublication(null)}
        confirmLoading={busy}
        okText={t("questionnaire.publishRound")}
        cancelText={t("common.cancel")}
        onOk={() =>
          void run(async () => {
            if (!publication || !path) return;
            await questionnaireRequest(
              basePath,
              `${path}/rounds/${encodeURIComponent(publication.round.id)}/publish`,
              "POST",
              {
                confirmed: true,
                confirmationHash: publication.preview.confirmationHash,
              },
            );
            setPublication(null);
            await reload();
          })
        }
      >
        <p>{t("questionnaire.publishHelp")}</p>
        <ol>
          {publication?.preview.questions.map((q) => (
            <li key={q.id}>
              {q.text} · {q.priority}
              <AnswerTypeDetails type={q.answerType} />
            </li>
          ))}
        </ol>
      </Modal>
      <Modal
        open={settings}
        title={t("questionnaire.roundLimit")}
        onCancel={() => setSettings(false)}
        confirmLoading={busy}
        okText={t("questionnaire.saveLimit")}
        cancelText={t("common.cancel")}
        onOk={() =>
          void run(async () => {
            await questionnaireRequest(basePath, `${path}/settings`, "PUT", {
              revision: settingsRevision,
              roundSizeLimit: roundLimit,
            });
            setSettings(false);
            await reload();
          })
        }
      >
        <label className="field-label" htmlFor="round-limit">
          {t("questionnaire.roundLimit")}
        </label>
        <InputNumber
          id="round-limit"
          min={1}
          precision={0}
          value={roundLimit}
          onChange={setRoundLimit}
        />
        <p>{t("questionnaire.limitHelp")}</p>
      </Modal>
    </div>
  );
}
