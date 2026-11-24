import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { useCallback, useEffect, useId, useState } from "react";
import type {
  SkillScriptSideEffect,
  ScriptEffectEvidence,
} from "@realityjunky/badger";
import { questionnaireRequest } from "../../api/questionnaire.js";
import {
  effectsPath,
  unansweredScriptPaths,
  type EffectRevision,
  type ScriptEffectPanel,
  type ScriptEffectReviewRow,
} from "../../api/script-effects.js";
import { NumberedTabs } from "../../components/NumberedTabs.js";
import { SourceEvidenceDisclosure } from "../../components/SourceEvidenceDisclosure.js";
import { UncertaintyTabLabel } from "../../components/UncertaintyTabLabel.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface DraftEdits {
  revision: number;
  scripts: ScriptEffectReviewRow[];
  note: string;
}

export function ScriptEffectsPanel({
  basePath,
  skillId,
  hash,
}: {
  basePath: string;
  skillId: string;
  hash: string;
}) {
  const { t, format, locale } = useI18n();
  const fieldId = useId();
  const [panel, setPanel] = useState<ScriptEffectPanel | null>(null);
  const [draft, setDraft] = useState<DraftEdits>();
  const [savedRevision, setSavedRevision] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [correction, setCorrection] = useState(false);
  const [starting, setStarting] = useState(false);
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
  const review = panel?.review ?? null;
  const revision = review?.revision ?? 0;
  const confirmed = review?.kind === "confirmation";
  const findings = review && !confirmed ? (panel?.findings ?? []) : [];
  const reviewNote = review?.content.note;
  const canReview = panel?.canReview && panel.uploaderAvailable;
  const editable =
    canReview && (review !== null || starting) && (!confirmed || correction);
  const savedRows = new Map(
    review?.content.scripts.map((row) => [row.path, row]),
  );
  const rows =
    (editable ? draft?.scripts : undefined) ??
    panel?.scripts.map(
      (script): ScriptEffectReviewRow =>
        savedRows.get(script.path) ?? {
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
    ) ??
    [];
  const note = draft?.note ?? "";
  const unanswered = new Set(unansweredScriptPaths(review));

  const refreshReview = useCallback(
    async (signal?: AbortSignal) => {
      const value = await questionnaireRequest<ScriptEffectPanel>(
        basePath,
        path,
        "GET",
        undefined,
        signal,
      );
      if (!signal?.aborted)
        setPanel((current) =>
          (current?.review?.revision ?? 0) > (value.review?.revision ?? 0)
            ? current
            : value,
        );
    },
    [basePath, path],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refreshReview(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error ? error.message : t("effects.failed"),
        );
    });
    return () => controller.abort();
  }, [refreshReview, t]);

  async function perform(action: () => Promise<unknown>) {
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
    const result = await questionnaireRequest<{ review: EffectRevision }>(
      basePath,
      `${path}${action ? `/${action}` : ""}`,
      "POST",
      body,
    );
    const saved = result.review;
    setPanel((current) =>
      current && (current.review?.revision ?? 0) <= saved.revision
        ? { ...current, review: saved }
        : current,
    );
    setDraft(undefined);
    setSavedRevision(action === "" ? saved.revision : undefined);
    await refreshReview();
    return saved;
  }
  function saveDraft() {
    return change("", {
      revision: draft?.revision ?? revision,
      scripts: rows,
      note,
    });
  }
  function editDraft(update: (value: DraftEdits) => DraftEdits) {
    setDraft((current) =>
      update(current ?? { revision, scripts: rows, note: "" }),
    );
  }
  function update(index: number, value: Partial<ScriptEffectReviewRow>) {
    editDraft((current) => ({
      ...current,
      scripts: current.scripts.map((row, position) =>
        position === index ? { ...row, reviewed: false, ...value } : row,
      ),
    }));
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
  if (!panel)
    return failure ? <Alert type="error" title={failure} /> : <Spin />;
  if (!panel.scripts.length)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t("effects.noScripts")}
      />
    );

  const history =
    review && revision > (panel.history[0]?.revision ?? 0)
      ? [review, ...panel.history]
      : panel.history;
  const saveDraftAction = editable && (
    <Space wrap>
      <Button disabled={busy} onClick={() => void perform(saveDraft)}>
        {t("effects.save")}
      </Button>
      <span className="muted" role="status">
        {draft
          ? t("effects.unsaved")
          : savedRevision === revision
            ? t("effects.saved")
            : null}
      </span>
    </Space>
  );
  return (
    <section
      className="study-record effect-review-panel"
      aria-label={`${t("effects.title")} · ${panel.skillName}`}
    >
      <div className="workflow-card-heading effect-review-heading">
        <div>
          <h3>{t("effects.title")}</h3>
          <p className="muted">
            {t("effects.uploader")}:{" "}
            {panel.uploader?.displayName ?? panel.uploadedBy}
          </p>
        </div>
        <Space wrap>
          <Tag color={confirmed ? "success" : "default"}>
            {t(
              confirmed
                ? "effects.confirmed"
                : review
                  ? "effects.draftStatus"
                  : "effects.noDeclaration",
            )}
          </Tag>
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await refreshReview();
                setDraft(undefined);
                setSavedRevision(undefined);
              })
            }
          >
            {t("workflow.reload")}
          </Button>
        </Space>
      </div>
      <p className="muted">{t("effects.help")}</p>
      {review && panel.pendingReason && (
        <Alert type="warning" title={panel.pendingReason} />
      )}
      {panel.uploaderAvailable && !panel.canReview && (
        <p className="muted">{t("effects.uploaderOnly")}</p>
      )}
      {failure && <Alert type="error" showIcon title={failure} />}
      {canReview && !review && !starting && (
        <Button type="primary" onClick={() => setStarting(true)}>
          {t("effects.start")}
        </Button>
      )}
      {editable && (
        <div className="effect-review-actions">
          <label className="field">
            {t("effects.note")}
            <Input.TextArea
              aria-label={t("effects.note")}
              value={note}
              maxLength={8000}
              autoSize={{ minRows: 2, maxRows: 5 }}
              disabled={busy}
              onChange={(event) => {
                const note = event.target.value;
                editDraft((current) => ({ ...current, note }));
              }}
            />
          </label>
          <Space wrap>
            {review?.content.workflowVersionId && (
              <Button
                disabled={busy || !note.trim()}
                onClick={() =>
                  void perform(() =>
                    change("clarify", {
                      revision: draft?.revision ?? revision,
                      note,
                    }),
                  )
                }
              >
                {t("effects.clarify")}
              </Button>
            )}
            <Button
              type="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const saved = await saveDraft();
                  const result = await questionnaireRequest<{
                    preview: {
                      confirmationHash: string;
                      scripts: ScriptEffectReviewRow[];
                    };
                  }>(basePath, `${path}/preview`, "POST", {
                    revision: saved.revision,
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
        </div>
      )}
      {confirmed && canReview && !correction && (
        <Button disabled={busy} onClick={() => setCorrection(true)}>
          {t("effects.correct")}
        </Button>
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
      {(review || starting) && (
        <NumberedTabs
          label={t("effects.scripts")}
          items={rows.map((row, index) => ({
            key: row.path,
            label: (
              <UncertaintyTabLabel pending={unanswered.has(row.path)}>
                <span title={row.path}>
                  <span aria-hidden="true">{index + 1}</span>
                  <span className="sr-only">
                    {index + 1}. {row.path}
                  </span>
                </span>
              </UncertaintyTabLabel>
            ),
            children: (
              <article
                className="study-record effect-review-row"
                key={row.path}
                aria-label={row.path}
              >
                <h4>
                  <code>{row.path}</code>
                </h4>
                {editable ? (
                  <>
                    <label className="field">
                      {t("skills.effects")}
                      <Select
                        mode="multiple"
                        aria-label={`${t("skills.effects")} ${row.path}`}
                        value={row.effects}
                        disabled={busy}
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
                        disabled={busy}
                        autoSize={{ minRows: 1, maxRows: 5 }}
                        onChange={(event) =>
                          update(index, {
                            conditionalBehavior: event.target.value,
                          })
                        }
                        maxLength={8000}
                      />
                    </label>
                  </>
                ) : (
                  <dl className="effect-review-summary">
                    <dt>{t("skills.effects")}</dt>
                    <dd>
                      {row.effects.length
                        ? row.effects
                            .map((effect) => t(`skills.effect.${effect}`))
                            .join(", ")
                        : t("effects.pending")}
                    </dd>
                    {row.rationale && (
                      <>
                        <dt>{t("effects.rationale")}</dt>
                        <dd>{row.rationale}</dd>
                      </>
                    )}
                    {row.conditionalBehavior && (
                      <>
                        <dt>{t("effects.conditional")}</dt>
                        <dd>{row.conditionalBehavior}</dd>
                      </>
                    )}
                  </dl>
                )}
                {row.uncertainty && (
                  <>
                    <Alert type="warning" title={row.uncertainty} />
                    {editable ? (
                      <div className="effect-answer">
                        <label className="field">
                          {t("effects.answer")}
                          <Input.TextArea
                            aria-label={`${t("effects.answer")} ${row.path}`}
                            aria-describedby={`${fieldId}-${index}-save-help`}
                            value={row.uncertaintyAnswer}
                            disabled={busy}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            onChange={(event) =>
                              update(index, {
                                uncertaintyAnswer: event.target.value,
                              })
                            }
                            maxLength={8000}
                          />
                        </label>
                        <p
                          id={`${fieldId}-${index}-save-help`}
                          className="muted"
                        >
                          {t("effects.answerHelp")}
                        </p>
                        {saveDraftAction}
                      </div>
                    ) : (
                      <p className="questionnaire-text">
                        {row.uncertaintyAnswer || t("effects.unanswered")}
                      </p>
                    )}
                  </>
                )}
                {(row.evidence.length > 0 || editable) && (
                  <SourceEvidenceDisclosure>
                    <div className="effect-citations">
                      {row.evidence.map((evidence, citationIndex) => (
                        <div key={citationIndex}>
                          <Button
                            type="link"
                            disabled={busy}
                            onClick={() =>
                              void perform(() => openCitation(evidence))
                            }
                          >
                            {evidence.path}:{evidence.startLine}–
                            {evidence.endLine}
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
                                    evidence: row.evidence.map(
                                      (item, position) =>
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
                                    evidence: row.evidence.map(
                                      (item, position) =>
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
                                    evidence: row.evidence.map(
                                      (item, position) =>
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
                                      (_, position) =>
                                        position !== citationIndex,
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
                  </SourceEvidenceDisclosure>
                )}
                {!row.uncertainty && saveDraftAction}
              </article>
            ),
          }))}
        />
      )}
      {(findings.length > 0 || reviewNote) && (
        <div className="effect-review-context">
          {findings.map((finding) => (
            <p role="status" key={finding.code}>
              {finding.message}
            </p>
          ))}
          {reviewNote && <p className="questionnaire-text">{reviewNote}</p>}
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary>{t("effects.history")}</summary>
          {history.map((entry) => (
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
      )}
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
