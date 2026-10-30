import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Run } from "../api/runs.js";
import { questionnaireRequest } from "../api/questionnaire.js";
import { loadWorkflows, type WorkflowCatalog } from "../api/workflows.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
const pretty = (value: unknown) => (
  <pre className="run-json">{JSON.stringify(value, null, 2)}</pre>
);
export function RunsPage() {
  const { t, locale, format } = useI18n();
  const { runId } = useParams();
  const [params, setParams] = useSearchParams();
  const workflow = params.get("workflow");
  const afterSequence = params.get("afterSequence");
  const basePath = readBasePath(document);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const time = (value: string) => new Date(value).toLocaleString(locale);
  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflows(basePath, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.kind === "ok")
        setCatalog(result.value);
    });
    return () => controller.abort();
  }, [basePath]);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    setFailure(null);
    setRun(null);
    setRuns(null);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await questionnaireRequest<{ run?: Run; runs?: Run[] }>(
          basePath,
          runId
            ? `/runs/${encodeURIComponent(runId)}${afterSequence === null ? "" : `?afterSequence=${encodeURIComponent(afterSequence)}`}`
            : workflow
              ? `/workflows/${encodeURIComponent(workflow)}/runs`
              : "/me/runs",
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setRun(result.run ?? null);
          setRuns(result.runs ?? null);
          setFailure(null);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : t("run.failed"));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, runId, workflow, afterSequence, refresh]);
  const state = run?.projection;
  const receipts = (state?.artifactReceipts ?? []).map((receipt, i) => ({
    ...receipt,
    id: String(i),
  }));
  return (
    <div className="page runs-page" data-testid="page-runs">
      <PageHeader
        title={run?.localRunId ?? t("page.runs.title")}
        description={t("page.runs.description")}
        actions={
          <Space wrap>
            {runId && (
              <Link
                to={
                  run
                    ? `/runs?workflow=${encodeURIComponent(run.workflowId)}`
                    : "/runs"
                }
              >
                {t("run.back")}
              </Link>
            )}
            <Button onClick={() => setRefresh((v) => v + 1)}>
              {t("workflow.reload")}
            </Button>
          </Space>
        }
      />
      {failure && <Alert type="error" showIcon message={failure} />}
      {!runId && (
        <div className="run-filter">
          <label id="run-workflow-label">{t("run.workflow")}</label>
          <Select
            aria-labelledby="run-workflow-label"
            value={workflow ?? "mine"}
            onChange={(value) =>
              setParams(value === "mine" ? {} : { workflow: value })
            }
            options={[
              { value: "mine", label: t("run.mine") },
              ...(catalog?.workflows ?? []).map((w) => ({
                value: w.id,
                label: w.name,
              })),
            ]}
          />
        </div>
      )}
      {!failure && !run && !runs && <Spin aria-label={t("common.loading")} />}
      {runs &&
        (runs.length === 0 ? (
          <Empty description={t("run.empty")} />
        ) : (
          <Table
            dataSource={runs}
            rowKey="id"
            pagination={{ pageSize: 20 }}
            scroll={{ x: 750 }}
            columns={[
              {
                title: t("run.name"),
                dataIndex: "localRunId",
                render: (value: string, r: Run) => (
                  <Link to={`/runs/${r.id}`}>{value}</Link>
                ),
              },
              {
                title: t("run.status"),
                render: (_: unknown, r: Run) => (
                  <Tag>
                    {r.projection
                      ? t(`run.status.${r.projection.status}`)
                      : t("run.registered")}
                  </Tag>
                ),
              },
              {
                title: t("run.node"),
                render: (_: unknown, r: Run) =>
                  r.projection?.currentNode ?? "—",
              },
              { title: t("run.person"), dataIndex: "personName" },
              { title: t("run.host"), dataIndex: "hostLabel" },
              { title: t("run.updated"), dataIndex: "updatedAt", render: time },
            ]}
          />
        ))}
      {run && (
        <>
          <section
            className="surface-card run-overview"
            aria-label={t("run.overview")}
          >
            <Space wrap>
              <Tag>
                {state ? t(`run.status.${state.status}`) : t("run.registered")}
              </Tag>
              {run.testRun && <Tag>{t("run.test")}</Tag>}
              <Link to={`/workflows/${run.workflowId}`}>
                {t("run.openWorkflow")}
              </Link>
            </Space>
            <Descriptions
              column={{ xs: 1, md: 2 }}
              items={[
                {
                  key: "node",
                  label: t("run.node"),
                  children: state?.currentNode ?? "—",
                },
                {
                  key: "pending",
                  label: t("run.pending"),
                  children: state?.pendingAction?.type ?? "—",
                },
                {
                  key: "person",
                  label: t("run.person"),
                  children: run.personName,
                },
                { key: "host", label: t("run.host"), children: run.hostLabel },
                {
                  key: "agent",
                  label: t("run.agent"),
                  children: run.agentHost,
                },
                {
                  key: "updated",
                  label: t("run.updated"),
                  children: time(run.updatedAt),
                },
                {
                  key: "sequence",
                  label: t("run.sequence"),
                  children: run.lastSequence,
                },
                {
                  key: "package",
                  label: t("run.package"),
                  children: <code>{run.packageHash}</code>,
                },
                {
                  key: "publication",
                  label: t("run.publication"),
                  children: run.publicationId,
                },
              ]}
            />
          </section>
          {(state?.requiresUserDecision ||
            state?.pendingAction?.type === "ask_user") && (
            <Alert
              type="info"
              showIcon
              message={t("run.humanGate")}
              description={t("run.humanGateHelp")}
            />
          )}
          {state?.historySummary && state.historySummary.omitted > 0 && (
            <Alert
              type="info"
              showIcon
              message={format("run.historyLimit", state.historySummary)}
            />
          )}
          <Collapse
            defaultActiveKey={[
              "attempts",
              "receipts",
              "findings",
              ...(afterSequence === null ? [] : ["events"]),
            ]}
            items={[
              {
                key: "attempts",
                label: t("run.attempts"),
                children: state?.visits.length ? (
                  <Table
                    dataSource={state.visits}
                    rowKey="attemptId"
                    pagination={false}
                    scroll={{ x: 700 }}
                    expandable={{ expandedRowRender: (visit) => pretty(visit) }}
                    columns={[
                      {
                        title: t("run.attempt"),
                        dataIndex: "attemptId",
                        render: (value: string) => <code>{value}</code>,
                      },
                      {
                        title: t("run.node"),
                        render: (_, visit) =>
                          Object.entries(state.execution.nodeToStep).find(
                            ([, step]) => step === visit.stepId,
                          )?.[0] ?? visit.stepId,
                      },
                      { title: t("run.visit"), dataIndex: "visitOrdinal" },
                      {
                        title: t("run.cycle"),
                        render: (_, visit) => visit.cycleId ?? "—",
                      },
                      {
                        title: t("run.status"),
                        render: (_, visit) =>
                          visit.outcomes.at(-1)
                            ? t(`run.outcome.${visit.outcomes.at(-1)!.status}`)
                            : t("run.pending"),
                      },
                      {
                        title: t("run.summary"),
                        render: (_, visit) =>
                          visit.outcomes.at(-1)?.summary ?? "—",
                      },
                    ]}
                  />
                ) : (
                  <Empty description={t("run.noAttempts")} />
                ),
              },
              {
                key: "receipts",
                label: t("run.receipts"),
                children: receipts.length ? (
                  receipts.map((receipt) => (
                    <Descriptions
                      key={receipt.id}
                      bordered
                      column={1}
                      title={receipt.artifactId}
                      items={[
                        {
                          key: "path",
                          label: t("run.path"),
                          children: receipt.path,
                        },
                        {
                          key: "root",
                          label: t("run.root"),
                          children: receipt.root
                            ? `${receipt.root.name}: ${receipt.root.path}`
                            : t("run.localRoot"),
                        },
                        {
                          key: "attempt",
                          label: t("run.attempt"),
                          children: receipt.producer.attemptId,
                        },
                        {
                          key: "size",
                          label: t("run.bytes"),
                          children: receipt.size,
                        },
                        {
                          key: "hash",
                          label: "SHA-256",
                          children: <code>{receipt.sha256}</code>,
                        },
                        {
                          key: "mtime",
                          label: t("run.modified"),
                          children: time(
                            new Date(receipt.mtimeMs).toISOString(),
                          ),
                        },
                      ]}
                    />
                  ))
                ) : (
                  <Empty description={t("run.noReceipts")} />
                ),
              },
              {
                key: "findings",
                label: t("run.findings"),
                children: state?.findings.length ? (
                  state.findings.map((finding, i) => (
                    <Alert
                      key={i}
                      type={
                        finding.severity === "error"
                          ? "error"
                          : finding.severity === "warning"
                            ? "warning"
                            : "info"
                      }
                      showIcon
                      message={finding.message}
                    />
                  ))
                ) : (
                  <Empty description={t("run.noFindings")} />
                ),
              },
              {
                key: "pending",
                label: t("run.pending"),
                children: pretty(state?.pendingAction ?? null),
              },
              {
                key: "events",
                label: t("run.events"),
                children: (
                  <>
                    <Space wrap>
                      <span>
                        {format("run.eventsRange", {
                          first: run.events?.[0]?.sequence ?? 0,
                          last: run.events?.at(-1)?.sequence ?? 0,
                          total: run.lastSequence,
                        })}
                      </span>
                      <Button
                        disabled={Number(afterSequence ?? 0) === 0}
                        onClick={() => setParams({ afterSequence: "0" })}
                      >
                        {t("run.firstEvents")}
                      </Button>
                      <Button
                        disabled={!run.eventsTruncated}
                        onClick={() =>
                          setParams({
                            afterSequence: String(
                              run.events?.at(-1)?.sequence ?? 0,
                            ),
                          })
                        }
                      >
                        {t("run.nextEvents")}
                      </Button>
                    </Space>
                    <ol className="run-events">
                      {run.events?.map((event) => (
                        <li key={event.sequence}>
                          <details>
                            <summary>
                              #{event.sequence} · {event.type} ·{" "}
                              {time(event.timestamp)}
                            </summary>
                            {pretty(event.data)}
                          </details>
                        </li>
                      ))}
                    </ol>
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
