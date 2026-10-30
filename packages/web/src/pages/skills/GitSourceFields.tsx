import { Button, Input, Select, Space } from "antd";
import { useEffect, useState } from "react";
import {
  loadRepositories,
  registerRepository,
  previewGit,
  type GitContent,
  type SkillRepository,
  type VersionPreview,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function GitSourceFields({
  skillId,
  busy,
  onBusy,
  onError,
  onChange,
  onPreview,
}: {
  skillId: string;
  busy: boolean;
  onBusy(busy: boolean): void;
  onError(error: string | null): void;
  onChange(): void;
  onPreview(content: GitContent, preview: VersionPreview): void;
}) {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [repositories, setRepositories] = useState<SkillRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState<string>();
  const [url, setUrl] = useState("");
  const [commit, setCommit] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void loadRepositories(basePath, skillId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRepositories(result.repositories);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          onError(error instanceof Error ? error.message : t("skills.failed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [basePath, skillId, onError, t]);

  async function register() {
    onBusy(true);
    onError(null);
    try {
      const result = await registerRepository(basePath, skillId, url.trim());
      setRepositories((current) => [
        ...current.filter((entry) => entry.id !== result.repository.id),
        result.repository,
      ]);
      setRepositoryId(result.repository.id);
      setUrl("");
      onChange();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("skills.failed"));
    } finally {
      onBusy(false);
    }
  }
  async function inspect() {
    if (repositoryId === undefined) return;
    onChange();
    onBusy(true);
    onError(null);
    try {
      const content = { repositoryId, commit: commit.trim() };
      const result = await previewGit(basePath, skillId, content);
      onPreview(content, result.preview);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("skills.failed"));
    } finally {
      onBusy(false);
    }
  }
  return (
    <Space orientation="vertical" size="middle" className="skills-full-width">
      <label className="field">
        {t("skills.repository")}
        <Select
          aria-label={t("skills.repository")}
          loading={loading}
          disabled={busy || loading}
          value={repositoryId}
          options={repositories.map((entry) => ({
            value: entry.id,
            label: entry.url,
          }))}
          onChange={(value: string) => {
            setRepositoryId(value);
            onChange();
          }}
        />
      </label>
      <label className="field">
        {t("skills.repositoryUrl")}
        <Input
          aria-label={t("skills.repositoryUrl")}
          type="url"
          value={url}
          disabled={busy}
          placeholder="https://github.com/team/skill.git"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <Button
        disabled={busy || loading || url.trim() === ""}
        onClick={() => void register()}
      >
        {t("skills.registerRepository")}
      </Button>
      <label className="field">
        {t("skills.commit")}
        <Input
          aria-label={t("skills.commit")}
          value={commit}
          disabled={busy}
          onChange={(event) => {
            setCommit(event.target.value);
            onChange();
          }}
        />
      </label>
      <p className="muted">{t("skills.commitHint")}</p>
      <Button
        disabled={
          busy ||
          loading ||
          repositoryId === undefined ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit.trim())
        }
        loading={busy}
        onClick={() => void inspect()}
      >
        {t("skills.previewCommit")}
      </Button>
    </Space>
  );
}
