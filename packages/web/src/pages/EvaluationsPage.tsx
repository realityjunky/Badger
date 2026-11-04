import {
  Alert,
  Button,
  Collapse,
  Empty,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { EvalReport } from "@realityjunky/badger";
import {
  loadWorkflow,
  loadWorkflows,
  type WorkflowCatalog,
  type WorkflowDetail,
} from "../api/workflows.js";
import {
  isRuntimeCheck,
  mcpPhaseEvidence,
  type EvaluationsView,
} from "../api/evaluations.js";
import { questionnaireRequest } from "../api/questionnaire.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useDemoMode } from "../app/DemoContext.js";
import { workflowVersionLabel } from "../util/workflowVersion.js";

const label = (value: string) =>
  value.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[-_]/gu, " ");
export function EvaluationsPage() {
  const demoMode = useDemoMode();
  const { t, locale } = useI18n();
  const { notice } = useLiveUpdates();
  const [parameters, setParameters] = useSearchParams();
  const workflowId = parameters.get("workflow");
  const versionId = parameters.get("version");
  const basePath = readBasePath(document);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [view, setView] = useState<EvaluationsView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    packageHash: string;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Open a completed fixture version on first entry; the normal dashboard
  // still asks the person to choose their Workflow and version.
  useEffect(() => {
    if (!demoMode) return;
    const first = catalog?.workflows[0];
    if (!workflowId && first) {
      setParameters({ workflow: first.id }, { replace: true });
    } else if (workflowId && !versionId && detail) {
      const selected =
        detail.versions.find((version) =>
          version.stages.some(
            (stage) => stage.id === "evaluation" && stage.state === "done",
          ),
        ) ?? detail.versions[0];
      if (selected)
        setParameters(
          { workflow: workflowId, version: selected.id },
          { replace: true },
        );
    }
  }, [demoMode, catalog, detail, workflowId, versionId, setParameters]);
  const route =
    workflowId && versionId
      ? `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/evaluations`
      : null;
  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflows(basePath, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        if (result.kind === "ok") setCatalog(result.value);
        else setFailure(t("evaluation.failed"));
      }
    });
    return () => controller.abort();
  }, [basePath]);
  useEffect(() => {
    setDetail(null);
    setView(null);
    setFailure(null);
    if (!workflowId) return;
    const controller = new AbortController();
    void loadWorkflow(basePath, workflowId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ok") setDetail(result.value);
        else setFailure(t("evaluation.failed"));
      },
    );
    return () => controller.abort();
  }, [basePath, workflowId]);
  useEffect(() => {
    if (!route) return;
    const controller = new AbortController();
    void questionnaireRequest<EvaluationsView>(
      basePath,
      route,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setView(value);
          setFailure(null);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("evaluation.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, route, refresh]);
  useEffect(() => {
    setView(null);
    setConfirmation(null);
  }, [route]);
  const pending = view?.jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 750);
    return () => clearTimeout(timer);
  }, [pending, view]);
  useEffect(() => {
    if (!versionId) return;
    if (notice.versionIds.includes(versionId)) setRefresh((value) => value + 1);
  }, [notice, versionId]);
  useEffect(() => {
    if (!route) return;
    const timer = setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, [route]);
  const selected =
    view?.reports.find((report) => report.id === parameters.get("report")) ??
    view?.reports[0];
  async function start() {
    if (!confirmation || !route) return;
    setBusy(true);
    try {
      await questionnaireRequest(basePath, route, "POST", {
        ...confirmation,
        confirmed: true,
      });
      setConfirmation(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("evaluation.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  function selectWorkflow(value: string) {
    const version = catalog?.workflows.find((workflow) => workflow.id === value)
      ?.latestVersion?.id;
    setParameters({ workflow: value, ...(version ? { version } : {}) });
  }
  const date = (value: string) => new Date(value).toLocaleString(locale);
  const verdict = (passed: boolean) => (
    <Tag color={passed ? "success" : "error"}>
      {t(passed ? "evaluation.passed" : "evaluation.notPassed")}
    </Tag>
  );
  return (
    <>
      <PageHeader
        title={t("page.evaluations.title")}
        description={t("evaluation.description")}
        actions={
          <Button onClick={() => setRefresh((value) => value + 1)}>
            {t("workflow.reload")}
          </Button>
        }
      />
      <section
        className="workflow-panel evaluation-filters"
        aria-label={t("evaluation.selection")}
      >
        <label className="field">
          {t("evaluation.workflow")}
          <Select
            aria-label={t("evaluation.workflow")}
            value={workflowId ?? undefined}
            placeholder={t("evaluation.selectWorkflow")}
            onChange={selectWorkflow}
            options={catalog?.workflows.map((workflow) => ({
              value: workflow.id,
              label: workflow.name,
            }))}
          />
        </label>
        <label className="field">
          {t("evaluation.version")}
          <Select
            aria-label={t("evaluation.version")}
            value={versionId ?? undefined}
            disabled={!detail}
            onChange={(value) =>
              setParameters({ workflow: workflowId!, version: value })
            }
            options={detail?.versions.map((version) => ({
              value: version.id,
              label: `${version.name} · ${workflowVersionLabel(version)}`,
            }))}
          />
        </label>
        {workflowId && versionId && (
          <Link
            to={`/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}#package`}
          >
            {t("evaluation.package")}
          </Link>
        )}
      </section>
      {failure && <Alert type="error" title={failure} showIcon />}
      {!route ? (
        <Empty description={t("evaluation.selectWorkflow")} />
      ) : !view ? (
        <Spin />
      ) : (
        <>
          <section
            className="workflow-panel"
            aria-labelledby="evaluation-current-title"
          >
            <div className="workflow-card-heading">
              <h2 id="evaluation-current-title">
                {t("evaluation.currentPackage")}
              </h2>
              {view.canEvaluate && (
                <Button
                  type="primary"
                  disabled={!view.currentPackageHash || pending}
                  onClick={() =>
                    setConfirmation({
                      packageHash: view.currentPackageHash!,
                      requestId: crypto.randomUUID(),
                    })
                  }
                >
                  {t("evaluation.start")}
                </Button>
              )}
            </div>
            {view.currentPackageHash ? (
              <>
                <code className="evaluation-hash">
                  {view.currentPackageHash}
                </code>
                <Alert
                  type={view.passingReportId ? "success" : "warning"}
                  title={t(
                    view.passingReportId
                      ? "evaluation.ready"
                      : "evaluation.needsPassing",
                  )}
                  showIcon
                />
              </>
            ) : (
              <Alert
                type="info"
                title={t("evaluation.assembleFirst")}
                showIcon
              />
            )}
            <div aria-live="polite" className="evaluation-progress">
              {view.jobs.slice(0, 5).map((job) => (
                <div key={job.id}>
                  <Tag
                    color={
                      job.status === "succeeded"
                        ? "success"
                        : job.status === "failed"
                          ? "error"
                          : "processing"
                    }
                  >
                    {t(`evaluation.status.${job.status}`)}
                  </Tag>
                  <span>
                    {t("evaluation.job")} {job.id.slice(-8)}
                  </span>
                  {job.progress && (
                    <span>
                      {" "}
                      ·{" "}
                      {t(
                        `evaluation.phase.${job.progress.phase}` as "evaluation.phase.queued",
                      )}
                    </span>
                  )}
                  {job.error && <p>{job.error}</p>}
                </div>
              ))}
            </div>
          </section>
          <section
            className="workflow-panel"
            aria-labelledby="evaluation-history-title"
          >
            <h2 id="evaluation-history-title">{t("evaluation.history")}</h2>
            <Table
              size="small"
              rowKey="id"
              dataSource={view.reports}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 680 }}
              locale={{ emptyText: t("evaluation.noReports") }}
              columns={[
                {
                  title: t("evaluation.finished"),
                  dataIndex: "finishedAt",
                  render: (value: string, report) => (
                    <Button
                      type="link"
                      onClick={() =>
                        setParameters({
                          workflow: workflowId!,
                          version: versionId!,
                          report: report.id,
                        })
                      }
                    >
                      {date(value)}
                    </Button>
                  ),
                },
                {
                  title: t("evaluation.result"),
                  render: (_, report) => (
                    <Space wrap>
                      {verdict(report.report.passed)}
                      {report.id === view.passingReportId && (
                        <Tag>{t("evaluation.current")}</Tag>
                      )}
                      {report.packageHash !== view.currentPackageHash && (
                        <Tag>{t("evaluation.superseded")}</Tag>
                      )}
                    </Space>
                  ),
                },
                {
                  title: t("evaluation.hash"),
                  dataIndex: "packageHash",
                  render: (value: string) => (
                    <code title={value}>{value.slice(0, 16)}</code>
                  ),
                },
                {
                  title: t("evaluation.duration"),
                  dataIndex: "durationMilliseconds",
                  render: (value: number) => `${(value / 1000).toFixed(1)} s`,
                },
                { title: t("evaluation.starter"), dataIndex: "starterName" },
              ]}
            />
          </section>
          {selected && (
            <section
              className="workflow-panel"
              aria-labelledby="evaluation-report-title"
              data-testid="evaluation-report"
            >
              <div className="workflow-card-heading">
                <h2 id="evaluation-report-title">{t("evaluation.report")}</h2>
                {verdict(selected.report.passed)}
              </div>
              <p>
                {date(selected.finishedAt)} · {t("evaluation.starter")}:{" "}
                {selected.starterName} ·{" "}
                {(selected.durationMilliseconds / 1000).toFixed(1)} s
              </p>
              <code className="evaluation-hash">{selected.packageHash}</code>
              <ReportChecks report={selected.report} />
            </section>
          )}
        </>
      )}
      <Modal
        title={t("evaluation.confirmTitle")}
        open={confirmation !== null}
        onCancel={() => setConfirmation(null)}
        onOk={() => void start()}
        confirmLoading={busy}
        okText={t("evaluation.confirm")}
        cancelText={t("workflow.cancel")}
      >
        <p>{t("evaluation.confirmHelp")}</p>
        <code className="evaluation-hash">{confirmation?.packageHash}</code>
      </Modal>
    </>
  );
}

function ReportChecks({ report }: { report: EvalReport }) {
  const { t } = useI18n();
  const checkList = (checks: EvalReport["checks"]) => (
    <ul className="evaluation-checks">
      {checks.map((check) => (
        <li key={check.id}>
          <Tag color={check.passed ? "success" : "error"}>
            {t(check.passed ? "evaluation.passed" : "evaluation.notPassed")}
          </Tag>
          <strong>{label(check.id)}</strong>
          <p>{check.detail}</p>
        </li>
      ))}
    </ul>
  );
  const phases: {
    key: string;
    title: string;
    evidence: Record<string, unknown>;
  }[] = [];
  if (report.runtime) {
    phases.push({
      key: "compatibility",
      title: t("evaluation.compatibility"),
      evidence: report.runtime as unknown as Record<string, unknown>,
    });
    if (report.runtime.phase3)
      phases.push({
        key: "phase3",
        title: t("evaluation.phase3"),
        evidence: report.runtime.phase3 as unknown as Record<string, unknown>,
      });
    if (report.runtime.phase4)
      phases.push({
        key: "phase4",
        title: t("evaluation.phase4"),
        evidence: report.runtime.phase4 as unknown as Record<string, unknown>,
      });
    if (report.runtime.artifactReceipts)
      phases.push({
        key: "receipts",
        title: t("evaluation.receipts"),
        evidence: report.runtime.artifactReceipts as unknown as Record<
          string,
          unknown
        >,
      });
  }
  if (report.mcp)
    phases.push({
      key: "mcp",
      title: t("evaluation.mcp"),
      evidence: mcpPhaseEvidence(report.mcp),
    });
  return (
    <Collapse
      defaultActiveKey={["package", "authoring", "runtime"]}
      items={[
        {
          key: "package",
          label: t("evaluation.packageChecks"),
          children: checkList(
            report.checks.filter(
              (check) =>
                !check.id.startsWith("authoring-") && !isRuntimeCheck(check.id),
            ),
          ),
        },
        {
          key: "authoring",
          label: t("evaluation.authoring"),
          children: (
            <>
              {checkList(
                report.checks.filter((check) =>
                  check.id.startsWith("authoring-"),
                ),
              )}
              {report.authoringCrossValidation && (
                <p>
                  <code className="evaluation-hash">
                    {report.authoringCrossValidation.crossValidationHash}
                  </code>
                </p>
              )}
            </>
          ),
        },
        {
          key: "runtime",
          label: t("evaluation.runtime"),
          children: (
            <>
              {checkList(
                report.checks.filter((check) => isRuntimeCheck(check.id)),
              )}
              <Collapse
                items={phases.map((phase) => ({
                  key: phase.key,
                  label: phase.title,
                  children: (
                    <>
                      <Evidence value={phase.evidence} />
                      {typeof phase.evidence.negativeCases === "object" &&
                        phase.evidence.negativeCases !== null && (
                          <>
                            <h4>{t("evaluation.negativeCases")}</h4>
                            <Evidence
                              value={
                                phase.evidence.negativeCases as Record<
                                  string,
                                  unknown
                                >
                              }
                            />
                          </>
                        )}
                    </>
                  ),
                }))}
              />
            </>
          ),
        },
      ]}
    />
  );
}
function Evidence({
  value,
  prefix = "",
}: {
  value: Record<string, unknown>;
  prefix?: string;
}) {
  const { t } = useI18n();
  return (
    <ul className="evaluation-evidence">
      {Object.entries(value)
        .filter(
          ([key, item]) =>
            typeof item === "boolean" ||
            (item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              ![
                "negativeCases",
                "phase3",
                "phase4",
                "artifactReceipts",
                "identity",
              ].includes(key)),
        )
        .map(([key, item]) => (
          <li key={key}>
            {typeof item === "boolean" ? (
              <>
                <Tag color={item ? "success" : "error"}>
                  {t(item ? "evaluation.passed" : "evaluation.notPassed")}
                </Tag>
                {label(prefix + key)}
              </>
            ) : (
              <details>
                <summary>{label(key)}</summary>
                <Evidence value={item as Record<string, unknown>} />
              </details>
            )}
          </li>
        ))}
    </ul>
  );
}
