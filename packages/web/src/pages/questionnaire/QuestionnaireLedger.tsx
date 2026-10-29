import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  questionnaireRequest,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import type {
  LedgerDraft,
  LedgerItem,
  LedgerTopic,
  LedgerView,
  RecordReference,
} from "../../api/ledger.js";
import { useI18n } from "../../i18n/I18nContext.js";

/** Display the kernel read model; the dashboard never decides readiness. */
export function QuestionnaireLedger({
  basePath,
  path,
  view,
  sinceRound,
  onSinceRound,
  onChanged,
}: {
  basePath: string;
  path: string;
  view: QuestionnaireView;
  sinceRound: string | null;
  onSinceRound(id: string | null): void;
  onChanged(): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{
    kind: LedgerDraft["kind"];
    record?: LedgerDraft;
  } | null>(null);
  const [statement, setStatement] = useState("");
  const [topic, setTopic] = useState<LedgerTopic>("scope");
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<{
    record: LedgerDraft;
    revisions: LedgerDraft[];
  } | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  useEffect(() => {
    setLedger(null);
    setInspector(null);
    setEditor(null);
  }, [path, sinceRound]);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void questionnaireRequest<LedgerView>(
      basePath,
      `${path}/ledger${sinceRound ? `?sinceRound=${encodeURIComponent(sinceRound)}` : ""}`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setLedger(value);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("questionnaire.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, view, sinceRound]);

  async function run(action: () => Promise<void>) {
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
  }
  const workflowHref = `/workflows/${encodeURIComponent(view.workflow.id)}/versions/${encodeURIComponent(view.version.id)}`;
  function recordLink(record: RecordReference) {
    const label = t("ledger.recordRevision") + ` ${record.revision}`;
    const item = ledger?.handoff.items.find(
      (i) => i.record.type === record.type && i.record.id === record.id,
    );
    if (record.type === "inference" || record.type === "assumption")
      return (
        <Button
          type="link"
          size="small"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setDraftId(record.id);
              setInspector(
                await questionnaireRequest(
                  basePath,
                  `${path}/${record.type === "inference" ? "inferences" : "assumptions"}/${encodeURIComponent(record.id)}`,
                ),
              );
            })
          }
        >
          {label}
        </Button>
      );
    if (record.type === "source-fact" || record.type === "source-interface")
      return (
        <Link
          to={`${workflowHref}?studyRecord=${encodeURIComponent(record.id)}&studyRevision=${record.revision}#source-study`}
        >
          {label}
        </Link>
      );
    if (record.type === "skill-pin")
      return (
        <Link to={`${workflowHref}#source-study`}>
          {item?.statement ?? label}
        </Link>
      );
    const question =
      record.type === "question"
        ? record
        : item?.relatedRecords.find((r) => r.type === "question");
    if (question)
      return (
        <Link
          to={`/questionnaire/questions/${encodeURIComponent(question.id)}`}
        >
          {label}
        </Link>
      );
    return <span>{label}</span>;
  }
  function itemView(item: LedgerItem) {
    return (
      <article
        className="questionnaire-record"
        key={`${item.record.type}:${item.record.id}`}
      >
        <p>{item.statement}</p>
        <Space wrap>
          <Tag>{t(`ledger.state.${item.state}`)}</Tag>
          {recordLink(item.record)}
        </Space>
        {item.resolution?.reason && <p>{item.resolution.reason}</p>}
        {item.relatedRecords
          .filter((r) => r.type === "question")
          .map((record) => (
            <p key={record.id}>
              <Link
                to={`/questionnaire/questions/${encodeURIComponent(record.id)}`}
              >
                {t("ledger.confirmingQuestion")}
              </Link>
            </p>
          ))}
      </article>
    );
  }
  function edit(kind: LedgerDraft["kind"], record?: LedgerDraft) {
    setEditor({ kind, record });
    setStatement(record?.statement ?? "");
    setTopic(record?.topic ?? "scope");
    setQuestionId(record?.questionId ?? null);
  }
  const parts = [
    "confirmedUserFacts",
    "sourceDerivedFacts",
    "agentInferences",
    "unresolvedAssumptions",
    "remainingQuestions",
  ] as const;
  return (
    <section aria-label={t("ledger.title")} data-testid="questionnaire-ledger">
      <h2 className="pane-title">{t("ledger.title")}</h2>
      <p className="muted">{t("ledger.description")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {view.capabilities.compose && (
        <Space wrap>
          <Button onClick={() => edit("inference")}>
            {t("ledger.addInference")}
          </Button>
          <Button onClick={() => edit("assumption")}>
            {t("ledger.addAssumption")}
          </Button>
        </Space>
      )}
      {ledger === null ? (
        !failure && <Spin aria-label={t("common.loading")} />
      ) : (
        <>
          <h3>{t("ledger.readiness")}</h3>
          <p role="status">
            {t(
              ledger.handoff.status === "complete"
                ? "ledger.ready"
                : "ledger.blocked",
            )}
          </p>
          <Collapse
            items={ledger.handoff.readiness.map((readiness) => ({
              key: readiness.topic,
              label: (
                <Space wrap>
                  {t(`questionnaire.topic.${readiness.topic}`)}
                  <Tag color={readiness.ready ? "success" : "warning"}>
                    {t(readiness.ready ? "ledger.ready" : "ledger.blocked")}
                  </Tag>
                </Space>
              ),
              children: readiness.ready ? (
                <p>{t("ledger.noBlockers")}</p>
              ) : (
                <ul>
                  {readiness.blockers.map((blocker) => (
                    <li
                      key={`${blocker.code}:${blocker.record.type}:${blocker.record.id}`}
                    >
                      {t(`ledger.blocker.${blocker.code}`)} ·{" "}
                      {
                        ledger.handoff.items.find(
                          (item) =>
                            item.record.id === blocker.record.id &&
                            item.record.type === blocker.record.type,
                        )?.statement
                      }{" "}
                      {recordLink(blocker.record)}
                    </li>
                  ))}
                </ul>
              ),
            }))}
          />
          <h3>{t("ledger.parts")}</h3>
          <Collapse
            defaultActiveKey={[...parts]}
            items={parts.map((part) => ({
              key: part,
              label: `${t(`ledger.part.${part}`)} (${ledger.handoff.ledger[part].length})`,
              children: ledger.handoff.ledger[part].length ? (
                ledger.handoff.ledger[part].map(itemView)
              ) : (
                <p className="muted">{t("ledger.empty")}</p>
              ),
            }))}
          />
          <h3>{t("ledger.deferred")}</h3>
          {ledger.handoff.deferredQuestions.length ? (
            ledger.handoff.deferredQuestions.map(itemView)
          ) : (
            <p className="muted">{t("ledger.empty")}</p>
          )}
          <h3>{t("ledger.changes")}</h3>
          <label className="field-label" htmlFor="ledger-since-round">
            {t("ledger.sinceRound")}
          </label>
          <Select
            id="ledger-since-round"
            className="questionnaire-version"
            allowClear
            value={sinceRound ?? undefined}
            placeholder={t("ledger.chooseRound")}
            options={ledger.baselines.map((r) => ({
              value: r.id,
              label: `${r.number}. ${r.title}`,
            }))}
            onChange={(id) => onSinceRound(id ?? null)}
          />
          {ledger.changes && (
            <>
              <h4>
                {t("ledger.added")} ({ledger.changes.added.length})
              </h4>
              {ledger.changes.added.map(itemView)}
              <h4>
                {t("ledger.changed")} ({ledger.changes.changed.length})
              </h4>
              {ledger.changes.changed.map((change) => (
                <div
                  key={`${change.before.record.type}:${change.before.record.id}`}
                >
                  <p className="muted">
                    {t("ledger.before")}: {change.before.statement} ·{" "}
                    {t(`ledger.state.${change.before.state}`)}
                  </p>
                  {itemView(change.after ?? change.before)}
                </div>
              ))}
              <h4>
                {t("ledger.resolved")} ({ledger.changes.resolved.length})
              </h4>
              {ledger.changes.resolved.map((change) => itemView(change.after))}
            </>
          )}
        </>
      )}
      <Modal
        open={editor !== null}
        title={t(
          editor?.kind === "assumption"
            ? "ledger.addAssumption"
            : "ledger.addInference",
        )}
        okText={t("ledger.save")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !statement.trim() }}
        onCancel={() => {
          if (!busy) setEditor(null);
        }}
        onOk={() =>
          void run(async () => {
            const resource =
              editor!.kind === "inference" ? "inferences" : "assumptions";
            await questionnaireRequest(
              basePath,
              `${path}/${resource}${editor!.record ? `/${encodeURIComponent(editor!.record.id)}` : ""}`,
              editor!.record ? "PATCH" : "POST",
              {
                statement,
                topic,
                questionId,
                ...(editor!.record
                  ? { revision: editor!.record.revision }
                  : {}),
              },
            );
            setEditor(null);
            setInspector(null);
            await onChanged();
          })
        }
      >
        {failure && <Alert type="error" title={failure} />}
        <p>{t("ledger.draftHelp")}</p>
        <label className="field-label" htmlFor="ledger-statement">
          {t("study.statement")}
        </label>
        <Input.TextArea
          id="ledger-statement"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          maxLength={20000}
          autoSize={{ minRows: 3, maxRows: 10 }}
          disabled={busy}
        />
        <label className="field-label" htmlFor="ledger-topic">
          {t("questionnaire.topic")}
        </label>
        <Select
          id="ledger-topic"
          className="questionnaire-version"
          value={topic}
          disabled={busy}
          options={ledger?.handoff.readiness.map((r) => ({
            value: r.topic,
            label: t(`questionnaire.topic.${r.topic}`),
          }))}
          onChange={(next) => {
            setTopic(next);
            setQuestionId(null);
          }}
        />
        <label className="field-label" htmlFor="ledger-question">
          {t("ledger.confirmingQuestion")}
        </label>
        <Select
          id="ledger-question"
          className="questionnaire-version"
          allowClear
          value={questionId ?? undefined}
          disabled={busy}
          options={view.questions
            .filter(
              (q) =>
                q.topic === topic &&
                (!q.resolvedAt || q.id === editor?.record?.questionId),
            )
            .map((q) => ({ value: q.id, label: q.text }))}
          onChange={(id) => setQuestionId(id ?? null)}
        />
      </Modal>
      <Drawer
        open={inspector !== null}
        onClose={() => setInspector(null)}
        title={t("ledger.history")}
      >
        {failure && <Alert type="error" title={failure} />}
        {inspector?.revisions.map((r) => (
          <article className="questionnaire-record" key={r.revision}>
            <h3>
              {t("ledger.recordRevision")} {r.revision}
            </h3>
            <p>{r.statement}</p>
            <Tag>
              {t(
                r.status === "retired"
                  ? "ledger.state.retired"
                  : "ledger.state.draft",
              )}
            </Tag>
            {r.questionId && (
              <Link
                to={`/questionnaire/questions/${encodeURIComponent(r.questionId)}`}
              >
                {t("ledger.confirmingQuestion")}
              </Link>
            )}
          </article>
        ))}
        {inspector &&
          view.capabilities.compose &&
          inspector.record.status === "active" && (
            <Space wrap>
              <Button
                disabled={busy}
                onClick={() => edit(inspector.record.kind, inspector.record)}
              >
                {t("ledger.edit")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await questionnaireRequest(
                      basePath,
                      `${path}/${inspector.record.kind === "inference" ? "inferences" : "assumptions"}/${encodeURIComponent(draftId!)}`,
                      "DELETE",
                      { revision: inspector.record.revision },
                    );
                    setInspector(null);
                    await onChanged();
                  })
                }
              >
                {t("ledger.retire")}
              </Button>
            </Space>
          )}
      </Drawer>
    </section>
  );
}
