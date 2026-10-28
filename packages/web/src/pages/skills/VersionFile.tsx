import { Alert, Spin } from "antd";
import { useEffect, useState } from "react";
import { loadFilePreview, type FilePreview } from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function VersionFile({
  skillId,
  hash,
  path,
}: {
  skillId: string;
  hash: string | null;
  path: string | null;
}) {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setFailed(false);
    if (hash !== null && path !== null) {
      void loadFilePreview(basePath, skillId, hash, path, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPreview(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }
    return () => controller.abort();
  }, [basePath, skillId, hash, path]);
  if (hash === null) return <p className="muted">{t("skills.missingFile")}</p>;
  if (path === null) return <p className="muted">{t("skills.selectFile")}</p>;
  if (failed) return <Alert type="error" title={t("skills.failed")} />;
  if (preview === null) return <Spin aria-label={t("common.loading")} />;
  if (preview.tooLarge)
    return <Alert type="info" title={t("skills.previewTooLarge")} />;
  if (preview.binary) return <Alert type="info" title={t("skills.binary")} />;
  return (
    <pre
      className="skills-file-preview"
      aria-label={`${t("skills.preview")} ${path}`}
    >
      <code>{preview.content}</code>
    </pre>
  );
}
