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
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  createSkill,
  loadSkills,
  loadVersions,
  type SkillCatalog,
  type SkillFile,
  type SkillVersion,
} from "../api/skills.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import { SkillBacklog } from "./skills/SkillBacklog.js";
import { UploadSkillModal } from "./skills/UploadSkillModal.js";
import { VersionComparison } from "./skills/VersionComparison.js";
import { VersionFile } from "./skills/VersionFile.js";

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
  const { t, format } = useI18n();
  const basePath = readBasePath(document);
  const navigate = useNavigate();
  const { skillId, versionId } = useParams();
  const [parameters, setParameters] = useSearchParams();
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [versions, setVersions] = useState<SkillVersion[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ groupId: string; name: string }>();
  const selectedSkill =
    catalog?.skills.find((skill) => skill.id === skillId) ?? null;
  const version =
    versions?.find((entry) => entry.hash === versionId) ??
    (versionId === undefined ? versions?.[0] : null) ??
    null;
  const path = parameters.get("path") ?? version?.inventory[0]?.path ?? null;
  const tab = parameters.get("tab") ?? "preview";
  const tree = useMemo(() => fileTree(version?.inventory ?? []), [version]);
  const createGroups =
    catalog?.groups.filter((group) => group.canCreateSkill) ?? [];

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
    setVersions(null);
    if (skillId !== undefined) {
      void loadVersions(basePath, skillId, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setVersions(result.versions);
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

  return (
    <>
      <PageHeader
        title={t("page.skills.title")}
        description={t("page.skills.description")}
        actions={
          <Space wrap>
            {createGroups.length > 0 && (
              <Button onClick={() => setCreating(true)}>
                {t("skills.create")}
              </Button>
            )}
            {selectedSkill?.canUpload && (
              <Button type="primary" onClick={() => setUploading(true)}>
                {t("skills.upload")}
              </Button>
            )}
          </Space>
        }
      />
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
      ) : (
        <div className="three-pane skills-registry">
          <aside className="pane" aria-label={t("skills.library")}>
            <h2 className="pane-title">{t("skills.library")}</h2>
            {catalog.skills.length === 0 && (
              <p className="muted">{t("skills.empty")}</p>
            )}
            <ul className="skills-list">
              {catalog.skills.map((skill) => (
                <li key={skill.id}>
                  <Link
                    className={
                      skill.id === skillId
                        ? "skills-link selected"
                        : "skills-link"
                    }
                    aria-current={skill.id === skillId ? "page" : undefined}
                    to={`/skills/${encodeURIComponent(skill.id)}`}
                  >
                    <strong>{skill.name}</strong>
                    <span className="muted">
                      {
                        catalog.groups.find(
                          (group) => group.id === skill.groupId,
                        )?.name
                      }
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {version !== null && (
              <>
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
              </>
            )}
          </aside>
          <section className="pane main-pane" aria-label={t("skills.versions")}>
            {selectedSkill === null ? (
              <p className="muted">{t("skills.selectSkill")}</p>
            ) : (
              <>
                <h2 className="pane-title">{selectedSkill.name}</h2>
                <SkillBacklog
                  key={selectedSkill.id}
                  skillId={selectedSkill.id}
                />
                {versions === null ? (
                  <Skeleton active />
                ) : versions.length === 0 ? (
                  <p>{t("skills.noVersions")}</p>
                ) : (
                  <>
                    <label className="field">
                      {t("skills.versions")}
                      <Select
                        aria-label={t("skills.versions")}
                        value={version?.hash ?? versionId}
                        options={versions.map((entry) => ({
                          value: entry.hash,
                          label: `${entry.hash.slice(0, 12)} · ${new Date(entry.createdAt).toLocaleString()}`,
                        }))}
                        onChange={(hash) =>
                          navigate(
                            `/skills/${encodeURIComponent(selectedSkill.id)}/versions/${hash}`,
                          )
                        }
                      />
                    </label>
                    {version === null ? (
                      <Alert type="error" title={t("skills.failed")} />
                    ) : (
                      <>
                        <p>{version.description}</p>
                        <code className="skills-hash">{version.hash}</code>
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
              </>
            )}
          </section>
          <aside className="pane" aria-label={t("skills.details")}>
            <h2 className="pane-title">{t("skills.details")}</h2>
            {version !== null && (
              <>
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
              </>
            )}
          </aside>
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
      {uploading && selectedSkill !== null && catalog !== null && (
        <UploadSkillModal
          skill={selectedSkill}
          limits={catalog.limits}
          onClose={() => setUploading(false)}
          onUploaded={(uploaded) => {
            setUploading(false);
            setVersions((current) => [
              uploaded,
              ...(current ?? []).filter(
                (entry) => entry.hash !== uploaded.hash,
              ),
            ]);
            navigate(
              `/skills/${encodeURIComponent(selectedSkill.id)}/versions/${uploaded.hash}`,
            );
          }}
        />
      )}
    </>
  );
}
