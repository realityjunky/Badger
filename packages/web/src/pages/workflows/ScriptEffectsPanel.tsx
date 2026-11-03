import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  SkillScriptSideEffect,
  ScriptEffectEvidence,
} from "@realityjunky/badger";
import { questionnaireRequest } from "../../api/questionnaire.js";
import {
  effectsPath,
  type ScriptEffectPanel,
  type ScriptEffectReviewRow,
} from "../../api/script-effects.js";
import type { DraftingJob } from "../../api/drafting-jobs.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function ScriptEffectsPanel({
  basePath,
  skillId,
  hash,
  workflowBase,
  canManage = false,
  onChanged,
}: {
  basePath: string;
  skillId: string;
  hash: string;
  workflowBase?: string;
  canManage?: boolean;
  onChanged?(): void;
}) {
  const { t, format, locale } = useI18n();
  const [panel, setPanel] = useState<ScriptEffectPanel | null>(null);
  const [rows, setRows] = useState<ScriptEffectReviewRow[]>([]);
  const [jobs, setJobs] = useState<DraftingJob[]>([]);
  const [jobId, setJobId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState(false);
  const [preview, setPreview] = useState<{
    confirmationHash: string;
    scripts: ScriptEffectReviewRow[];
    requestId: string;
  } | null>(null);
  const [citation, setCitation] = useState<{
    evidence: ScriptEffectEvidence;
    text: string;
  } | null>(null);
  const path = effectsPath(skillId, hash);
  const refresh = useCallback(async () => {
    const value = await questionnaireRequest<ScriptEffectPanel>(basePath, path);
    setPanel(value);
    setRows(
      value.scripts.map(
        (script) =>
          value.review?.content.scripts.find(
            (row) => row.path === script.path,
          ) ?? {
            skillId,
            hash,
            path: script.path,
            effects: [],
            rationale: "",
            evidence: [],
            conditionalBehavior: "",
            uncertainty: null,
            reviewed: false,
            uncertaintyAnswer: "",
          },
      ),
    );
    if (canManage && workflowBase) {
      const result = await questionnaireRequest<{ jobs: DraftingJob[] }>(
        basePath,
        `${workflowBase}/drafting-jobs`,
      );
      const available = result.jobs.filter(
        (job) =>
          job.kind === "source-study" &&
          job.skillId === skillId &&
          ["submitted", "accepted"].includes(job.status),
      );
      setJobs(available);
      setJobId(available.at(-1)?.id);
    }
  }, [basePath, path, skillId, hash, workflowBase, canManage]);

  useEffect(() => {
    let active = true;
    void refresh().catch((error: unknown) => {
      if (active)
        setFailure(
          error instanceof Error ? error.message : t("effects.failed"),
        );
    });
    return () => {
      active = false;
    };
  }, [refresh, t]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("effects.failed"));
    } finally {
      setBusy(false);
    }
  }
  async function change(action: string, body: unknown) {
    await questionnaireRequest(
      basePath,
      `${path}${action ? `/${action}` : ""}`,
      "POST",
      body,
    );
    await refresh();
    onChanged?.();
  }
  function update(index: number, value: Partial<ScriptEffectReviewRow>) {
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, reviewed: false, ...value } : row,
      ),
    );
  }
  async function openCitation(evidence: ScriptEffectEvidence) {
    const query = new URLSearchParams({
      path: evidence.path,
      fileHash: evidence.fileHash,
      startLine: String(evidence.startLine),
      endLine: String(evidence.endLine),
    });
    const result = await questionnaireRequest<{
      evidence: ScriptEffectEvidence;
      lines: { number: number; text: string }[];
    }>(basePath, `${path}/evidence?${query}`);
    setCitation({
      evidence: result.evidence,
      text: result.lines
        .map((line) => `${line.number}  ${line.text}`)
        .join("\n"),
    });
  }
  const confirmed = panel?.review?.kind === "confirmation";
  const editable =
    panel?.canReview && panel.review !== null && (!confirmed || correction);

  if (!panel)
    return failure ? <Alert type="error" title={failure} /> : <Spin />;
  if (!panel.scripts.length) return null;
  return (
    <section
      className="study-record effect-review-panel"
      aria-label={`${t("effects.title")} · ${panel.skillName}`}
    >
      <div className="workflow-card-heading">
        <h3>
          {t("effects.title")} · {panel.skillName}
        </h3>
        <Space wrap>
          <Tag color={confirmed ? "success" : "warning"}>
            {t(confirmed ? "effects.confirmed" : "effects.pending")}
          </Tag>
          <Button disabled={busy} onClick={() => void perform(refresh)}>
            {t("workflow.reload")}
          </Button>
        </Space>
      </div>
      <p className="muted">{t("effects.help")}</p>
      <p>
        {t("effects.uploader")}:{" "}
        {panel.uploader?.displayName ?? panel.uploadedBy}
      </p>
      <code className="study-hash">{hash}</code>
      <p>
        <Link
          to={`/source-reviews/${encodeURIComponent(skillId)}/${encodeURIComponent(hash)}#source-study`}
        >
          {t("effects.directLink")}
        </Link>
      </p>
      {panel.pendingReason && (
        <Alert type="warning" title={panel.pendingReason} />
      )}
      {failure && <Alert type="error" showIcon title={failure} />}
      {!confirmed &&
        panel.findings.map((finding) => (
          <p role="status" key={finding.code}>
            {finding.message}
          </p>
        ))}
      {panel.review?.content.note && (
        <p className="questionnaire-text">{panel.review.content.note}</p>
      )}
      <details>
        <summary>{t("effects.definitions")}</summary>
        <dl>
          {panel.contract.labels.map((label) => (
            <div key={label.value}>
              <dt>{t(`skills.effect.${label.value}`)}</dt>
              <dd>{label.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
      {canManage && workflowBase && !confirmed && (
        <div className="effect-review-actions">
          <label className="field">
            {t("effects.agentDraft")}
            <Select
              value={jobId}
              onChange={setJobId}
              disabled={busy}
              aria-label={t("effects.agentDraft")}
              options={jobs.map((job) => ({
                value: job.id,
                label: `${job.id} · ${job.status}`,
              }))}
            />
          </label>
          <Space wrap>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await questionnaireRequest(
                    basePath,
                    `${workflowBase}/drafting-jobs`,
                    "POST",
                    { kind: "source-study", skillId, confirmed: true },
                  );
                  await refresh();
                  onChanged?.();
                })
              }
            >
              {t("effects.requestDraft")}
            </Button>
            <Button
              disabled={busy || !jobId}
              onClick={() =>
                void perform(async () => {
                  const job = jobs.find((entry) => entry.id === jobId)!;
                  await change("route", {
                    workflowVersionId: workflowBase.split("/").at(-1),
                    jobId,
                    jobRevision: job.revision,
                    revision: panel.review?.revision ?? 0,
                  });
                })
              }
            >
              {t("effects.route")}
            </Button>
          </Space>
          <p className="muted">{t("effects.routingHelp")}</p>
        </div>
      )}
      {rows.map((row, index) => (
        <article
          className="study-record effect-review-row"
          key={row.path}
          aria-label={row.path}
        >
          <h4>
            <code>{row.path}</code>
          </h4>
          <label className="field">
            {t("skills.effects")}
            <Select
              mode="multiple"
              aria-label={`${t("skills.effects")} ${row.path}`}
              value={row.effects}
              disabled={!editable || busy}
              placeholder={t("effects.pending")}
              options={panel.contract.labels.map((label) => ({
                value: label.value,
                label: t(`skills.effect.${label.value}`),
              }))}
              onChange={(effects: SkillScriptSideEffect[]) =>
                update(index, {
                  effects:
                    effects.at(-1) === "none"
                      ? ["none"]
                      : effects.filter((effect) => effect !== "none"),
                })
              }
            />
          </label>
          <label className="field">
            {t("effects.rationale")}
            <Input.TextArea
              aria-label={`${t("effects.rationale")} ${row.path}`}
              value={row.rationale}
              readOnly={!editable}
              disabled={busy}
              autoSize={{ minRows: 2, maxRows: 8 }}
              onChange={(event) =>
                update(index, { rationale: event.target.value })
              }
              maxLength={8000}
            />
          </label>
          <label className="field">
            {t("effects.conditional")}
            <Input.TextArea
              aria-label={`${t("effects.conditional")} ${row.path}`}
              value={row.conditionalBehavior}
              readOnly={!editable}
              disabled={busy}
              autoSize={{ minRows: 1, maxRows: 5 }}
              onChange={(event) =>
                update(index, { conditionalBehavior: event.target.value })
              }
              maxLength={8000}
            />
          </label>
          {row.uncertainty && (
            <>
              <Alert type="warning" title={row.uncertainty} />
              <label className="field">
                {t("effects.answer")}
                <Input.TextArea
                  aria-label={`${t("effects.answer")} ${row.path}`}
                  value={row.uncertaintyAnswer}
                  readOnly={!editable}
                  disabled={busy}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onChange={(event) =>
                    update(index, { uncertaintyAnswer: event.target.value })
                  }
                  maxLength={8000}
                />
              </label>
            </>
          )}
          <div className="effect-citations">
            {row.evidence.map((evidence, citationIndex) => (
              <div key={citationIndex}>
                <Button
                  type="link"
                  disabled={busy}
                  onClick={() => void perform(() => openCitation(evidence))}
                >
                  {evidence.path}:{evidence.startLine}–{evidence.endLine}
                </Button>
                {editable && (
                  <Space wrap>
                    <Select
                      aria-label={`${t("effects.sourcePath")} ${row.path} ${citationIndex + 1}`}
                      value={evidence.path}
                      disabled={busy}
                      options={panel.inventory.map((file) => ({
                        value: file.path,
                        label: file.path,
                      }))}
                      onChange={(value: string) =>
                        update(index, {
                          evidence: row.evidence.map((item, position) =>
                            position === citationIndex
                              ? {
                                  ...item,
                                  path: value,
                                  fileHash: panel.inventory.find(
                                    (file) => file.path === value,
                                  )!.hash,
                                  startLine: 1,
                                  endLine: 1,
                                }
                              : item,
                          ),
                        })
                      }
                    />
                    <InputNumber
                      aria-label={`${t("study.startLine")} ${row.path} ${citationIndex + 1}`}
                      min={1}
                      value={evidence.startLine}
                      disabled={busy}
                      onChange={(value) =>
                        update(index, {
                          evidence: row.evidence.map((item, position) =>
                            position === citationIndex
                              ? { ...item, startLine: value ?? 1 }
                              : item,
                          ),
                        })
                      }
                    />
                    <InputNumber
                      aria-label={`${t("study.endLine")} ${row.path} ${citationIndex + 1}`}
                      min={1}
                      value={evidence.endLine}
                      disabled={busy}
                      onChange={(value) =>
                        update(index, {
                          evidence: row.evidence.map((item, position) =>
                            position === citationIndex
                              ? { ...item, endLine: value ?? 1 }
                              : item,
                          ),
                        })
                      }
                    />
                    <Button
                      disabled={busy}
                      onClick={() =>
                        update(index, {
                          evidence: row.evidence.filter(
                            (_, position) => position !== citationIndex,
                          ),
                        })
                      }
                    >
                      {t("effects.removeCitation")}
                    </Button>
                  </Space>
                )}
              </div>
            ))}
            {editable && (
              <Button
                disabled={busy}
                onClick={() =>
                  update(index, {
                    evidence: [
                      ...row.evidence,
                      {
                        skillId,
                        hash,
                        path: row.path,
                        fileHash: panel.inventory.find(
                          (file) => file.path === row.path,
                        )!.hash,
                        startLine: 1,
                        endLine: 1,
                      },
                    ],
                  })
                }
              >
                {t("effects.addCitation")}
              </Button>
            )}
          </div>
          <Checkbox
            checked={row.reviewed}
            disabled={!editable || busy}
            onChange={(event) =>
              update(index, { reviewed: event.target.checked })
            }
          >
            {t("effects.rowReviewed")}
          </Checkbox>
        </article>
      ))}
      {editable && (
        <>
          <label className="field">
            {t("effects.note")}
            <Input.TextArea
              aria-label={t("effects.note")}
              value={note}
              maxLength={8000}
              autoSize={{ minRows: 2, maxRows: 5 }}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <Space wrap>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  change("", {
                    revision: panel.review!.revision,
                    scripts: rows,
                    note,
                  }),
                )
              }
            >
              {t("effects.save")}
            </Button>
            <Button
              disabled={busy || !note.trim()}
              onClick={() =>
                void perform(() =>
                  change("clarify", { revision: panel.review!.revision, note }),
                )
              }
            >
              {t("effects.clarify")}
            </Button>
            <Button
              type="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const saved = await questionnaireRequest<{
                    review: NonNullable<ScriptEffectPanel["review"]>;
                  }>(basePath, path, "POST", {
                    revision: panel.review!.revision,
                    scripts: rows,
                    note,
                  });
                  await refresh();
                  onChanged?.();
                  const result = await questionnaireRequest<{
                    preview: {
                      confirmationHash: string;
                      scripts: ScriptEffectReviewRow[];
                    };
                  }>(basePath, `${path}/preview`, "POST", {
                    revision: saved.review.revision,
                  });
                  setPreview({
                    ...result.preview,
                    requestId: crypto.randomUUID(),
                  });
                })
              }
            >
              {t("effects.preview")}
            </Button>
          </Space>
        </>
      )}
      {confirmed && panel.canReview && !correction && (
        <Button disabled={busy} onClick={() => setCorrection(true)}>
          {t("effects.correct")}
        </Button>
      )}
      <details>
        <summary>{t("effects.history")}</summary>
        {panel.history.map((entry) => (
          <article className="study-record" key={entry.revision}>
            <p>
              {format("study.revision", { revision: entry.revision })} ·{" "}
              {entry.kind} · {entry.actorId} ·{" "}
              {new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(entry.recordedAt))}
            </p>
            <code className="study-hash">{entry.hash}</code>
            <p>{entry.content.note}</p>
            {entry.content.scripts.map((row) => (
              <div key={row.path}>
                <code>{row.path}</code>
                <p>
                  {row.effects.join(", ") || t("effects.pending")} ·{" "}
                  {row.rationale}
                </p>
                {row.uncertainty && (
                  <p>
                    {row.uncertainty} {row.uncertaintyAnswer}
                  </p>
                )}
              </div>
            ))}
          </article>
        ))}
      </details>
      <Modal
        open={preview !== null}
        title={t("effects.preview")}
        width={760}
        maskClosable={false}
        okText={t("effects.confirm")}
        cancelText={t("workflow.cancel")}
        confirmLoading={busy}
        onCancel={() => setPreview(null)}
        onOk={() =>
          void perform(async () => {
            if (!preview) return;
            await change("confirm", {
              confirmationHash: preview.confirmationHash,
              requestId: preview.requestId,
            });
            setCorrection(false);
            setPreview(null);
          })
        }
      >
        <p>{t("effects.personalConfirmation")}</p>
        <p>
          {panel.skillName} · {panel.uploader?.displayName}
        </p>
        <code className="study-hash">{hash}</code>
        {preview?.scripts.map((row) => (
          <article className="study-record" key={row.path}>
            <code>{row.path}</code>
            <p>{row.effects.join(", ")}</p>
            <p>{row.rationale}</p>
            <p>{row.conditionalBehavior}</p>
            {row.uncertainty && (
              <p>
                {row.uncertainty} {row.uncertaintyAnswer}
              </p>
            )}
            {row.evidence.map((evidence, index) => (
              <p key={index}>
                {evidence.path}:{evidence.startLine}–{evidence.endLine}{" "}
                <code className="study-hash">{evidence.fileHash}</code>
              </p>
            ))}
          </article>
        ))}
        <code className="study-hash">{preview?.confirmationHash}</code>
      </Modal>
      <Modal
        open={citation !== null}
        footer={null}
        title={t("effects.citedLines")}
        onCancel={() => setCitation(null)}
      >
        <code className="study-hash">{citation?.evidence.fileHash}</code>
        <pre className="source-preview">{citation?.text}</pre>
      </Modal>
    </section>
  );
}
