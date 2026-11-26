import { SearchOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
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
  skillVersionHref,
  skillVersionCaption,
  questionnaireRequest,
  QuestionnaireError,
  type Question,
  type QuestionContent,
  type Concern,
  type QuestionnaireVersion,
  type QuestionnaireSubject,
  type SkillQuestionnaireOption,
  type QuestionnaireView,
  type Round,
  type RoundPreview,
} from "../api/questionnaire.js";
import {
  workingDossierPath,
  type WorkingDossierField,
} from "../api/working-dossier.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { StageReviewGuidance } from "../components/StageReviewGuidance.js";
import { ReloadRecordsButton } from "../components/ReloadRecordsButton.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";
import { workflowVersionLabel } from "../util/workflowVersion.js";
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
import { WorkingDossierLedger } from "./working-dossier/WorkingDossierLedger.js";
import { DossierFieldValue } from "./working-dossier/DossierFields.js";
import { useWorkingDossier } from "./working-dossier/useWorkingDossier.js";
import {
  QuestionnaireTabs,
  type QuestionnaireTab,
} from "./questionnaire/QuestionnaireTabs.js";

function subjectQuery(subject: QuestionnaireSubject) {
  return new URLSearchParams(
    "skillId" in subject
      ? {
          skill: subject.skillId,
          skillVersion: subject.versionHash,
        }
      : { workflow: subject.workflowId, version: subject.versionId },
  ).toString();
}

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
  const requestedSkillId = query.get("skill");
  const requestedSkillVersion = query.get("skillVersion");
  const [versions, setVersions] = useState<QuestionnaireVersion[]>([]);
  const [skillVersions, setSkillVersions] = useState<
    SkillQuestionnaireOption[]
  >([]);
  const [selection, setSelection] = useState<QuestionnaireSubject | null>(null);
  const [view, setView] = useState<QuestionnaireView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roundsCollapsed, setRoundsCollapsed] = useState(
    () => window.matchMedia("(max-width: 767px)").matches,
  );
  const roundsContentId = useId();
  const ledgerHeadingId = useId();
  const [busy, setBusy] = useState(false);
  const [newRound, setNewRound] = useState(false);
  const [roundTitle, setRoundTitle] = useState("");
  const [questionSeed, setQuestionSeed] = useState<QuestionContent>();
  const [queueQuestions, setQueueQuestions] = useState(true);
  const [newConcern, setNewConcern] = useState(false);
  const [concernText, setConcernText] = useState("");
  const [editing, setEditing] = useState<{
    roundId: string;
    question?: Question;
    concern?: Concern;
    seed?: QuestionContent;
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
  const workflowSelection =
    selection && "workflowId" in selection ? selection : null;
  const skillSelection = selection && "skillId" in selection ? selection : null;
  const workflowView = view && "workflow" in view ? view : null;
  const skillView = view && "subject" in view ? view : null;
  const activeSubjectId = workflowSelection?.versionId ?? skillView?.subject.id;
  const path = workflowSelection
    ? questionnairePath(
        workflowSelection.workflowId,
        workflowSelection.versionId,
      )
    : skillSelection
      ? `${skillVersionHref(skillSelection.skillId, skillSelection.versionHash)}/questionnaire`
      : null;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const catalog = await questionnaireRequest<{
          versions: QuestionnaireVersion[];
          skillVersions?: SkillQuestionnaireOption[];
        }>(basePath, "/questionnaire", "GET", undefined, controller.signal);
        const recordId = questionId ?? concernId;
        const linked = recordId
          ? await questionnaireRequest<QuestionnaireSubject>(
              basePath,
              `/questionnaire/${questionId ? "questions" : "concerns"}/${encodeURIComponent(recordId)}`,
              "GET",
              undefined,
              controller.signal,
            )
          : null;
        if (controller.signal.aborted) return;
        setVersions(catalog.versions);
        const skills = catalog.skillVersions ?? [];
        setSkillVersions(skills);
        const defaultSkill = skills[0];
        const selected =
          linked ??
          (requestedSkillId && requestedSkillVersion
            ? {
                kind: "skill" as const,
                skillId: requestedSkillId,
                versionHash: requestedSkillVersion,
              }
            : (catalog.versions.find(
                (v) =>
                  v.workflowId === requestedWorkflowId &&
                  v.versionId === requestedVersionId,
              ) ??
              catalog.versions[0] ??
              (defaultSkill
                ? {
                    kind: "skill" as const,
                    skillId: defaultSkill.skillId,
                    versionHash: defaultSkill.versionHash,
                  }
                : null)));
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
    requestedSkillId,
    requestedSkillVersion,
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
    if (activeSubjectId && notice.versionIds.includes(activeSubjectId))
      void reload();
  }, [notice, activeSubjectId, reload]);
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
  const reviewSuggestions = view?.capabilities.reviewSuggestions === true;
  const activeTab: QuestionnaireTab =
    !skillSelection && query.get("panel") === "ledger"
      ? "ledger"
      : query.get("panel") === "suggestions" && reviewSuggestions
        ? "suggestions"
        : "questions";
  const dossierPath =
    workflowSelection &&
    workingDossierPath(
      workflowSelection.workflowId,
      workflowSelection.versionId,
    );
  const hasDossierTarget = selected?.targets.some(
    (target) => target.kind === "field" || target.kind === "interface",
  );
  const {
    dossier: workingDossier,
    failure: dossierFailure,
    accept: acceptDossier,
    reload: reloadDossier,
  } = useWorkingDossier(
    basePath,
    dossierPath,
    workflowSelection?.versionId,
    activeTab !== "questions" || Boolean(hasDossierTarget || editing?.seed),
  );
  const dossierFields = workingDossier?.projection.fields;
  const dossierContext =
    dossierPath && workingDossier
      ? {
          basePath,
          path: dossierPath,
          revision: workingDossier.revision,
          pins: workingDossier.pins,
        }
      : undefined;
  const questionFields =
    dossierFields?.filter((field) =>
      selected?.targets.some(
        (target) =>
          (target.kind === "field" && target.id === field.id) ||
          (target.kind === "interface" &&
            field.scope === "interface" &&
            target.id === field.owner),
      ),
    ) ?? [];
  const showWorkingDossier =
    workingDossier &&
    !workingDossier.legacy &&
    (workingDossier.available || workingDossier.revision > 0);
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
  const versionQuery = selection ? subjectQuery(selection) : "";
  const queueRoundDraft = !skillSelection && !questionSeed && queueQuestions;
  const suggestionsQuery = new URLSearchParams(versionQuery);
  suggestionsQuery.set("panel", "suggestions");
  const groupId = query.get("group");
  if (groupId) suggestionsQuery.set("group", groupId);
  const changePanel = (tab: QuestionnaireTab) => {
    const parameters = new URLSearchParams(location.search);
    for (const [key, value] of new URLSearchParams(versionQuery))
      parameters.set(key, value);
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
  function startDossierQuestion(
    field: WorkingDossierField,
    handoffId?: string,
  ) {
    if (!selection || !compose) return;
    const assignee = view.assignees.some(
      (person) => person.role === "Field expert",
    )
      ? "Field expert"
      : "Workflow owner";
    const handoff = handoffId
      ? workingDossier?.content.interfaces[handoffId]
      : undefined;
    const citations = handoff
      ? [
          ...handoff.producerEvidence,
          ...handoff.consumerEvidence,
          ...(field.content?.evidence ?? []),
        ]
      : (field.content?.evidence ?? []);
    const seed: QuestionContent = {
      text: "",
      topic: field.topic,
      rationale: field.blocker ?? field.content?.reason ?? "",
      targets: handoffId
        ? [{ kind: "interface", id: handoffId }]
        : [{ kind: "field", id: field.id }],
      assignees: [{ kind: "role", role: assignee }],
      evidence: citations
        .filter((locator) =>
          workingDossier?.pins.some(
            (pin) =>
              pin.skillId === locator.skillId && pin.hash === locator.hash,
          ),
        )
        .map(({ skillId, hash, path, startLine, endLine }) => ({
          skillId,
          versionHash: hash,
          path,
          startLine,
          endLine,
        })),
      priority: 10,
    };
    const draft = view.rounds.find((round) => round.state === "draft");
    if (!draft) {
      setQuestionSeed(seed);
      setRoundTitle(t("workingDossier.questionRound"));
      setNewRound(true);
      return;
    }
    setEditing({ roundId: draft.id, seed });
    navigate(
      `/questionnaire?${versionQuery}&round=${encodeURIComponent(draft.id)}`,
    );
  }

  const ledgerHistory =
    workflowView && path ? (
      <QuestionnaireLedger
        basePath={basePath}
        path={path}
        view={workflowView}
        sinceRound={query.get("sinceRound")}
        showReadiness={!showWorkingDossier}
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
    ) : null;

  return (
    <div className="page page-registry" data-testid="page-questionnaire">
      <PageHeader
        title={t("page.questionnaire.title")}
        description={t("page.questionnaire.description")}
      />
      <div className="questionnaire-toolbar">
        <Select
          className="questionnaire-version"
          aria-label={t("questionnaire.subject")}
          placeholder={t("questionnaire.chooseVersion")}
          value={versionQuery || undefined}
          showSearch={{ optionFilterProp: "label" }}
          virtual={false}
          options={[
            ...(versions.length
              ? [
                  {
                    label: t("questionnaire.workflowVersions"),
                    options: versions.map((version) => ({
                      value: subjectQuery(version),
                      label: `${version.workflowName} · ${workflowVersionLabel(version)}`,
                    })),
                  },
                ]
              : []),
            ...(skillVersions.length
              ? [
                  {
                    label: t("questionnaire.skillVersions"),
                    options: skillVersions.map((version) => ({
                      value: subjectQuery({ kind: "skill", ...version }),
                      label: `${version.skillName} · ${skillVersionCaption(version.versionHash, version.label)} · ${version.groupName}${version.retiredAt ? ` · ${t("questionnaire.retiredSkillVersion")}` : ""}`,
                    })),
                  },
                ]
              : []),
          ]}
          onChange={(value) => navigate(`/questionnaire?${value}`)}
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
        <ReloadRecordsButton
          onClick={() => {
            void reload();
            void reloadDossier();
          }}
        />
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
      {workflowView && <StageReviewGuidance stage="questionnaire" />}
      {skillView && (
        <p className="muted">
          {skillView.groupName} · {skillView.skill.name} ·{" "}
          {skillView.subject.label && `${skillView.subject.label} · `}
          {skillView.subject.retiredAt &&
            `${t("questionnaire.retiredSkillVersion")} · `}
          <Link
            to={skillVersionHref(
              skillView.skill.id,
              skillView.subject.versionHash,
            )}
          >
            {skillView.subject.versionHash}
          </Link>
        </p>
      )}
      <QuestionnaireTabs
        key={path ?? "unselected"}
        activeTab={activeTab}
        onChange={changePanel}
        suggestions={
          workflowView && path && reviewSuggestions ? (
            <DraftingJobs
              key={path}
              basePath={basePath}
              path={path}
              jobsHref={`/questionnaire?${suggestionsQuery}`}
              view={workflowView}
              acceptStudyRecords={workingDossier?.legacy ?? false}
              onChanged={() => void reload()}
            />
          ) : undefined
        }
        ledger={
          workflowView && path ? (
            <section
              className="questionnaire-ledger"
              aria-labelledby={ledgerHeadingId}
              data-testid="questionnaire-ledger"
            >
              <h2 className="pane-title" id={ledgerHeadingId}>
                {t("ledger.title")}
              </h2>
              {dossierFailure && (
                <Alert
                  type="error"
                  showIcon
                  title={dossierFailure}
                  action={
                    <ReloadRecordsButton onClick={() => void reloadDossier()} />
                  }
                />
              )}
              {workingDossier && dossierContext && showWorkingDossier ? (
                <>
                  <WorkingDossierLedger
                    key={`${path}:${query.get("dossierField") ?? ""}`}
                    dossier={workingDossier}
                    context={dossierContext}
                    linkedField={query.get("dossierField")}
                    onAsk={startDossierQuestion}
                    onSaved={(dossier) => {
                      acceptDossier(dossier);
                      void reload();
                    }}
                    onReload={reloadDossier}
                  />
                  <Collapse
                    defaultActiveKey={
                      query.has("sinceRound") ? ["history"] : []
                    }
                    items={[
                      {
                        key: "history",
                        label: t("ledger.records"),
                        children: ledgerHistory,
                      },
                    ]}
                  />
                </>
              ) : workingDossier ? (
                <>
                  <p className="muted">
                    {t(
                      workingDossier.legacy
                        ? "ledger.legacyDescription"
                        : "workingDossier.waitForCheck",
                    )}
                  </p>
                  {ledgerHistory}
                </>
              ) : (
                !dossierFailure && <p role="status">{t("common.loading")}</p>
              )}
            </section>
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
                    setQuestionSeed(undefined);
                  }}
                >
                  {t("questionnaire.newRound")}
                </Button>
                {workflowView && (
                  <Button
                    onClick={() => {
                      setRoundLimit(workflowView.settings.roundSizeLimit);
                      setSettingsRevision(workflowView.settings.revision);
                      setSettings(true);
                    }}
                  >
                    {t("questionnaire.roundLimit")}
                  </Button>
                )}
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
            {!skillSelection && (
              <>
                <h2 className="pane-title">{t("questionnaire.concerns")}</h2>
                {!view?.concerns.length && (
                  <p className="muted">{t("questionnaire.noConcerns")}</p>
                )}
                <ul className="questionnaire-concerns">
                  {view?.concerns.map((concern) => (
                    <li key={concern.id}>
                      <Link
                        to={`/questionnaire/concerns/${encodeURIComponent(concern.id)}`}
                        aria-current={
                          concern.id === concernId ? "page" : undefined
                        }
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
              </>
            )}
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
                seed={editing.seed}
                view={view}
                dossierFields={dossierFields}
                relatedWorkflows={
                  skillView
                    ? [
                        ...new Map(
                          versions.map(({ workflowId, workflowName }) => [
                            workflowId,
                            workflowName,
                          ]),
                        ),
                      ].map(([value, label]) => ({ value, label }))
                    : undefined
                }
                onSaved={openQuestion}
                onCancel={() => setEditing(null)}
              />
            ) : selectedConcern && workflowView && path ? (
              <ConcernPanel
                key={selectedConcern.id}
                basePath={basePath}
                path={path}
                concern={selectedConcern}
                view={workflowView}
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
                      {dossierContext && questionFields.length > 0 && (
                        <div className="working-dossier-field-list">
                          {questionFields.map((field) => (
                            <section
                              className="working-dossier-field"
                              key={field.id}
                            >
                              <h4>
                                {field.ownerLabel} · {field.label}
                              </h4>
                              <DossierFieldValue
                                field={field}
                                context={dossierContext}
                              />
                              <Link
                                to={`/questionnaire?${versionQuery}&panel=ledger&dossierField=${encodeURIComponent(field.id)}`}
                              >
                                {t("workingDossier.openField")}
                              </Link>
                            </section>
                          ))}
                        </div>
                      )}
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
                        skillVersions={skillVersions}
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
        onCancel={() => {
          setNewRound(false);
          setQuestionSeed(undefined);
        }}
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
              {
                title: roundTitle,
                draftQuestions: queueRoundDraft,
              },
            );
            setNewRound(false);
            if (questionSeed)
              setEditing({ roundId: result.round.id, seed: questionSeed });
            setQuestionSeed(undefined);
            navigate(
              `/questionnaire?${versionQuery}&round=${encodeURIComponent(result.round.id)}${queueRoundDraft ? "&panel=suggestions" : ""}`,
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
        {!skillSelection && !questionSeed && (
          <>
            <p>
              <Checkbox
                checked={queueQuestions}
                onChange={(event) => setQueueQuestions(event.target.checked)}
              >
                {t("prompts.queueQuestions")}
              </Checkbox>
            </p>
            <p className="muted">{t("prompts.roundHelp")}</p>
          </>
        )}
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
