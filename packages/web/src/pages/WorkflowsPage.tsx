import { Alert, Button, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  createWorkflow,
  editWorkflow,
  editVersionLabel,
  loadWorkflow,
  loadWorkflowVersion,
  loadWorkflows,
  startVersion,
  type Workflow,
  type WorkflowCatalog,
  type WorkflowDetail,
  type WorkflowVersionDetail,
  type WorkflowVersion,
} from "../api/workflows.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { StageTrack } from "../components/StageTrack.js";
import { useI18n } from "../i18n/I18nContext.js";
import { WorkflowDialog } from "./workflows/WorkflowDialog.js";
import { WorkflowVersionDialog } from "./workflows/WorkflowVersionDialog.js";
import { workflowVersionLabel } from "../util/workflowVersion.js";
import { WorkflowTeam } from "./workflows/WorkflowTeam.js";
import { WorkflowSources } from "./workflows/WorkflowSources.js";
import { WorkflowPanel } from "./workflows/WorkflowPanel.js";
import { WorkflowTabs } from "./workflows/WorkflowTabs.js";
import { WorkflowSourceStudy } from "./workflows/WorkflowSourceStudy.js";
import { WorkflowDossier } from "./workflows/WorkflowDossier.js";
import { WorkflowPlan } from "./workflows/WorkflowPlan.js";
import { WorkflowPublication } from "./workflows/WorkflowPublication.js";
import { WorkflowPackage } from "./workflows/WorkflowPackage.js";
import { WorkflowProposal } from "./workflows/WorkflowProposal.js";
import { WorkflowNotifications } from "./workflows/WorkflowNotifications.js";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";

type State =
  | { kind: "loading" | "failed" | "denied" | "missing" }
  | { kind: "catalog"; value: WorkflowCatalog }
  | { kind: "detail"; value: WorkflowDetail };

