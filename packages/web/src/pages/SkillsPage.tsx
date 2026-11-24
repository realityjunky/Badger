import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tree,
} from "antd";
import type { DataNode } from "antd/es/tree";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  createSkill,
  loadSkills,
  loadVersions,
  type SkillCatalog,
  type SkillFile,
  type SkillVersion,
} from "../api/skills.js";
import {
  loadWorkflows,
  loadWorkflowVersion,
  type ReadResult,
  type WorkflowCatalog,
  type WorkflowSkillPin,
} from "../api/workflows.js";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import { SkillBacklog } from "./skills/SkillBacklog.js";
import { UploadSkillModal } from "./skills/UploadSkillModal.js";
import { VersionComparison } from "./skills/VersionComparison.js";
import { VersionDetails } from "./skills/VersionDetails.js";
import { VersionFile } from "./skills/VersionFile.js";
import {
  latestSkillVersion,
  skillVersionOption,
  skillVersionPath,
} from "./skills/versionDisplay.js";

function fileTree(files: SkillFile[]): DataNode[] {
  const roots: DataNode[] = [];
  for (const file of files) {
    let children = roots;
    const segments = file.path.split("/");
    let key = "";
    segments.forEach((segment, index) => {
      key = key === "" ? segment : `${key}/${segment}`;
      const leaf = index === segments.length - 1;
      let node = children.find((entry) => entry.key === key);
      if (node === undefined) {
        node = {
          key,
          title: segment,
          isLeaf: leaf,
          ...(!leaf ? { children: [] } : {}),
        };
        children.push(node);
      }
      children = node.children ?? [];
    });
  }
  return roots;
}

