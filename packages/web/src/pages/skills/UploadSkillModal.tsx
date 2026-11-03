import { Alert, Button, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  gitFolderPath,
  previewUpload,
  readUploadFile,
  uploadVersion,
  type GitContent,
  type Skill,
  type SkillVersion,
  type UploadContent,
  type UploadLimits,
  type VersionPreview,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { documentationSearch } from "../../documentation/sections.js";
import { GitSourceFields } from "./GitSourceFields.js";

export function UploadSkillModal({
  skill,
  limits,
  source = "upload",
  onClose,
  onUploaded,
}: {
  skill: Skill;
  source?: "upload" | "git";
  limits: UploadLimits;
  onClose(): void;
  onUploaded(version: SkillVersion): void;
}) {
  const { t, format } = useI18n();
  const location = useLocation();
  const basePath = readBasePath(document);
  const [content, setContent] = useState<UploadContent | GitContent | null>(
    null,
  );
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current += 1;
      controller.current?.abort();
    },
    [],
  );

  async function selectFiles(selected: FileList | null, zip: boolean) {
    const generation = ++selection.current;
    controller.current?.abort();
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setContent(null);
    setPreview(null);
    setError(null);
    const files = Array.from(selected ?? []);
    if (!files.length) return;
    const gitPath = zip
      ? null
      : gitFolderPath(
          files.map((file) => file.webkitRelativePath || file.name),
        );
    if (gitPath !== null) {
      setError(format("skills.gitFolder", { path: gitPath }));
      return;
    }
    if (
      files.length > limits.maxFiles ||
      files.reduce((sum, file) => sum + file.size, 0) > limits.maxBytes ||
      (!zip && files.some((file) => file.size > limits.maxFileBytes))
    ) {
      setError(t("skills.limitExceeded"));
      return;
    }
    setBusy(true);
    try {
      const uploaded: UploadContent = zip
        ? { archive: await readUploadFile(files[0]!) }
        : {
            files: await Promise.all(
              files.map(async (file) => ({
                path: file.webkitRelativePath || file.name,
                content: await readUploadFile(file),
              })),
            ),
          };
      if (generation !== selection.current) return;
      const result = await previewUpload(basePath, skill.id, uploaded, signal);
      if (generation !== selection.current) return;
      setContent(uploaded);
      setPreview(result.preview);
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error ? failure.message : t("skills.failed"),
        );
    } finally {
      if (generation === selection.current) setBusy(false);
    }
  }

  async function confirm() {
    if (!content || !preview) return;
    selection.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadVersion(
        basePath,
        skill.id,
        content,
        preview.hash,
      );
      onUploaded(result.version);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("skills.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`${t(source === "git" ? "skills.importGit" : "skills.upload")} · ${skill.name}`}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      maskClosable={!busy}
      width={720}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            {t("common.close")}
          </Button>
          <Button
            type="primary"
            onClick={() => void confirm()}
            loading={busy}
            disabled={!preview}
          >
            {t(
              source === "git"
                ? "skills.confirmImport"
                : "skills.confirmUpload",
            )}
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" className="skills-full-width">
        <Alert
          type="warning"
          showIcon
          title={t(
            source === "git" ? "skills.gitDataWarning" : "skills.dataWarning",
          )}
        />
        <p className="muted">
          {format(
            source === "git" ? "skills.gitLimits" : "skills.uploadLimits",
            {
              count: limits.maxFiles,
              total: Math.floor(limits.maxBytes / 1024 / 1024),
              file: Math.floor(limits.maxFileBytes / 1024 / 1024),
            },
          )}
        </p>
        {source === "git" ? (
          <GitSourceFields
            skillId={skill.id}
            busy={busy}
            onBusy={setBusy}
            onError={setError}
            onChange={() => {
              selection.current += 1;
              setContent(null);
              setPreview(null);
            }}
            onPreview={(content, preview) => {
              setContent(content);
              setPreview(preview);
            }}
          />
        ) : (
          <div className="skills-upload-inputs">
            <label className="field">
              {t("skills.folder")}
              <input
                aria-label={t("skills.folder")}
                type="file"
                multiple
                {...{ webkitdirectory: "" }}
                disabled={busy}
                onChange={(event) =>
                  void selectFiles(event.target.files, false)
                }
              />
            </label>
            <label className="field">
              {t("skills.zip")}
              <input
                aria-label={t("skills.zip")}
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(event) => void selectFiles(event.target.files, true)}
              />
            </label>
          </div>
        )}
        {error && <Alert type="error" showIcon title={error} />}
        {busy && <Spin aria-label={t("common.loading")} />}
        {preview && (
          <>
            <Typography.Paragraph>
              {format("skills.previewCount", {
                count: preview.inventory.length,
              })}
            </Typography.Paragraph>
            <code className="skills-hash">{preview.hash}</code>
            <h3>{t("skills.effects")}</h3>
            <Link
              to={{
                pathname: location.pathname,
                search: documentationSearch(
                  location.search,
                  "script-side-effects",
                ),
                hash: location.hash,
              }}
              replace
            >
              {t("documentation.effects.link")}
            </Link>
            {preview.scripts.length ? (
              <>
                <Alert type="info" title={t("effects.uploadPending")} />
                <ul>
                  {preview.scripts.map((script) => (
                    <li key={script.path}>
                      <code>{script.path}</code> · {t("effects.pending")}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t("skills.noScripts")}</p>
            )}
            <Alert type="info" title={t("skills.immutableHint")} />
          </>
        )}
      </Space>
    </Modal>
  );
}