/** Catalog and version deep links share the service's scoped records. */
export function WorkflowsPage() {
  const { t } = useI18n();
  const { notice } = useLiveUpdates();
  const { workflowId, versionId } = useParams();
  const [parameters] = useSearchParams();
  const groupId = parameters.get("group");
  const navigate = useNavigate();
  const basePath = readBasePath(document);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; workflow: Workflow } | null
  >(null);
  const [versionDialog, setVersionDialog] = useState<{
    workflow: Workflow;
    version: WorkflowVersion | null;
    versions: WorkflowVersion[];
  } | null>(null);
  const [versionResources, setVersionResources] =
    useState<WorkflowVersionDetail | null>(null);
  const detail = state.kind === "detail" ? state.value : null;
  const workflow = detail?.workflow;
  const selectedVersion =
    versionId === undefined
      ? detail?.versions[0]
      : detail?.versions.find((entry) => entry.id === versionId);

  useEffect(() => {
    setState({ kind: "loading" });
    setDialog(null);
    setVersionDialog(null);
  }, [basePath, workflowId]);

  useEffect(() => {
    const controller = new AbortController();
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

  useEffect(() => {
    setVersionResources(null);
  }, [basePath, workflowId, selectedVersion?.id]);

  useEffect(() => {
    if (workflowId === undefined || selectedVersion === undefined) {
      return;
    }
    const controller = new AbortController();
    void loadWorkflowVersion(
      basePath,
      workflowId,
      selectedVersion.id,
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) {
        if (result.kind === "ok") setVersionResources(result.value);
        else if (result.kind === "denied" || result.kind === "missing")
          setVersionResources(null);
      }
    });
    return () => controller.abort();
  }, [basePath, workflowId, selectedVersion?.id, refresh]);

  useEffect(() => {
    if (!workflowId || !selectedVersion) return;
    const controller = new AbortController();
    const update = () =>
      void loadWorkflowVersion(
        basePath,
        workflowId,
        selectedVersion.id,
        controller.signal,
      ).then((result) => {
        if (!controller.signal.aborted && result.kind === "ok")
          setVersionResources(result.value);
      });
    if (notice.versionIds.includes(selectedVersion.id)) {
      update();
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
    const timer = setInterval(() => {
      if (!document.hidden) update();
    }, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, workflowId, selectedVersion?.id, notice]);

  // The worker runs a queued check; look again until it settles, keeping the
  // page as it is in between.
  const checkStatus = versionResources?.sourceCheck?.status;
  useEffect(() => {
    if (workflowId === undefined || versionResources === null) return;
    if (checkStatus !== "queued" && checkStatus !== "running") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadWorkflowVersion(
        basePath,
        workflowId,
        versionResources.version.id,
        controller.signal,
      ).then((result) => {
        if (!controller.signal.aborted && result.kind === "ok")
          setVersionResources(result.value);
      });
    }, 3000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [basePath, workflowId, versionResources, checkStatus]);

  const reload = () => setRefresh((value) => value + 1);

  return (
    <div className="page workflow-page" data-testid="page-workflows">
      <PageHeader
        title={workflow?.name ?? t("page.workflows.title")}
        description={workflow?.goal ?? t("page.workflows.description")}
        actions={
          <Space wrap>
            {workflow && (
              <Link to={`/runs?workflow=${encodeURIComponent(workflow.id)}`}>
                {t("page.runs.title")}
              </Link>
            )}
            {workflow && selectedVersion && (
              <Link
                to={`/questionnaire?workflow=${encodeURIComponent(workflow.id)}&version=${encodeURIComponent(selectedVersion.id)}`}
              >
                {t("page.questionnaire.title")}
              </Link>
            )}
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
              <Button
                type="primary"
                onClick={() =>
                  setVersionDialog({
                    workflow: detail.workflow,
                    version: null,
                    versions: detail.versions,
                  })
                }
              >
                {t("workflow.newVersion")}
              </Button>
            )}
          </Space>
        }
      />
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
          {state.value.workflows.filter(
            (entry) => !groupId || entry.groupId === groupId,
          ).length === 0 && (
            <p className="empty-state">{t("workflow.empty")}</p>
          )}
          {state.value.workflows
            .filter((entry) => !groupId || entry.groupId === groupId)
            .map((entry) => (
              <article className="workflow-card" key={entry.id}>
                <h2>
                  <Link to={`/workflows/${encodeURIComponent(entry.id)}`}>
                    {entry.name}
                  </Link>
                </h2>
                <div className="workflow-card-meta">
                  <span className="muted">{entry.groupName}</span>
                  <span className="workflow-card-goal">{entry.goal}</span>
                  {entry.latestVersion !== null && (
                    <Link
                      className="workflow-version-link"
                      to={`/workflows/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(entry.latestVersion.id)}`}
                    >
                      {workflowVersionLabel(entry.latestVersion)}
                    </Link>
                  )}
                  <Tag>
                    {t(
                      entry.intent === "new-skill"
                        ? "workflow.intent.new"
                        : "workflow.intent.upgrade",
                    )}
                  </Tag>
                  <Tag>{entry.locale}</Tag>
                </div>
                {entry.latestVersion !== null && (
                  <StageTrack stages={entry.latestVersion.stages} />
                )}
              </article>
            ))}
        </div>
      )}
      {detail !== null && (
        <>
          <p className="muted">{detail.groupName}</p>
          <WorkflowTabs
            key={`${detail.workflow.id}:${selectedVersion?.id ?? "missing"}`}
            secondaryKeys={["team", "notifications"]}
            items={[
              {
                key: "version",
                label: t("workflow.version"),
                children:
                  selectedVersion === undefined ? (
                    <Alert
                      type="warning"
                      showIcon
                      message={t("workflow.versionMissing")}
                    />
                  ) : (
                    <WorkflowPanel
                      key={selectedVersion.id}
                      id="version"
                      title={t("workflow.version")}
                      aria-labelledby="workflow-version-title"
                      actions={
                        <Space wrap>
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
                              label: workflowVersionLabel(entry),
                            }))}
                          />
                          {detail.capabilities.createVersion && (
                            <Button
                              onClick={() =>
                                setVersionDialog({
                                  workflow: detail.workflow,
                                  version: selectedVersion,
                                  versions: detail.versions,
                                })
                              }
                            >
                              {t("workflow.editVersionLabel")}
                            </Button>
                          )}
                        </Space>
                      }
                    >
                      <p>{selectedVersion.goal}</p>
                      {selectedVersion.inheritedFromVersionId && (
                        <p>
                          <Link
                            to={`/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(selectedVersion.inheritedFromVersionId)}`}
                          >
                            {t("versions.inheritedVersion")}
                          </Link>
                        </p>
                      )}
                      <Space wrap className="workflow-version-meta">
                        {selectedVersion.semanticVersion && (
                          <Tag>{`v${selectedVersion.number}`}</Tag>
                        )}
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
                      <StageTrack
                        stages={
                          versionResources?.version.id === selectedVersion.id
                            ? versionResources.version.stages
                            : selectedVersion.stages
                        }
                      />
                    </WorkflowPanel>
                  ),
              },
              ...(versionResources !== null &&
              selectedVersion !== undefined &&
              workflow !== undefined
                ? [
                    {
                      key: "sources",
                      label: t("workflow.sources"),
                      children: (
                        <WorkflowSources
                          key={`sources-${selectedVersion.id}`}
                          basePath={basePath}
                          workflow={workflow}
                          version={selectedVersion}
                          detail={versionResources}
                          canManage={versionResources.capabilities.managePins}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "source-study",
                      label: t("stage.sourceStudy"),
                      children: (
                        <WorkflowSourceStudy
                          key={selectedVersion.id}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "dossier",
                      label: t("dossier.title"),
                      children: (
                        <WorkflowDossier
                          key={`dossier-${selectedVersion.id}`}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "plan",
                      label: t("plan.title"),
                      children: (
                        <WorkflowPlan
                          key={`plan-${selectedVersion.id}`}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "proposal",
                      label: t("proposal.title"),
                      children: (
                        <WorkflowProposal
                          key={`proposal-${selectedVersion.id}`}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "package",
                      label: t("package.title"),
                      children: (
                        <WorkflowPackage
                          key={`package-${selectedVersion.id}`}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                    {
                      key: "review-publication",
                      label: t("publication.title"),
                      children: (
                        <WorkflowPublication
                          key={`publication-${selectedVersion.id}`}
                          basePath={basePath}
                          detail={versionResources}
                          onChanged={reload}
                        />
                      ),
                    },
                  ]
                : []),
              {
                key: "team",
                label: t("workflow.team"),
                children: (
                  <WorkflowTeam
                    key={`team-${detail.workflow.id}`}
                    basePath={basePath}
                    workflowId={detail.workflow.id}
                    bindings={detail.bindings}
                    groupMembers={detail.groupMembers}
                    mayManage={detail.capabilities.manageRoles}
                    onChanged={reload}
                  />
                ),
              },
              {
                key: "notifications",
                label: t("notifications.title"),
                children: (
                  <WorkflowNotifications
                    key={detail.workflow.id}
                    basePath={basePath}
                    workflowId={detail.workflow.id}
                    mayManage={detail.capabilities.approveDossier}
                  />
                ),
              },
            ]}
          />
        </>
      )}
      {versionDialog !== null && (
        <WorkflowVersionDialog
          version={versionDialog.version}
          versions={versionDialog.versions}
          onCancel={() => setVersionDialog(null)}
          onReload={() => {
            setVersionDialog(null);
            reload();
          }}
          onSubmit={async (semanticVersion) => {
            if (versionDialog.version === null) {
              const result = await startVersion(
                basePath,
                versionDialog.workflow,
                semanticVersion,
              );
              if (result.kind === "ok") {
                setVersionDialog(null);
                navigate(
                  `/workflows/${encodeURIComponent(versionDialog.workflow.id)}/versions/${encodeURIComponent(result.value.version.id)}`,
                );
                reload();
              }
              return result;
            }
            const result = await editVersionLabel(
              basePath,
              versionDialog.workflow.id,
              versionDialog.version,
              semanticVersion,
            );
            if (result.kind === "ok") {
              setVersionDialog(null);
              reload();
            }
            return result;
          }}
        />
      )}
      {dialog !== null && (
        <WorkflowDialog
          workflow={dialog.kind === "edit" ? dialog.workflow : null}
          groups={state.kind === "catalog" ? state.value.createGroups : []}
          onCancel={() => setDialog(null)}
          onReload={() => {
            setDialog(null);
            reload();
          }}
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
