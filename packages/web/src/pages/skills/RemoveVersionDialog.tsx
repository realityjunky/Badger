import { Alert, Button, Modal, Spin } from "antd";
import { useEffect, useState } from "react";
import {
  loadRemoval,
  removeVersion,
  SkillRequestError,
  type SkillVersion,
  type SkillVersionRemoval,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { skillVersionOption } from "./versionDisplay.js";

export function RemoveVersionDialog({
  version,
  onClose,
  onRemoved,
}: {
  version: SkillVersion;
  onClose(): void;
  onRemoved(result: SkillVersion | null): void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const basePath = readBasePath(document);
  const { skillId, hash } = version;
  const [removal, setRemoval] = useState<SkillVersionRemoval | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = removal?.action;

  useEffect(() => {
    const controller = new AbortController();
    void loadRemoval(basePath, skillId, hash, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRemoval(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            failure instanceof Error ? failure.message : t("skills.failed"),
          );
      });
    return () => controller.abort();
  }, [basePath, skillId, hash, loadAttempt, t]);

  function reload() {
    setRemoval(null);
    setLoadError(null);
    setLoadAttempt((previous) => previous + 1);
  }

  async function confirm() {
    if ((action !== "delete" && action !== "retire") || busy) return;
    setBusy(true);
    setWriteError(null);
    try {
      const result = await removeVersion(basePath, skillId, hash, action);
      onRemoved(result.version);
    } catch (failure) {
      if (failure instanceof SkillRequestError && failure.status === 409) {
        setWriteError(t("skills.removalChanged"));
        reload();
      } else {
        setWriteError(
          failure instanceof Error ? failure.message : t("skills.failed"),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("skills.removeVersion")}
      onCancel={onClose}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      okButtonProps={{
        danger: true,
        disabled: action === undefined || action === "none",
      }}
      okText={t(
        action === "delete"
          ? "skills.deleteVersion"
          : action === "retire"
            ? "skills.retireVersion"
            : "skills.removeVersion",
      )}
      onOk={() => void confirm()}
      cancelText={t("common.cancel")}
    >
      <p className="skills-hash">
        {skillVersionOption(version, i18n).label}
        <br />
        <code>{hash}</code>
      </p>
      {writeError && <Alert type="error" showIcon title={writeError} />}
      {loadError && (
        <Alert
          type="error"
          showIcon
          title={loadError}
          action={<Button onClick={reload}>{t("common.retry")}</Button>}
        />
      )}
      {action === undefined && !loadError && (
        <Spin aria-label={t("common.loading")} />
      )}
      {action !== undefined && (
        <p>
          {t(
            action === "delete"
              ? "skills.canDeleteVersion"
              : action === "retire"
                ? "skills.canRetireVersion"
                : "skills.alreadyRetired",
          )}
        </p>
      )}
    </Modal>
  );
}
