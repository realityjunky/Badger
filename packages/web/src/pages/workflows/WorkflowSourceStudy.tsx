import { Alert, Button, Modal, Popconfirm, Space, Switch, Tag } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  confirmStudy,
  previewStudy,
  retireRecord,
  studyPath,
  type StudyRecord,
} from "../../api/source-study.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { StudyRecordDialog } from "./StudyRecordDialog.js";
import {
  StudyContentView,
  StudyEvidenceLinks,
  StudyRecordInspector,
} from "./StudyRecordDetails.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";
import { EvidenceChanges } from "../../components/EvidenceChanges.js";
import { RecordOriginLink } from "../../components/RecordOriginLink.js";
import { ScriptEffectsPanel } from "./ScriptEffectsPanel.js";

export function WorkflowSourceStudy({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t, format, locale } = useI18n();
  const [editor, setEditor] = useState<{
    kind: StudyRecord["kind"];
    previous?: StudyRecord;
  } | null>(null);
  const [review, setReview] = useState<{
    skillId: string;
    preview: GatePreview;
    requestId: string;
  } | null>(null);
  const [retired, setRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const study = detail.sourceStudy;
  const canManage = detail.capabilities.manageSourceStudy;
  const ready =
    detail.version.stages.find((s) => s.id === "sources")?.state === "done";
  const base = studyPath(detail.workflow.id, detail.version.id);

  async function openReview(skillId: string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await previewStudy(basePath, base, skillId);
      if (result.kind === "ok")
        setReview({
          skillId,
          preview: result.value.preview,
          requestId: crypto.randomUUID(),
        });
      else setFailure(result);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (review === null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await confirmStudy(
        basePath,
        base,
        review.skillId,
        review.preview.confirmationHash,
        review.requestId,
      );
      if (result.kind === "ok") {
        setReview(null);
        onChanged();
      } else {
        setFailure(result);
        if (result.kind === "conflict") setReview(null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function retire(record: StudyRecord) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await retireRecord(basePath, base, record);
      if (result.kind === "ok") onChanged();
      else setFailure(result);
    } finally {
      setBusy(false);
    }
  }
  function records(kind: StudyRecord["kind"], entries: StudyRecord[]) {
    const visible = entries.filter(
      (record) => retired || record.status === "active",
    );
    return (
      <section
        className="study-record-list"
        aria-label={t(kind === "fact" ? "study.facts" : "study.interfaces")}
      >
        <div className="workflow-card-heading">
          <h3>{t(kind === "fact" ? "study.facts" : "study.interfaces")}</h3>
          {canManage && (
            <Button
              disabled={
                detail.pins.length === 0 ||
                detail.sourceCheck?.status !== "passed"
              }
              onClick={() => setEditor({ kind })}
            >
              {t(kind === "fact" ? "study.addFact" : "study.addInterface")}
            </Button>
          )}
        </div>
        {visible.length === 0 && (
          <p className="muted">{t("study.noRecords")}</p>
        )}
        {visible.map((record) => (
          <article
            className="study-record"
            key={record.id}
            id={`study-${record.id}`}
          >
            <Space wrap>
              <Tag>
                {format("study.revision", { revision: record.revision })}
              </Tag>
              {record.status === "retired" && <Tag>{t("study.retired")}</Tag>}
              {record.stale && record.status === "active" && (
                <Tag color="warning">{t("study.stale")}</Tag>
              )}
            </Space>
            <StudyContentView content={record.content} detail={detail} />
            <StudyEvidenceLinks record={record} />
            <RecordOriginLink
              origin={record.origin}
              workflowId={detail.workflow.id}
              kind="source-study"
            />
            <EvidenceChanges changes={record.evidenceChanges} />
            <Space wrap>
              <Link
                to={{
                  search: `?studyRecord=${encodeURIComponent(record.id)}`,
                  hash: "#source-study",
                }}
              >
                {t("study.history")}
              </Link>
              {canManage && record.status === "active" && (
                <>
                  <Button
                    size="small"
                    onClick={() => setEditor({ kind, previous: record })}
                  >
                    {t("study.edit")}
                  </Button>
                  <Popconfirm
                    title={t("study.retireConfirm")}
                    okText={t("study.retire")}
                    cancelText={t("workflow.cancel")}
                    onConfirm={() => retire(record)}
                  >
                    <Button size="small" danger disabled={busy}>
                      {t("study.retire")}
                    </Button>
                  </Popconfirm>
                </>
              )}
            </Space>
          </article>
        ))}
      </section>
    );
  }
  return (
    <section
      className="workflow-panel source-study-panel"
      id="source-study"
      aria-labelledby="source-study-title"
    >
      <div className="workflow-card-heading">
        <div>
          <h2 id="source-study-title">{t("stage.sourceStudy")}</h2>
          <p className="muted">{t("study.description")}</p>
        </div>
        <label className="study-retired-toggle">
          <Switch checked={retired} onChange={setRetired} />{" "}
          {t("study.showRetired")}
        </label>
      </div>
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onChanged} />
      )}
      {canManage && (
        <p>
          <Link
            to={`/questionnaire?${new URLSearchParams({ workflow: detail.workflow.id, version: detail.version.id, panel: "suggestions" })}`}
          >
            {t("drafting.openJobs")}
          </Link>
        </p>
      )}
      {!ready && <Alert type="info" title={t("study.confirmSourcesFirst")} />}
      <p role="status">
        {format("study.progress", {
          studied: study.studies.filter((s) => s.studied).length,
          total: study.studies.length,
        })}
      </p>
      <div className="study-pins">
        {study.studies.map((pin) => (
          <article
            className="study-pin"
            key={pin.skillId}
            aria-label={pin.skillName}
          >
            <div>
              <strong>{pin.skillName}</strong>
              <p className="study-hash">
                <code>{pin.hash}</code>
              </p>
              {pin.studied && pin.confirmation !== null && (
                <p className="muted">
                  {pin.confirmation.actorId} ·{" "}
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(pin.confirmation.confirmedAt))}
                </p>
              )}
            </div>
            <Space wrap>
              <Tag color={pin.studied ? "success" : "default"}>
                {t(pin.studied ? "study.studied" : "study.remaining")}
              </Tag>
              {canManage && !pin.studied && (
                <Button
                  disabled={!ready || busy}
                  onClick={() => void openReview(pin.skillId)}
                >
                  {t("study.review")}
                </Button>
              )}
            </Space>
          </article>
        ))}
      </div>
      {records("fact", study.facts)}
      {study.studies.map((pin) => (
        <ScriptEffectsPanel
          key={`${pin.skillId}:${pin.hash}`}
          basePath={basePath}
          skillId={pin.skillId}
          hash={pin.hash}
          workflowBase={base}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
      {records("interface", study.interfaces)}
      {editor !== null && (
        <StudyRecordDialog
          basePath={basePath}
          detail={detail}
          kind={editor.kind}
          previous={editor.previous}
          onCancel={() => setEditor(null)}
          onChanged={onChanged}
        />
      )}
      <StudyRecordInspector basePath={basePath} detail={detail} />
      <Modal
        open={review !== null}
        width={720}
        title={t("study.review")}
        okText={t("study.confirm")}
        cancelText={t("workflow.cancel")}
        confirmLoading={busy}
        onCancel={() => setReview(null)}
        onOk={() => void confirm()}
        maskClosable={false}
        closable={!busy}
        cancelButtonProps={{ disabled: busy }}
      >
        <p>{t("study.confirmHint")}</p>
        {review !== null && (
          <>
            {review.preview.records.map((record) => (
              <div className="study-review-record" key={record.id}>
                <p>{record.label}</p>
                <code className="study-hash">{record.hash}</code>
              </div>
            ))}
            <p>{t("gate.confirmationHash")}</p>
            <code className="study-hash">
              {review.preview.confirmationHash}
            </code>
          </>
        )}
      </Modal>
    </section>
  );
}