export function SkillsPage() {
  const i18n = useI18n();
  const { t, format } = i18n;
  const basePath = readBasePath(document);
  const navigate = useNavigate();
  const { skillId, versionId } = useParams();
  const [parameters, setParameters] = useSearchParams();
  const groupId = parameters.get("group");
  const workflowId = parameters.get("workflow") || null;
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [workflows, setWorkflows] =
    useState<ReadResult<WorkflowCatalog> | null>(null);
  const [pinnedSkills, setPinnedSkills] = useState<{
    versionId: string;
    pins: WorkflowSkillPin[] | null;
  }>();
  const [workflowRetry, setWorkflowRetry] = useState(0);
  const [versionList, setVersionList] = useState<{
    skillId: string;
    versions: SkillVersion[];
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState<"upload" | "git" | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ groupId: string; name: string }>();
  const workflowOptions =
    workflows?.kind === "ok"
      ? workflows.value.workflows.filter(
          (workflow) => !groupId || workflow.groupId === groupId,
        )
      : [];
  const workflow = workflowOptions.find((entry) => entry.id === workflowId);
  const workflowVersionId = workflow?.latestVersion?.id;
  const pins =
    pinnedSkills?.versionId === workflowVersionId
      ? pinnedSkills?.pins
      : undefined;
  const loadingPins =
    workflowId !== null &&
    (workflows === null ||
      (workflowVersionId !== undefined && pins === undefined));
  const workflowFailed =
    (workflows !== null && workflows.kind !== "ok") ||
    pins === null ||
    (workflowId !== null && workflows?.kind === "ok" && workflow === undefined);
  const pinHashes = new Map(pins?.map((pin) => [pin.skillId, pin.hash]));
  const groupNames = new Map(
    catalog?.groups.map((group) => [group.id, group.name]),
  );
  const librarySkills =
    catalog?.skills.filter(
      (skill) =>
        (!groupId || skill.groupId === groupId) &&
        (!workflowId || pinHashes.has(skill.id)),
    ) ?? [];
  const selectedSkill =
    catalog?.skills.find((skill) => skill.id === skillId) ?? null;
  const versions =
    versionList?.skillId === skillId ? (versionList?.versions ?? null) : null;
  const version =
    versions?.find((entry) => entry.hash === versionId) ??
    (versionId === undefined ? latestSkillVersion(versions) : null) ??
    null;
  const requestedPath = parameters.get("path");
  const path = requestedPath ?? version?.inventory[0]?.path ?? null;
  const tab = parameters.get("tab") ?? "preview";
  const tree = useMemo(() => fileTree(version?.inventory ?? []), [version]);
  const createGroups =
    catalog?.groups.filter((group) => group.canCreateSkill) ?? [];
  const filters = new URLSearchParams();
  if (groupId) filters.set("group", groupId);
  if (workflowId) filters.set("workflow", workflowId);
  const librarySearch = filters.toString();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const result = await loadSkills(basePath, signal);
      if (!signal?.aborted) setCatalog(result);
    },
    [basePath],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch(() => {
      if (!controller.signal.aborted) setFailure(t("skills.failed"));
    });
    return () => controller.abort();
  }, [reload, t]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflows(basePath, controller.signal).then((result) => {
      if (!controller.signal.aborted) setWorkflows(result);
    });
    return () => controller.abort();
  }, [basePath, workflowRetry]);

  useEffect(() => {
    if (!workflowId || !workflowVersionId) return;
    const controller = new AbortController();
    void loadWorkflowVersion(
      basePath,
      workflowId,
      workflowVersionId,
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted)
        setPinnedSkills({
          versionId: workflowVersionId,
          pins: result.kind === "ok" ? result.value.pins : null,
        });
    });
    return () => controller.abort();
  }, [basePath, workflowId, workflowVersionId, workflowRetry]);

  useEffect(() => {
    const controller = new AbortController();
    if (skillId !== undefined) {
      void loadVersions(basePath, skillId, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setVersionList({ skillId, versions: result.versions });
            setFailure(null);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailure(t("skills.failed"));
        });
    }
    return () => controller.abort();
  }, [basePath, skillId, t]);

  function changeParameter(key: string, value: string) {
    setParameters((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }

  function selectWorkflow(nextWorkflowId: string) {
    const next = new URLSearchParams(librarySearch);
    if (nextWorkflowId) next.set("workflow", nextWorkflowId);
    else next.delete("workflow");
    navigate({ pathname: "/skills", search: next.toString() });
  }

  function skillLocation(id: string, hash?: string) {
    return {
      pathname: hash
        ? skillVersionPath(id, hash)
        : `/skills/${encodeURIComponent(id)}`,
      search: librarySearch,
    };
  }

  function selectFile(relative: string) {
    setParameters((previous) => {
      const next = new URLSearchParams(previous);
      next.set("path", relative);
      next.set("tab", "preview");
      return next;
    });
  }

  async function addSkill(input: { groupId: string; name: string }) {
    setSaving(true);
    try {
      const result = await createSkill(basePath, input.groupId, input.name);
      await reload();
      setCreating(false);
      form.resetFields();
      navigate(`/skills/${encodeURIComponent(result.skill.id)}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("skills.failed"));
    } finally {
      setSaving(false);
    }
  }

  function updateVersion(updated: SkillVersion) {
    setVersionList((current) =>
      current?.skillId === updated.skillId
        ? {
            skillId: updated.skillId,
            versions: current.versions.map((entry) =>
              entry.hash === updated.hash ? updated : entry,
            ),
          }
        : current,
    );
  }

  function selectSavedVersion(saved: SkillVersion) {
    setVersionList((current) => {
      const entries =
        current?.skillId === saved.skillId ? current.versions : [];
      if (entries.some((entry) => entry.hash === saved.hash)) {
        return {
          skillId: saved.skillId,
          versions: entries.map((entry) =>
            entry.hash === saved.hash ? saved : entry,
          ),
        };
      }
      return { skillId: saved.skillId, versions: [saved, ...entries] };
    });
    navigate(skillLocation(saved.skillId, saved.hash));
  }

  function deleteSelection(deleted: SkillVersion) {
    const remaining = (versions ?? []).filter(
      (entry) => entry.hash !== deleted.hash,
    );
    setVersionList({ skillId: deleted.skillId, versions: remaining });
    const next = latestSkillVersion(remaining);
    navigate(skillLocation(deleted.skillId, next?.hash), { replace: true });
  }

  return (
    <>
      <div className="skills-toolbar">
        <label className="field">
          {t("scope.workflow")}
          <Select
            aria-label={t("scope.workflow")}
            value={workflowId ?? ""}
            loading={workflows === null}
            options={[
              { value: "", label: t("skills.allWorkflows") },
              ...workflowOptions.map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ${entry.groupName}`,
              })),
            ]}
            showSearch={{ optionFilterProp: "label" }}
            virtual={false}
            onChange={selectWorkflow}
          />
        </label>
        <label className="field">
          {t("skills.skill")}
          <Select
            aria-label={t("skills.skill")}
            value={
              librarySkills.some((skill) => skill.id === skillId)
                ? skillId
                : undefined
            }
            placeholder={t("skills.chooseSkill")}
            loading={catalog === null || loadingPins}
            disabled={catalog === null || loadingPins}
            allowClear
            options={librarySkills.map((skill) => {
              const groupName = groupNames.get(skill.groupId);
              return {
                value: skill.id,
                label: groupName ? `${skill.name} · ${groupName}` : skill.name,
              };
            })}
            showSearch={{ optionFilterProp: "label" }}
            virtual={false}
            onChange={(id: string | undefined) =>
              navigate(
                id
                  ? skillLocation(id, pinHashes.get(id))
                  : { pathname: "/skills", search: librarySearch },
              )
            }
          />
        </label>
        {(createGroups.length > 0 || selectedSkill?.canUpload) && (
          <Space className="skills-actions" wrap>
            {createGroups.length > 0 && (
              <Button onClick={() => setCreating(true)}>
                {t("skills.create")}
              </Button>
            )}
            {selectedSkill?.canUpload && (
              <>
                <Button onClick={() => setUploading("git")}>
                  {t("skills.importGit")}
                </Button>
                <Button type="primary" onClick={() => setUploading("upload")}>
                  {t("skills.upload")}
                </Button>
              </>
            )}
          </Space>
        )}
      </div>
      {workflowFailed && (
        <Alert
          type="warning"
          showIcon
          title={t("skills.workflowFailed")}
          action={
            <Button
              size="small"
              onClick={() => {
                setWorkflows(null);
                setPinnedSkills(undefined);
                setWorkflowRetry((attempt) => attempt + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          }
        />
      )}
      {failure !== null && (
        <Alert
          type="error"
          showIcon
          title={failure}
          action={
            <Button
              onClick={() => {
                setFailure(null);
                void reload().catch(() => setFailure(t("skills.failed")));
              }}
            >
              {t("common.retry")}
            </Button>
          }
        />
      )}
      {catalog === null ? (
        <Skeleton active />
      ) : selectedSkill === null ? (
        librarySkills.length === 0 &&
        !loadingPins &&
        !(workflowId && workflowFailed) && (
          <p className="muted">
            {t(workflowId ? "skills.workflowEmpty" : "skills.empty")}
          </p>
        )
      ) : (
        <div className="skills-registry">
          {version !== null && (
            <aside className="pane" aria-label={t("skills.files")}>
              <h2 className="pane-title">{t("skills.files")}</h2>
              <Tree.DirectoryTree
                key={version.hash}
                defaultExpandAll
                treeData={tree}
                selectedKeys={path === null ? [] : [path]}
                onSelect={(_, info) => {
                  if (info.node.isLeaf) {
                    selectFile(String(info.node.key));
                  }
                }}
              />
            </aside>
          )}
          <section className="pane main-pane" aria-label={t("skills.versions")}>
            <h2 className="pane-title">{selectedSkill.name}</h2>
            <SkillBacklog key={selectedSkill.id} skillId={selectedSkill.id} />
            {versions === null ? (
              <Skeleton active />
            ) : versions.length === 0 && versionId === undefined ? (
              <p>{t("skills.noVersions")}</p>
            ) : (
              <>
                <label className="field">
                  {t("skills.versions")}
                  <Select
                    aria-label={t("skills.versions")}
                    value={version?.hash ?? versionId}
                    options={versions.map((entry) =>
                      skillVersionOption(entry, i18n),
                    )}
                    onChange={(hash) =>
                      navigate(skillLocation(selectedSkill.id, hash))
                    }
                  />
                </label>
                {version === null ? (
                  <Alert type="error" title={t("skills.versionMissing")} />
                ) : (
                  <>
                    <VersionDetails
                      key={`${selectedSkill.id}:${version.hash}`}
                      skill={selectedSkill}
                      version={version}
                      path={path}
                      librarySearch={librarySearch}
                      limits={catalog.limits}
                      onUpdated={updateVersion}
                      onSaved={selectSavedVersion}
                      onDeleted={() => deleteSelection(version)}
                    />
                    <Tabs
                      activeKey={tab}
                      onChange={(key) => changeParameter("tab", key)}
                      items={[
                        {
                          key: "preview",
                          label: t("skills.preview"),
                          children: (
                            <>
                              <h3 className="skills-hash">{path}</h3>
                              <VersionFile
                                skillId={selectedSkill.id}
                                hash={version.hash}
                                path={path}
                              />
                            </>
                          ),
                        },
                        {
                          key: "inventory",
                          label: t("skills.inventory"),
                          children: (
                            <Table
                              size="small"
                              rowKey="path"
                              dataSource={version.inventory}
                              pagination={{ pageSize: 15 }}
                              columns={[
                                {
                                  title: t("skills.path"),
                                  dataIndex: "path",
                                  render: (relative: string) => (
                                    <Button
                                      type="link"
                                      className="skills-path-button"
                                      onClick={() => {
                                        selectFile(relative);
                                      }}
                                    >
                                      {relative}
                                    </Button>
                                  ),
                                },
                                {
                                  title: t("skills.bytes"),
                                  dataIndex: "bytes",
                                },
                                {
                                  title: t("skills.hash"),
                                  dataIndex: "hash",
                                  render: (hash: string) => (
                                    <code title={hash}>
                                      {hash.slice(0, 12)}
                                    </code>
                                  ),
                                },
                              ]}
                            />
                          ),
                        },
                        {
                          key: "compare",
                          label: t("skills.compare"),
                          children: (
                            <VersionComparison
                              skillId={selectedSkill.id}
                              versions={versions}
                              selected={version}
                            />
                          ),
                        },
                      ]}
                    />
                  </>
                )}
              </>
            )}
          </section>
          {version !== null && (
            <aside className="pane" aria-label={t("skills.details")}>
              <h2 className="pane-title">{t("skills.details")}</h2>
              <p>
                {format("skills.previewCount", {
                  count: version.inventory.length,
                })}
              </p>
              <h3>{t("skills.effects")}</h3>
              {version.scripts.length === 0 ? (
                <p className="muted">{t("skills.noScripts")}</p>
              ) : (
                version.scripts.map((script) => (
                  <div key={script.path} className="skills-script">
                    <code className="skills-hash">{script.path}</code>
                    <p>
                      {script.sideEffects === "undeclared"
                        ? t("skills.undeclared")
                        : script.sideEffects
                            .map((effect) => t(`skills.effect.${effect}`))
                            .join(", ")}
                    </p>
                  </div>
                ))
              )}
              <p className="muted">{t("skills.immutableHint")}</p>
            </aside>
          )}
        </div>
      )}
      <Modal
        open={creating}
        title={t("skills.create")}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText={t("skills.create")}
        cancelText={t("common.close")}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(input) => void addSkill(input)}
        >
          <Form.Item
            name="groupId"
            label={t("skills.group")}
            rules={[{ required: true }]}
          >
            <Select
              options={createGroups.map((group) => ({
                value: group.id,
                label: group.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="name"
            label={t("skills.name")}
            rules={[
              {
                required: true,
                pattern: /^[a-z0-9][a-z0-9-]{0,119}$/u,
                message: t("skills.nameHint"),
              },
            ]}
          >
            <Input />
          </Form.Item>
        </Form>
        {failure !== null && <Alert type="error" title={failure} />}
      </Modal>
      {uploading !== null && selectedSkill !== null && catalog !== null && (
        <UploadSkillModal
          skill={selectedSkill}
          limits={catalog.limits}
          source={uploading}
          onClose={() => setUploading(null)}
          onUploaded={(uploaded) => {
            setUploading(null);
            selectSavedVersion(uploaded);
          }}
        />
      )}
    </>
  );
}
