import { Alert, Button, Modal, Tag } from "antd";
import { useEffect, useState } from "react";
import {
  commitSources,
  previewSources,
  type GatePreview,
  type WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import type { MessageId } from "../../i18n/catalog.js";
import { STAGE_LABELS } from "../../components/StageTrack.js";
import { ConfirmationHistory } from "../../components/ConfirmationHistory.js";

const HASH_LABELS: Record<string, MessageId> = {
  pins: "gate.hash.pins",
  sourceCheck: "gate.hash.sourceCheck",
  workflowVersion: "gate.hash.workflowVersion",
};

export function SourcesGate({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t, format, locale } = useI18n();
  const inbox = useInbox();
  const [review, setReview] = useState<{
    preview: GatePreview;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const confirmation = detail.sourceGate;
  useEffect(() => {
    setReview(null);
    setFailure(null);
  }, [detail.version.id, detail.sourceCheck?.revision]);

  const preview = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await previewSources(
        basePath,
        detail.workflow.id,
        detail.version.id,
      );
      if (result.kind === "ok")
        setReview({
          preview: result.value.preview,
          requestId: crypto.randomUUID(),
        });
      else {
        setFailure(result.message || t("gate.failed"));
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (review === null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await commitSources(
        basePath,
        detail.workflow.id,
        detail.version.id,
        review.preview.confirmationHash,
        review.requestId,
      );
      if (result.kind === "ok") {
        setReview(null);
        onChanged();
        await inbox.refresh();
      } else {
        setFailure(result.message || t("gate.failed"));
        if (result.kind === "conflict") {
          setReview(null);
          onChanged();
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sources-gate" data-testid="sources-gate">
      {confirmation !== null && (
        <Alert
          showIcon
          type={confirmation.invalidatedAt === null ? "success" : "warning"}
          message={
            confirmation.invalidatedAt === null
              ? format("gate.confirmed", {
                  time: new Date(confirmation.confirmedAt).toLocaleString(
                    locale,
                  ),
                })
              : t("gate.invalidated")
          }
        />
      )}
      <ConfirmationHistory confirmations={detail.sourceGateConfirmations} />
      {failure !== null && <Alert type="error" showIcon message={failure} />}
      {detail.capabilities.confirmSources &&
        detail.sourceCheck?.status === "passed" &&
        (confirmation === null || confirmation.invalidatedAt !== null) && (
          <Button type="primary" loading={busy} onClick={() => void preview()}>
            {t("gate.review")}
          </Button>
        )}
      <Modal
        open={review !== null}
        title={t("gate.review")}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() => void confirm()}
        okText={t("gate.confirm")}
        cancelText={t("workflow.cancel")}
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
      >
        <p>{t("gate.effects")}</p>
        <ul>
          {review?.preview.effects.map((effect) => (
            <li key={effect.id}>
              {t(STAGE_LABELS[effect.id])}:{" "}
              {t(effect.state === "done" ? "status.done" : "status.inProgress")}
            </li>
          ))}
        </ul>
        <h3>{t("workflow.sources")}</h3>
        <ul className="gate-pins">
          {review?.preview.records.map((record) => (
            <li key={record.id}>
              {record.label}{" "}
              <Tag>
                {t(
                  record.type === "upgrade-source"
                    ? "workflow.pinPurpose.upgrade-source"
                    : "workflow.pinPurpose.source",
                )}
              </Tag>
              <code>{record.hash}</code>
            </li>
          ))}
        </ul>
        <details>
          <summary>{t("gate.boundHashes")}</summary>
          <dl className="gate-hashes">
            {Object.entries(review?.preview.boundHashes ?? {}).map(
              ([name, hash]) => (
                <div key={name}>
                  <dt>{t(HASH_LABELS[name])}</dt>
                  <dd>
                    <code>{hash}</code>
                  </dd>
                </div>
              ),
            )}
          </dl>
          <p>{t("gate.confirmationHash")}</p>
          <code className="gate-confirmation-hash">
            {review?.preview.confirmationHash}
          </code>
        </details>
        {failure !== null && <Alert type="error" showIcon message={failure} />}
      </Modal>
    </div>
  );
}
