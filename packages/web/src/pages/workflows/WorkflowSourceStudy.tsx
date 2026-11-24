import {
  Alert,
  Button,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
} from "antd";
import { useEffect, useState, type ReactNode } from "react";
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
import { workingDossierPath } from "../../api/working-dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { StudyRecordDialog } from "./StudyRecordDialog.js";
import {
  StudyContentView,
  StudyEvidenceLinks,
  StudyRecordInspector,
} from "./StudyRecordDetails.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";
import { EvidenceChanges } from "../../components/EvidenceChanges.js";
import { NumberedTabs } from "../../components/NumberedTabs.js";
import { RecordOriginLink } from "../../components/RecordOriginLink.js";
import { WorkflowPanel } from "./WorkflowPanel.js";
import { selectedWorkflowTab } from "./WorkflowTabs.js";
import { useWorkingDossier } from "../working-dossier/useWorkingDossier.js";
import { WorkingDossierStudy } from "../working-dossier/WorkingDossierStudy.js";

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
  const [section, setSection] = useState<string>();
  const [factSelection, setFactSelection] = useState<{
    group?: string;
    recordId?: string;
  }>({});
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
  const dossierPath = workingDossierPath(detail.workflow.id, detail.version.id);
  const {
    dossier,
    failure: dossierFailure,
    reload,
  } = useWorkingDossier(
    basePath,
    dossierPath,
    detail.version.id,
    selectedWorkflowTab({ hash, search }) === "source-study",
  );
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
    if (linkedKind === "fact" && linkedId !== null) {
      setFactSelection((selection) => ({ ...selection, recordId: linkedId }));
    }
    if (linkedStatus === "retired") setRetired(true);
  }, [linkedId, linkedKind, linkedStatus]);

  const canManage = detail.capabilities.manageSourceStudy;
  const legacy = dossier?.legacy === true;
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
  function closeReview() {
    if (!busy) setReview(null);
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
  function factTabs(
    entries: StudyRecord[],
    recordCard: (record: StudyRecord) => ReactNode,
  ) {
    const groups = study.studies.map((pin) => ({
      key: pin.skillId,
      name: pin.skillName,
      records: entries.filter((record) =>
        record.content.evidence.some(({ skillId }) => skillId === pin.skillId),
      ),
    }));
    const pinnedIds = new Set(groups.map(({ key }) => key));
    const unpinned = entries.filter((record) =>
      record.content.evidence.every(({ skillId }) => !pinnedIds.has(skillId)),
    );
    if (unpinned.length > 0) {
      groups.push({
        key: "unpinned",
        name: t("study.unpinned"),
        records: unpinned,
      });
    }

    const noRecords = <p className="muted">{t("study.noRecords")}</p>;
    const matchesSelection = (record: StudyRecord) =>
      record.id === factSelection.recordId;
    const preferredGroup = groups.find(
      ({ key }) => key === factSelection.group,
    );
    const activeGroup =
      (preferredGroup?.records.some(matchesSelection)
        ? preferredGroup
        : groups.find(({ records }) => records.some(matchesSelection))) ??
      preferredGroup ??
      groups.find(({ records }) => records.length > 0) ??
      groups[0];
    if (activeGroup === undefined) return noRecords;

    const activeFact =
      activeGroup.records.find(matchesSelection) ?? activeGroup.records[0];
    const activeContent =
      activeFact === undefined ? (
        noRecords
      ) : (
        <NumberedTabs
          label={t("study.facts")}
          activeKey={activeFact.id}
          onChange={(recordId) =>
            setFactSelection({ group: activeGroup.key, recordId })
          }
          items={activeGroup.records.map((record) => ({
            key: record.id,
            children: recordCard(record),
          }))}
        />
      );
    return (
      <NumberedTabs
        label={t("study.factSkills")}
        activeKey={activeGroup.key}
        onChange={(group) => setFactSelection({ group })}
        items={groups.map(({ key, name }, index) => ({
          key,
          label: (
            <span className="study-skill-tab-label" title={name}>
              {index + 1}. {name}
            </span>
          ),
          children: key === activeGroup.key ? activeContent : null,
        }))}
      />
    );
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
        {kind === "fact" ? (
          factTabs(visible, recordCard)
        ) : visible.length === 0 ? (
          <p className="muted">{t("study.noRecords")}</p>
        ) : (
          visible.map(recordCard)
        )}
      </section>
    );
  }
  const legacyOverview = (
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
      hideHeading
      className="source-study-panel"
      id="source-study"
      aria-labelledby="source-study-title"
    >
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onChanged} />
      )}
      {dossierFailure && (
        <Alert
          type="error"
          showIcon
          title={dossierFailure}
          action={
            <Button onClick={() => void reload()}>
              {t("workflow.reload")}
            </Button>
          }
        />
      )}
      {legacy ? (
        <Tabs
          activeKey={section ?? "overview"}
          onChange={setSection}
          items={[
            {
              key: "overview",
              label: t("stage.sourceStudy"),
              children: legacyOverview,
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
          ]}
        />
      ) : (
        <>
          {dossier && !dossier.available && (
            <Alert type="info" title={t("workingDossier.waitForCheck")} />
          )}
          {dossier && (dossier.available || dossier.revision > 0) && (
            <WorkingDossierStudy
              dossier={dossier}
              context={{
                basePath,
                path: dossierPath,
                revision: dossier.revision,
                pins: dossier.pins,
              }}
            />
          )}
          {!dossier && !dossierFailure && (
            <Spin aria-label={t("common.loading")} />
          )}
        </>
      )}
      {legacy && editor !== null && (
        <StudyRecordDialog
          basePath={basePath}
          detail={detail}
          kind={editor.kind}
          previous={editor.previous}
          onCancel={() => setEditor(null)}
          onChanged={(record) => {
            if (record?.kind === "fact") {
              setFactSelection((selection) => ({
                ...selection,
                recordId: record.id,
              }));
            }
            onChanged();
          }}
        />
      )}
      <StudyRecordInspector basePath={basePath} detail={detail} />
      <Modal
        open={review !== null}
        width={720}
        title={t("study.review")}
        footer={null}
        onCancel={closeReview}
        maskClosable={false}
        closable={!busy}
      >
        <Space wrap>
          <Button disabled={busy} onClick={closeReview}>
            {t("workflow.cancel")}
          </Button>
          <Button type="primary" loading={busy} onClick={() => void confirm()}>
            {t("study.confirm")}
          </Button>
        </Space>
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
