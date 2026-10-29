import { Alert, Button, Collapse, Select, Space, Spin, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  questionnaireRequest,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import type {
  LedgerDraft,
  LedgerItem,
  LedgerView,
  RecordReference,
} from "../../api/ledger.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { LedgerDraftDialog, LedgerDraftHistory } from "./LedgerDrafts.js";

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
  const { t, format } = useI18n();
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{
    kind: LedgerDraft["kind"];
    record?: LedgerDraft;
  } | null>(null);
  const [inspector, setInspector] = useState<{
    record: LedgerDraft;
    revisions: LedgerDraft[];
  } | null>(null);
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
        {item.relatedRecords
          .filter((record) => record.type === "answer")
          .map((record) => (
            <p key={record.id}>
              <Link
                to={`/questionnaire/questions/${encodeURIComponent(item.record.type === "question" ? item.record.id : item.relatedRecords.find((r) => r.type === "question")!.id)}`}
              >
                {format("questionnaire.answerRevision", {
                  number: record.revision,
                })}
              </Link>
            </p>
          ))}
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
    setInspector(null);
    setEditor({ kind, record });
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
                  {readiness.blockers.map((blocker, index) => {
                    const record = blocker.record;
                    return (
                      <li
                        key={`${blocker.code}:${record?.type ?? "private"}:${record?.id ?? index}`}
                      >
                        {t(`ledger.blocker.${blocker.code}`)} ·{" "}
                        {record ? (
                          <>
                            {
                              ledger.handoff.items.find(
                                (item) =>
                                  item.record.id === record.id &&
                                  item.record.type === record.type,
                              )?.statement
                            }{" "}
                            {recordLink(record)}
                          </>
                        ) : (
                          t("ledger.privateQuestion")
                        )}
                      </li>
                    );
                  })}
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
      {editor && (
        <LedgerDraftDialog
          key={`${editor.kind}:${editor.record?.id ?? "new"}:${editor.record?.revision ?? 0}`}
          basePath={basePath}
          path={path}
          view={view}
          editor={editor}
          topics={ledger?.handoff.readiness ?? []}
          onClose={() => setEditor(null)}
          onChanged={onChanged}
        />
      )}
      {inspector && (
        <LedgerDraftHistory
          key={`${inspector.record.id}:${inspector.record.revision}`}
          basePath={basePath}
          path={path}
          view={view}
          inspector={inspector}
          onClose={() => setInspector(null)}
          onChanged={onChanged}
          onEdit={(record) => edit(record.kind, record)}
        />
      )}
    </section>
  );
}
