import {
  Alert,
  Button,
  Empty,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Tabs,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
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
import { WorkflowPanel } from "./WorkflowPanel.js";

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
  const { hash, search } = useLocation();
  const [section, setSection] = useState("overview");
  const [selectedFact, setSelectedFact] = useState<string>();
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
  const linkedId =
    new URLSearchParams(search).get("studyRecord") ??
    (hash.startsWith("#study-") ? hash.slice("#study-".length) : null);
  const linkedRecord = [...study.facts, ...study.interfaces].find(
    (record) => record.id === linkedId,
  );
  const linkedKind = linkedRecord?.kind;
  const linkedStatus = linkedRecord?.status;
  useEffect(() => {
    if (linkedKind === undefined) return;
    setSection(linkedKind === "fact" ? "facts" : "interfaces");
    if (linkedKind === "fact" && linkedId !== null) setSelectedFact(linkedId);
    if (linkedStatus === "retired") setRetired(true);
  }, [linkedId, linkedKind, linkedStatus]);

  const effectPins = study.studies.filter(
    (pin) =>
      !detail.sourceCheck?.sources.some(
        (source) =>
          source.name === pin.skillName &&
          source.hash === pin.hash &&
          source.status === "available" &&
          source.scripts.length === 0,
      ),
  );
  const canManage = detail.capabilities.manageSourceStudy;
  const ready =
    detail.version.stages.find((s) => s.id === "sources")?.state === "done";
  const base = studyPath(detail.workflow.id, detail.version.id);
  const jobsQuery = {
    workflow: detail.workflow.id,
    version: detail.version.id,
    panel: "suggestions",
  };

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
    const recordCard = (record: StudyRecord) => (
      <article
        className="study-record"
        key={record.id}
        id={`study-${record.id}`}
      >
        <Space wrap>
          <Tag>{format("study.revision", { revision: record.revision })}</Tag>
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
    );
    const activeFact =
      visible.find((record) => record.id === selectedFact) ?? visible[0];
    return (
      <section
        className="study-record-list"
        aria-label={t(kind === "fact" ? "study.facts" : "study.interfaces")}
      >
        <div className="workflow-card-heading">
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
          <label className="study-retired-toggle">
            <Switch checked={retired} onChange={setRetired} />{" "}
            {t("study.showRetired")}
          </label>
        </div>
        {visible.length === 0 ? (
          <p className="muted">{t("study.noRecords")}</p>
        ) : kind === "fact" ? (
          <Tabs
            type="card"
            size="small"
            tabBarGutter={4}
            activeKey={activeFact?.id}
            onChange={setSelectedFact}
            items={visible.map((record, index) => ({
              key: record.id,
              label: String(index + 1),
              children: recordCard(record),
            }))}
          />
        ) : (
          visible.map(recordCard)
        )}
      </section>
    );
  }
  const overview = (
    <>
      <p className="muted">{t("study.description")}</p>
      {canManage && (
        <p>
          <Link to={`/questionnaire?${new URLSearchParams(jobsQuery)}`}>
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
              {canManage && (
                <Link
                  className="study-draft-link"
                  to={`/questionnaire?${new URLSearchParams({
                    ...jobsQuery,
                    studySkill: pin.skillId,
                    studyHash: pin.hash,
                  })}`}
                >
                  {t("study.openDraft")}
                </Link>
              )}
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
    </>
  );
  return (
    <WorkflowPanel
      title={t("stage.sourceStudy")}
      className="source-study-panel"
      id="source-study"
      aria-labelledby="source-study-title"
    >
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onChanged} />
      )}
      <Tabs
        activeKey={section}
        onChange={setSection}
        items={[
          {
            key: "overview",
            label: t("stage.sourceStudy"),
            children: overview,
          },
          {
            key: "facts",
            label: t("study.facts"),
            children: records("fact", study.facts),
          },
          {
            key: "interfaces",
            label: t("study.interfaces"),
            children: records("interface", study.interfaces),
          },
          {
            key: "effects",
            label: t("effects.title"),
            children: effectPins.length ? (
              <Tabs
                type="card"
                size="small"
                tabBarGutter={4}
                items={effectPins.map((pin, index) => ({
                  key: pin.skillId,
                  label: (
                    <span
                      className="study-skill-tab-label"
                      title={pin.skillName}
                    >
                      {index + 1}. {pin.skillName}
                    </span>
                  ),
                  children: (
                    <ScriptEffectsPanel
                      key={pin.hash}
                      basePath={basePath}
                      skillId={pin.skillId}
                      hash={pin.hash}
                      workflowBase={base}
                      canManage={canManage}
                      onChanged={onChanged}
                    />
                  ),
                }))}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("effects.noScripts")}
              />
            ),
          },
        ]}
      />
      {editor !== null && (
        <StudyRecordDialog
          basePath={basePath}
          detail={detail}
          kind={editor.kind}
          previous={editor.previous}
          onCancel={() => setEditor(null)}
          onChanged={(record) => {
            if (record?.kind === "fact") setSelectedFact(record.id);
            onChanged();
          }}
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
    </WorkflowPanel>
  );
}
