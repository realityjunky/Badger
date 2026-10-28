import { Alert, Button, Popconfirm, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createWorkflow,
  editWorkflow,
  loadWorkflow,
  loadWorkflows,
  startVersion,
  type Workflow,
  type WorkflowCatalog,
  type WorkflowDetail,
} from "../api/workflows.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { StageTrack } from "../components/StageTrack.js";
import { useI18n } from "../i18n/I18nContext.js";
import {
  WorkflowDialog,
  WorkflowNotice,
  type WriteFailure,
} from "./workflows/WorkflowDialog.js";
import { WorkflowTeam } from "./workflows/WorkflowTeam.js";

type State =
  | { kind: "loading" | "failed" | "denied" | "missing" }
  | { kind: "catalog"; value: WorkflowCatalog }
  | { kind: "detail"; value: WorkflowDetail };

/** Catalog and version deep links share the service's scoped records. */
export function WorkflowsPage() {
  const { t, format } = useI18n();
  const { workflowId, versionId } = useParams();
  const navigate = useNavigate();
  const basePath = readBasePath(document);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; workflow: Workflow } | null
  >(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    setDialog(null);
    setFailure(null);
    if (workflowId === undefined) {
      void loadWorkflows(basePath, controller.signal).then((result) => {
        if (!controller.signal.aborted)
          setState(
            result.kind === "ok"
              ? { kind: "catalog", value: result.value }
              : result,
          );
      });
    } else {
      void loadWorkflow(basePath, workflowId, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted)
            setState(
              result.kind === "ok"
                ? { kind: "detail", value: result.value }
                : result,
            );
        },
      );
    }
    return () => controller.abort();
  }, [basePath, workflowId, refresh]);

  const reload = () => setRefresh((value) => value + 1);
  const detail = state.kind === "detail" ? state.value : null;
  const workflow = detail?.workflow;
  const selectedVersion =
    versionId === undefined
      ? detail?.versions[0]
      : detail?.versions.find((entry) => entry.id === versionId);

  const newVersion = async () => {
    if (workflow === undefined || busy) return;
    setBusy(true);
    try {
      const result = await startVersion(basePath, workflow);
      if (result.kind === "ok") {
        navigate(
          `/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(result.value.version.id)}`,
        );
        reload();
      } else setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page workflow-page" data-testid="page-workflows">
      <PageHeader
        title={workflow?.name ?? t("page.workflows.title")}
        description={workflow?.goal ?? t("page.workflows.description")}
        actions={
          <Space wrap>
            {workflowId !== undefined && (
              <Link to="/workflows">{t("workflow.back")}</Link>
            )}
            {state.kind === "catalog" &&
              state.value.createGroups.length > 0 && (
                <Button
                  type="primary"
                  onClick={() => setDialog({ kind: "create" })}
                >
                  {t("workflow.create")}
                </Button>
              )}
            {detail?.capabilities.editWorkflow && workflow !== undefined && (
              <Button onClick={() => setDialog({ kind: "edit", workflow })}>
                {t("workflow.edit")}
              </Button>
            )}
            {detail?.capabilities.createVersion && (
              <Popconfirm
                title={t("workflow.newVersionConfirm")}
                onConfirm={newVersion}
                okText={t("workflow.newVersion")}
                cancelText={t("workflow.cancel")}
              >
                <Button type="primary" loading={busy}>
                  {t("workflow.newVersion")}
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      />
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={reload} />
      )}
      {state.kind === "loading" && (
        <p role="status" className="muted">
          {t("common.loading")}
        </p>
      )}
      {(state.kind === "denied" || state.kind === "missing") && (
        <Alert type="warning" showIcon message={t("workflow.unavailable")} />
      )}
      {state.kind === "failed" && (
        <Alert
          type="error"
          showIcon
          message={t("workflow.loadFailed")}
          action={<Button onClick={reload}>{t("workflow.reload")}</Button>}
        />
      )}
      {state.kind === "catalog" && (
        <div className="workflow-catalog">
          {state.value.workflows.length === 0 && (
            <p className="empty-state">{t("workflow.empty")}</p>
          )}
          {state.value.workflows.map((entry) => (
            <article className="workflow-card" key={entry.id}>
              <div className="workflow-card-heading">
                <div>
                  <h2>
                    <Link to={`/workflows/${encodeURIComponent(entry.id)}`}>
                      {entry.name}
                    </Link>
                  </h2>
                  <p className="muted">{entry.groupName}</p>
                </div>
                <Space wrap>
                  <Tag>
                    {t(
                      entry.intent === "new-skill"
                        ? "workflow.intent.new"
                        : "workflow.intent.upgrade",
                    )}
                  </Tag>
                  <Tag>{entry.locale}</Tag>
                </Space>
              </div>
              <p>{entry.goal}</p>
              {entry.latestVersion !== null && (
                <>
                  <Link
                    className="workflow-version-link"
                    to={`/workflows/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(entry.latestVersion.id)}`}
                  >
                    {format("workflow.versionNumber", {
                      number: entry.latestVersion.number,
                    })}
                  </Link>
                  <StageTrack stages={entry.latestVersion.stages} />
                </>
              )}
            </article>
          ))}
        </div>
      )}
      {detail !== null && (
        <>
          <p className="muted">{detail.groupName}</p>
          {selectedVersion === undefined ? (
            <Alert
              type="warning"
              showIcon
              message={t("workflow.versionMissing")}
            />
          ) : (
            <section
              className="workflow-panel"
              aria-labelledby="workflow-version-title"
            >
              <div className="workflow-card-heading">
                <h2 id="workflow-version-title">{t("workflow.version")}</h2>
                <Select
                  aria-label={t("workflow.version")}
                  value={selectedVersion.id}
                  onChange={(id) =>
                    navigate(
                      `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(id)}`,
                    )
                  }
                  options={detail.versions.map((entry) => ({
                    value: entry.id,
                    label: format("workflow.versionNumber", {
                      number: entry.number,
                    }),
                  }))}
                />
              </div>
              <p>{selectedVersion.goal}</p>
              <Space wrap className="workflow-version-meta">
                <Tag>{selectedVersion.name}</Tag>
                <Tag>
                  {t(
                    selectedVersion.intent === "new-skill"
                      ? "workflow.intent.new"
                      : "workflow.intent.upgrade",
                  )}
                </Tag>
                <Tag>{selectedVersion.locale}</Tag>
              </Space>
              <StageTrack stages={selectedVersion.stages} />
            </section>
          )}
          <WorkflowTeam
            basePath={basePath}
            workflowId={detail.workflow.id}
            bindings={detail.bindings}
            mayManage={detail.capabilities.manageRoles}
            onChanged={reload}
          />
        </>
      )}
      {dialog !== null && (
        <WorkflowDialog
          workflow={dialog.kind === "edit" ? dialog.workflow : null}
          groups={state.kind === "catalog" ? state.value.createGroups : []}
          onCancel={() => setDialog(null)}
          onReload={reload}
          onSubmit={async (values) => {
            if (dialog.kind === "edit") {
              const result = await editWorkflow(
                basePath,
                dialog.workflow,
                values,
              );
              if (result.kind === "ok") {
                setDialog(null);
                reload();
              }
              return result;
            }
            const result = await createWorkflow(basePath, values);
            if (result.kind === "ok") {
              setDialog(null);
              navigate(
                `/workflows/${encodeURIComponent(result.value.workflow.id)}`,
              );
            }
            return result;
          }}
        />
      )}
    </div>
  );
}
