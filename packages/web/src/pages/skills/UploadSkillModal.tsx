import { Alert, Button, Modal, Select, Space, Spin, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  gitFolderPath,
  previewUpload,
  readUploadFile,
  suggestScriptEffects,
  undeclaredScripts,
  uploadVersion,
  type GitContent,
  type SideEffect,
  type Skill,
  type SkillVersion,
  type UploadContent,
  type UploadLimits,
  type VersionPreview,
  type SuggestionResult,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { documentationSearch } from "../../documentation/sections.js";

import { GitSourceFields } from "./GitSourceFields.js";

const SIDE_EFFECTS: SideEffect[] = [
  "none",
  "local-writes",
  "network",
  "scheduler-submission",
  "installs",
];

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
  const [scripts, setScripts] = useState<Record<string, SideEffect[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const editedScripts = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const selection = useRef(0);
  const undeclared =
    preview === null ? [] : undeclaredScripts(preview, scripts);

  useEffect(() => {
    setSuggestion(null);
    setSuggestionError(null);
    const task = preview?.suggestion;
    if (!preview || task?.state !== "ready" || !task.id) {
      setSuggesting(false);
      return;
    }
    const generation = selection.current;
    const pending = new AbortController();
    setSuggesting(true);
    void suggestScriptEffects(
      basePath,
      skill.id,
      task.id,
      preview.hash,
      pending.signal,
    )
      .then(({ suggestion }) => {
        if (pending.signal.aborted || generation !== selection.current) return;
        if (
          suggestion.binding.sourceHash !== preview.hash ||
          suggestion.binding.promptRevision !== task.prompt.revision ||
          suggestion.binding.configurationRevision !==
            task.binding?.configurationRevision
        ) {
          setSuggestionError(t("llm.stale"));
          return;
        }
        setSuggestion(suggestion);
        setScripts((current) => {
          if (generation !== selection.current) return current;
          const next = { ...current };
          for (const script of suggestion.scripts)
            if (
              script.complete &&
              script.effects.length &&
              !editedScripts.current.has(script.path)
            )
              next[script.path] = script.effects;
          return next;
        });
      })
      .catch((failure: unknown) => {
        if (!pending.signal.aborted && generation === selection.current)
          setSuggestionError(
            failure instanceof Error ? failure.message : t("llm.failed"),
          );
      })
      .finally(() => {
        if (!pending.signal.aborted && generation === selection.current)
          setSuggesting(false);
      });
    return () => pending.abort();
  }, [basePath, preview, skill.id, t]);

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
    setScripts({});
    editedScripts.current.clear();
    setError(null);
    const files = Array.from(selected ?? []);
    if (files.length === 0) return;
    // A large .git folder would otherwise read as only over the limits.
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
    if (content === null || preview === null || undeclared.length > 0) return;
    selection.current += 1;
    setSuggesting(false);
    setBusy(true);
    setError(null);
    try {
      const result = await uploadVersion(
        basePath,
        skill.id,
        content,
        scripts,
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
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            {t("common.close")}
          </Button>
          <Button
            type="primary"
            onClick={() => void confirm()}
            loading={busy}
            disabled={preview === null || undeclared.length > 0}
          >
            {t(
              source === "git"
                ? "skills.confirmImport"
                : "skills.confirmUpload",
            )}
          </Button>
        </Space>
      }
      width={720}
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
              editedScripts.current.clear();
              setContent(null);
              setPreview(null);
              setScripts({});
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
        {error !== null && <Alert type="error" showIcon title={error} />}
        {busy && <Spin aria-label={t("common.loading")} />}
        {preview !== null && (
          <>
            <Typography.Paragraph>
              {format("skills.previewCount", {
                count: preview.inventory.length,
              })}
            </Typography.Paragraph>
            <code className="skills-hash">{preview.hash}</code>
            <h3>{t("skills.effects")}</h3>
            <p className="muted">{t("skills.effectsHint")}</p>
            <Link
              to={{
                ...location,
                search: documentationSearch(
                  location.search,
                  "script-side-effects",
                ),
              }}
              replace
            >
              {t("documentation.effects.link")}
            </Link>
            {suggesting && (
              <p role="status">
                <Spin size="small" /> {t("llm.suggesting")}
              </p>
            )}
            {(suggestionError ||
              suggestion?.message ||
              preview.suggestion?.message) && (
              <Alert
                type="warning"
                showIcon
                title={
                  suggestionError ??
                  suggestion?.message ??
                  preview.suggestion?.message
                }
              />
            )}
            {preview.suggestion && (
              <details>
                <summary>{t("llm.activePrompt")}</summary>
                <p>{preview.suggestion.prompt.description}</p>
                <code className="skills-hash">
                  {preview.suggestion.prompt.revision}
                </code>
                <pre className="source-preview">
                  {preview.suggestion.prompt.text}
                </pre>
              </details>
            )}
            {preview.scripts.length === 0 && <p>{t("skills.noScripts")}</p>}
            {preview.scripts.map((script) => (
              <label key={script.path} className="field">
                <code>{script.path}</code>
                <Select
                  mode="multiple"
                  disabled={busy}
                  aria-label={`${t("skills.effects")} ${script.path}`}
                  placeholder={t("skills.undeclared")}
                  value={scripts[script.path] ?? []}
                  options={SIDE_EFFECTS.map((effect) => ({
                    value: effect,
                    label: t(`skills.effect.${effect}`),
                  }))}
                  onChange={(effects: SideEffect[]) => {
                    editedScripts.current.add(script.path);
                    const last = effects[effects.length - 1];
                    const normalized =
                      last === "none"
                        ? ["none" as const]
                        : effects.filter((effect) => effect !== "none");
                    setScripts((current) => {
                      const next = { ...current };
                      if (normalized.length === 0) delete next[script.path];
                      else next[script.path] = normalized;
                      return next;
                    });
                  }}
                />
                {suggestion?.scripts
                  .filter((item) => item.path === script.path)
                  .map((item) => (
                    <div key={item.path}>
                      <p>{item.rationale}</p>
                      {!item.complete && (
                        <p role="status">
                          {t("llm.needsReview")} {item.uncertainty}
                        </p>
                      )}
                      {item.citations.map((citation, index) => (
                        <details key={`${citation.path}-${index}`}>
                          <summary>
                            {citation.path}:{citation.startLine}–
                            {citation.endLine}
                          </summary>
                          <code className="skills-hash">{citation.hash}</code>
                          <pre className="source-preview">
                            {citation.excerpt}
                          </pre>
                        </details>
                      ))}
                    </div>
                  ))}
              </label>
            ))}
            {undeclared.length > 0 && (
              <Alert
                type="warning"
                showIcon
                title={format("skills.declareRemaining", {
                  count: undeclared.length,
                })}
              />
            )}
            <Alert type="info" title={t("skills.immutableHint")} />
          </>
        )}
      </Space>
    </Modal>
  );
}
