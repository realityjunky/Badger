import { Alert, Descriptions, Drawer, Spin, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  loadEvidence,
  loadRecord,
  studyPath,
  type EvidencePreview,
  type SourceFact,
  type SkillInterface,
  type StudyRecord,
  type StudyRevision,
} from "../../api/source-study.js";
import type { WorkflowVersionDetail } from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function StudyContentView({
  content,
  detail,
}: {
  content: SourceFact | SkillInterface;
  detail: WorkflowVersionDetail;
}) {
  const { t } = useI18n();
  if ("statement" in content) return <p>{content.statement}</p>;
  const name = (skillId: string) =>
    detail.pins.find((pin) => pin.skillId === skillId)?.skillName ?? skillId;
  return (
    <Descriptions
      size="small"
      column={1}
      items={[
        {
          key: "producer",
          label: t("study.producer"),
          children: `${name(content.producer.skillId)} · ${content.producer.hash.slice(0, 12)}`,
        },
        {
          key: "consumer",
          label: t("study.consumer"),
          children: `${name(content.consumer.skillId)} · ${content.consumer.hash.slice(0, 12)}`,
        },
        {
          key: "artifact",
          label: t("study.artifact"),
          children: content.artifact,
        },
        {
          key: "columns",
          label: t("study.columns"),
          children: content.columns.join(", ") || "—",
        },
        { key: "naming", label: t("study.naming"), children: content.naming },
        {
          key: "validation",
          label: t("study.validation"),
          children: content.validation,
        },
      ]}
    />
  );
}
export function StudyEvidenceLinks({
  record,
  content = record.content,
  revision = record.revision,
}: {
  record: StudyRecord;
  content?: SourceFact | SkillInterface;
  revision?: number;
}) {
  return (
    <ul className="study-evidence-links">
      {content.evidence.map((citation, index) => (
        <li key={index}>
          <Link
            to={{
              search: `?${new URLSearchParams({ studyRecord: record.id, studyRevision: String(revision), studyEvidence: String(index) })}`,
              hash: "#source-study",
            }}
          >
            {citation.path}:{citation.startLine}–{citation.endLine}
          </Link>
        </li>
      ))}
    </ul>
  );
}
export function StudyRecordInspector({
  basePath,
  detail,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
}) {
  const { t, format, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const id = params.get("studyRecord");
  const revision = params.get("studyRevision");
  const index = params.get("studyEvidence");
  const record = [
    ...detail.sourceStudy.facts,
    ...detail.sourceStudy.interfaces,
  ].find((r) => r.id === id);
  const [history, setHistory] = useState<StudyRevision[] | null>(null);
  const [preview, setPreview] = useState<EvidencePreview | null>(null);
  const [failed, setFailed] = useState(false);
  const base = studyPath(detail.workflow.id, detail.version.id);
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setPreview(null);
    setFailed(false);
    if (record !== undefined) {
      void loadRecord(basePath, base, record, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) {
            if (result.kind === "ok") setHistory(result.value.revisions);
            else setFailed(true);
          }
        },
      );
      if (index !== null && revision !== null)
        void loadEvidence(
          basePath,
          base,
          record,
          Number(revision),
          Number(index),
          controller.signal,
        ).then((result) => {
          if (!controller.signal.aborted) {
            if (result.kind === "ok") setPreview(result.value);
            else setFailed(true);
          }
        });
    }
    return () => controller.abort();
  }, [basePath, base, record?.id, record?.revision, revision, index]);
  function close() {
    const next = new URLSearchParams(params);
    for (const key of ["studyRecord", "studyRevision", "studyEvidence"])
      next.delete(key);
    setParams(next);
  }
  if (id === null) return null;
  return (
    <Drawer
      open={id !== null}
      width={760}
      title={t("study.history")}
      onClose={close}
    >
      {failed || record === undefined ? (
        <Alert type="error" title={t("study.loadFailed")} />
      ) : (
        <>
          {index !== null && (
            <section aria-label={t("study.citedLines")}>
              {preview === null ? (
                <Spin aria-label={t("common.loading")} />
              ) : (
                <>
                  <h3>
                    {preview.evidence.path}:{preview.evidence.startLine}–
                    {preview.evidence.endLine}
                  </h3>
                  <p className="study-hash">
                    {t("workflow.version")}:{" "}
                    <code>{preview.evidence.hash}</code>
                  </p>
                  <p className="study-hash">
                    {t("skills.hash")}: <code>{preview.evidence.fileHash}</code>
                  </p>
                  <ol
                    start={preview.evidence.startLine}
                    className="study-lines"
                  >
                    {preview.lines.map((line) => (
                      <li key={line.number} id={`study-line-${line.number}`}>
                        <code>{line.text || " "}</code>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          )}
          {history === null ? (
            <Spin aria-label={t("common.loading")} />
          ) : (
            history.map((entry) => (
              <section className="study-history-entry" key={entry.revision}>
                <h3>
                  {format("study.revision", { revision: entry.revision })}{" "}
                  <Tag>
                    {t(
                      entry.status === "retired"
                        ? "study.retired"
                        : "study.active",
                    )}
                  </Tag>
                </h3>
                <p className="muted">
                  {entry.actorId} ·{" "}
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(entry.recordedAt))}
                </p>
                <StudyContentView content={entry.content} detail={detail} />
                <StudyEvidenceLinks
                  record={record}
                  content={entry.content}
                  revision={entry.revision}
                />
              </section>
            ))
          )}
        </>
      )}
    </Drawer>
  );
}
