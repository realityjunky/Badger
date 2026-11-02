import { Button, Select } from "antd";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import {
  loadWorkflow,
  loadWorkflows,
  read,
  type WorkflowCatalog,
  type WorkflowDetail,
} from "../api/workflows.js";
import type { Group } from "../api/organization.js";
import {
  scopeDestination,
  scopeSelection,
  type ScopeSelection,
} from "./scope.js";

export function ScopeSelector({
  onResolve,
}: {
  onResolve(scope: ScopeSelection & { location: string }): void;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const basePath = readBasePath(document);
  const selection = scopeSelection(location.pathname, location.search);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [linked, setLinked] = useState<{
    pathname: string;
    workflowId?: string;
    versionId?: string;
    groupId?: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const workflowId =
    selection.workflow ??
    (linked?.pathname === location.pathname ? linked.workflowId : undefined);
  const workflow = catalog?.workflows.find((entry) => entry.id === workflowId);
  const groupId =
    workflow?.groupId ??
    selection.group ??
    (linked?.pathname === location.pathname ? linked.groupId : undefined);
  const currentDetail = detail?.workflow.id === workflowId ? detail : null;
  const versionId =
    selection.version ??
    (linked?.pathname === location.pathname ? linked.versionId : undefined) ??
    (location.pathname.startsWith("/runs")
      ? undefined
      : currentDetail?.versions[0]?.id);
  const groupOptions = new Map(groups.map((group) => [group.id, group.name]));
  for (const entry of catalog?.workflows ?? [])
    groupOptions.set(entry.groupId, entry.groupName);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void Promise.all([
      loadWorkflows(basePath, controller.signal),
      read<{ groups: Group[] }>(basePath, "/groups", controller.signal),
    ]).then(([workflows, availableGroups]) => {
      if (controller.signal.aborted) return;
      setCatalog(workflows.kind === "ok" ? workflows.value : null);
      setGroups(
        availableGroups.kind === "ok" ? availableGroups.value.groups : [],
      );
      setFailed(workflows.kind !== "ok" || availableGroups.kind !== "ok");
    });
    return () => controller.abort();
  }, [basePath, location.pathname, refresh]);

  useEffect(() => {
    const match = /^\/questionnaire\/(questions|concerns)\/([^/]+)$/u.exec(
      location.pathname,
    );
    if (!match) return;
    const controller = new AbortController();
    void read<{ workflowId: string; versionId: string }>(
      basePath,
      `/questionnaire/${match[1]}/${match[2]}`,
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted)
        setLinked(
          result.kind === "ok"
            ? { pathname: location.pathname, ...result.value }
            : null,
        );
    });
    return () => controller.abort();
  }, [basePath, location.pathname]);

  useEffect(() => {
    const match = /^\/(skills|runs)\/([^/]+)/u.exec(location.pathname);
    if (!match) return;
    const controller = new AbortController();
    void read<{ skill?: { groupId: string }; run?: { workflowId: string } }>(
      basePath,
      `/${match[1]}/${match[2]}`,
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted)
        setLinked(
          result.kind === "ok"
            ? {
                pathname: location.pathname,
                groupId: result.value.skill?.groupId,
                workflowId: result.value.run?.workflowId,
              }
            : null,
        );
    });
    return () => controller.abort();
  }, [basePath, location.pathname]);

  useEffect(() => {
    onResolve({
      location: `${location.pathname}${location.search}`,
      group: groupId,
      workflow: workflowId,
      version: versionId,
    });
  }, [
    onResolve,
    location.pathname,
    location.search,
    groupId,
    workflowId,
    versionId,
  ]);

  useEffect(() => {
    if (!workflowId) return;
    const controller = new AbortController();
    void loadWorkflow(basePath, workflowId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setDetail(result.kind === "ok" ? result.value : null);
          if (result.kind !== "ok") setFailed(true);
        }
      },
    );
    return () => controller.abort();
  }, [basePath, workflowId, location.pathname, refresh]);

  return (
    <div
      className="scope-selector"
      data-testid="scope-selector"
      role="group"
      aria-label={t("topBar.scopeLabel")}
    >
      <Select
        className="scope-select"
        aria-label={t("scope.group")}
        placeholder={t("scope.allGroups")}
        value={groupId}
        allowClear
        showSearch
        optionFilterProp="label"
        loading={catalog === null && !failed}
        options={[...groupOptions].map(([value, label]) => ({ value, label }))}
        onChange={(group: string | undefined) =>
          navigate(scopeDestination(location.pathname, { group }))
        }
        popupMatchSelectWidth={false}
      />
      {!location.pathname.startsWith("/skills") && (
        <>
          <span className="scope-arrow" aria-hidden="true">
            /
          </span>
          <Select
            className="scope-select scope-select-workflow"
            aria-label={t("scope.workflow")}
            placeholder={t("scope.selectWorkflow")}
            value={workflowId}
            allowClear
            showSearch
            optionFilterProp="label"
            loading={catalog === null && !failed}
            options={(catalog?.workflows ?? [])
              .filter((entry) => !groupId || entry.groupId === groupId)
              .map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(workflow: string | undefined) =>
              navigate(
                scopeDestination(location.pathname, {
                  group: groupId,
                  workflow,
                  version: catalog?.workflows.find(
                    (entry) => entry.id === workflow,
                  )?.latestVersion?.id,
                }),
              )
            }
            popupMatchSelectWidth={false}
          />
          {!location.pathname.startsWith("/runs") && (
            <>
              <span className="scope-arrow" aria-hidden="true">
                /
              </span>
              <Select
                className="scope-select scope-select-version"
                aria-label={t("scope.version")}
                placeholder={t("scope.selectVersion")}
                value={versionId}
                disabled={!workflowId}
                loading={!!workflowId && currentDetail === null && !failed}
                options={(currentDetail?.versions ?? []).map((version) => ({
                  value: version.id,
                  label: `v${version.number}`,
                }))}
                onChange={(version: string | undefined) =>
                  navigate(
                    scopeDestination(location.pathname, {
                      group: groupId,
                      workflow: workflowId,
                      version,
                    }),
                  )
                }
                popupMatchSelectWidth={false}
              />
            </>
          )}
        </>
      )}
      {failed && (
        <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
          {t("scope.retry")}
        </Button>
      )}
    </div>
  );
}
