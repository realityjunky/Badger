import { Alert, Button, Input, Modal, Select, Space, Spin } from "antd";
import { useEffect, useState } from "react";
import {
  loadFilePreview,
  previewUpload,
  readUploadFile,
  uploadVersion,
  type BrowserEditContent,
  type FilePreview,
  type SkillVersion,
  type UploadLimits,
  type VersionDiff,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { VersionChanges } from "./VersionChanges.js";
import { VersionFile } from "./VersionFile.js";
import { skillVersionOption } from "./versionDisplay.js";

type FileEdit = { text: string } | { file: File } | null;

export function EditSkillFilesDialog({
  base,
  initialPath,
  limits,
  onClose,
  onSaved,
}: {
  base: SkillVersion;
  initialPath: string | null;
  limits: UploadLimits;
  onClose(): void;
  onSaved(version: SkillVersion): void;
}) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const basePath = readBasePath(document);
  const [path, setPath] = useState(initialPath);
  const [newPath, setNewPath] = useState("");
  const [edits, setEdits] = useState(new Map<string, FileEdit>());
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [fileError, setFileError] = useState(false);
  const [review, setReview] = useState<{
    diff: VersionDiff;
    content: BrowserEditContent;
    confirmationHash: string;
  } | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = base.inventory.find((file) => file.path === path);
  const edit = path === null ? undefined : edits.get(path);
  const text = edit && "text" in edit ? edit.text : preview?.content;
  const changedFile = review?.diff.files.find((file) => file.path === diffPath);
  const reviewedEdit = changedFile && edits.get(changedFile.path);
  const paths = [
    ...new Set([...base.inventory.map((file) => file.path), ...edits.keys()]),
  ].sort();

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setFileError(false);
    if (original) {
      void loadFilePreview(
        basePath,
        base.skillId,
        base.hash,
        original.path,
        controller.signal,
        "edit",
      )
        .then((file) => {
          if (!controller.signal.aborted) setPreview(file);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFileError(true);
        });
    }
    return () => controller.abort();
  }, [basePath, base.skillId, base.hash, original]);

  function updateFile(file: string, value?: FileEdit) {
    setError(null);
    setEdits((previous) => {
      const next = new Map(previous);
      if (value === undefined) next.delete(file);
      else next.set(file, value);
      return next;
    });
  }

  function addFile() {
    const file = newPath.trim();
    if (!file) return;
    if (paths.includes(file)) {
      setError(t("skills.pathExists"));
      return;
    }
    updateFile(file, { text: "" });
    setPath(file);
    setNewPath("");
  }

  async function reviewEdits() {
    setBusy(true);
    setError(null);
    try {
      const changes = await Promise.all(
        [...edits].map(async ([path, edit]) => ({
          path,
          content:
            edit === null
              ? null
              : await readUploadFile(
                  "text" in edit ? new Blob([edit.text]) : edit.file,
                ),
        })),
      );
      const content = { baseHash: base.hash, changes };
      const { preview, diff } = await previewUpload(
        basePath,
        base.skillId,
        content,
      );
      if (!diff || !preview.confirmationHash)
        throw new Error(t("skills.failed"));
      setDiffPath(null);
      setReview({ diff, content, confirmationHash: preview.confirmationHash });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("skills.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion() {
    if (!review || !review.diff.files.length) return;
    setBusy(true);
    setError(null);
    try {
      const { version } = await uploadVersion(
        basePath,
        base.skillId,
        review.content,
        review.diff.to,
        review.confirmationHash,
      );
      onSaved(version);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("skills.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("skills.editFiles")}
      onCancel={onClose}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      width={840}
      footer={(_, { CancelBtn, OkBtn }) => (
        <>
          <CancelBtn />
          {review && (
            <Button
              disabled={busy}
              onClick={() => {
                setReview(null);
                setError(null);
              }}
            >
              {t("skills.backToEdit")}
            </Button>
          )}
          <OkBtn />
        </>
      )}
      okText={t(review ? "skills.saveSuccessor" : "skills.reviewChanges")}
      okButtonProps={{
        disabled: review ? !review.diff.files.length : edits.size === 0,
      }}
      onOk={() => void (review ? saveVersion() : reviewEdits())}
    >
      <Space orientation="vertical" size="middle" className="skills-full-width">
        <p className="skills-hash">
          {t("skills.baseVersion")} · {skillVersionOption(base, i18n).label}
          <br />
          <code>{base.hash}</code>
        </p>
        {error && <Alert type="error" showIcon title={error} />}
        {review ? (
          <>
            <VersionChanges diff={review.diff} onSelectFile={setDiffPath} />
            {changedFile && (
              <section>
                <h3 className="skills-hash">{changedFile.path}</h3>
                <div className="skills-compare-files">
                  <div>
                    <h4>{t("skills.before")}</h4>
                    <VersionFile
                      skillId={base.skillId}
                      hash={changedFile.before ? base.hash : null}
                      path={changedFile.path}
                    />
                  </div>
                  <div>
                    <h4>{t("skills.after")}</h4>
                    {reviewedEdit && "text" in reviewedEdit ? (
                      <pre className="skills-file-preview">
                        <code>{reviewedEdit.text}</code>
                      </pre>
                    ) : changedFile.after ? (
                      <p className="skills-hash">
                        {format("skills.afterBytes", {
                          bytes: changedFile.after.bytes,
                        })}
                        {" · "}
                        <code>{changedFile.after.hash}</code>
                      </p>
                    ) : (
                      <p className="muted">{t("skills.missingFile")}</p>
                    )}
                  </div>
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            <label className="field">
              {t("skills.fileToEdit")}
              <Select
                aria-label={t("skills.fileToEdit")}
                showSearch
                disabled={busy}
                value={path}
                options={paths.map((path) => ({ label: path, value: path }))}
                onChange={setPath}
              />
            </label>
            {path !== null && (
              <>
                {edit === null ? (
                  <Alert type="info" title={t("skills.removed")} />
                ) : (
                  <>
                    {fileError && (
                      <Alert type="error" title={t("skills.failed")} />
                    )}
                    {original &&
                      !preview &&
                      !fileError &&
                      edit === undefined && (
                        <Spin aria-label={t("common.loading")} />
                      )}
                    {edit && "file" in edit ? (
                      <p className="skills-hash">
                        {format("skills.selectedReplacement", {
                          name: edit.file.name,
                        })}
                      </p>
                    ) : typeof text === "string" ? (
                      <label className="field">
                        {t("skills.fileContents")}
                        <Input.TextArea
                          autoSize={{ minRows: 6, maxRows: 14 }}
                          disabled={busy}
                          value={text}
                          onChange={(event) => {
                            const value = event.target.value;
                            updateFile(
                              path,
                              value === preview?.content
                                ? undefined
                                : { text: value },
                            );
                          }}
                        />
                      </label>
                    ) : (
                      preview && (
                        <Alert
                          type="info"
                          title={t(
                            preview.tooLarge
                              ? "skills.editTooLarge"
                              : "skills.binary",
                          )}
                        />
                      )
                    )}
                    <label className="field">
                      {t("skills.replaceFile")}
                      <input
                        type="file"
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          if (file.size > limits.maxFileBytes)
                            setError(t("skills.limitExceeded"));
                          else updateFile(path, { file });
                        }}
                      />
                    </label>
                  </>
                )}
                <Space wrap>
                  {edit !== undefined && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        updateFile(path);
                        if (!original) setPath(null);
                      }}
                    >
                      {t("skills.undoFileChange")}
                    </Button>
                  )}
                  {edit !== null && (
                    <Button
                      danger
                      disabled={busy}
                      onClick={() => {
                        updateFile(path, original ? null : undefined);
                        if (!original) setPath(null);
                      }}
                    >
                      {t("skills.removeFile")}
                    </Button>
                  )}
                </Space>
              </>
            )}
            <label className="field">
              {t("skills.newFilePath")}
              <Input
                value={newPath}
                disabled={busy}
                onChange={(event) => setNewPath(event.target.value)}
                onPressEnter={addFile}
              />
            </label>
            <Button disabled={busy || !newPath.trim()} onClick={addFile}>
              {t("skills.addFile")}
            </Button>
          </>
        )}
      </Space>
    </Modal>
  );
}
