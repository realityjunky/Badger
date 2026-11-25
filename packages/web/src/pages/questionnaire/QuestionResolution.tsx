import { Alert, Button, Input, Modal, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  questionnaireRequest,
  skillVersionCaption,
  skillVersionHref,
  type Question,
  type QuestionnaireView,
  type Answer,
  type AnswerRevision,
  type AnswerType,
  type SkillQuestionnaireOption,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { AttachmentLinks } from "./AnswerAttachments.js";
import { AnswerContent } from "./AnswerContent.js";
import { EvidenceChanges } from "../../components/EvidenceChanges.js";
import { RecordOriginLink } from "../../components/RecordOriginLink.js";
import { TextImportButton } from "../../components/TextImportButton.js";

type Kind = "confirmed" | "followed-up" | "deferred" | "withdrawn";
const factTextLimit = 20_000;

function answerKey({
  personId,
  revision,
}: Pick<Answer, "personId" | "revision">) {
  return JSON.stringify([personId, revision]);
}

interface FactDraft {
  text: string;
  answerKeys: string[];
}
interface Review {
  path: string;
  input: Record<string, unknown>;
  preview: {
    confirmationHash: string;
    locale: string;
    answerType?: AnswerType;
    resolutionRevision?: number;
    successorVersionHash?: string;
    facts?: { text: string }[];
    answers: ({
      personId: string;
      revision: number;
    } & Partial<AnswerRevision>)[];
    evidence?: {
      path: string;
      startLine: number;
      endLine: number;
      fileHash: string;
    }[];
    drafts?: { id: string; revision: number; statement: string }[];
  };
  requestId: string;
  facts: string[];
}

/** A person reviews exactly what will be recorded before signing off. */
export function QuestionResolution({
  question,
  view,
  path,
  basePath,
  reload,
  skillVersions = [],
}: {
  question: Question;
  view: QuestionnaireView;
  path: string;
  basePath: string;
  reload: () => Promise<unknown>;
  skillVersions?: SkillQuestionnaireOption[];
}) {
  const { t, format, locale } = useI18n();
  const [parameters] = useSearchParams();
  const linkedRevision = Number(parameters.get("resolutionRevision"));
  const skillView = "subject" in view ? view : null;
  const workflowView = "workflow" in view ? view : null;
  const [kind, setKind] = useState<Kind>("confirmed");
  const [skillOutcome, setSkillOutcome] = useState<"clarification" | "change">(
    "clarification",
  );
  const [successor, setSuccessor] = useState<string>();
  const [refreshedVersions, setRefreshedVersions] =
    useState<SkillQuestionnaireOption[]>();
  const [reason, setReason] = useState("");
  const [deferredKind, setDeferredKind] = useState("out-of-scope");
  const [skillId, setSkillId] = useState<string>();
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const submitted = view.answers.filter(
    (answer) =>
      answer.questionId === question.id &&
      answer.state === "submitted" &&
      answer.eligibleForResolution,
  );
  const submittedByKey = new Map(
    submitted.map((answer) => [answerKey(answer), answer]),
  );
  const answerOptions = submitted.map((answer) => ({
    value: answerKey(answer),
    label: `${answer.personName} · ${format("questionnaire.answerRevision", { number: answer.revision })}`,
  }));
  const importableAnswers = answerOptions
    .filter(({ value }) => submittedByKey.get(value)!.text.trim())
    .map(({ value: key, label }) => ({ key, label }));
  const [drafts, setDrafts] = useState<FactDraft[]>([
    { text: "", answerKeys: [...submittedByKey.keys()] },
  ]);
  const submittedKeys = JSON.stringify([...submittedByKey.keys()]);
  useEffect(() => {
    const eligible = JSON.parse(submittedKeys) as string[];
    setDrafts((current) =>
      current.map((draft) => {
        if (!draft.text && !draft.answerKeys.length)
          return { ...draft, answerKeys: eligible };
        if (draft.answerKeys.every((key) => eligible.includes(key)))
          return draft;
        return { ...draft, answerKeys: [] };
      }),
    );
  }, [submittedKeys]);
  const facts = view.facts.filter((f) => f.questionId === question.id);
  const resolutions = view.resolutions.filter(
    (r) => r.questionId === question.id,
  );
  const successorVersions = (refreshedVersions ?? skillVersions).filter(
    (version) =>
      version.skillId === skillView?.skill.id &&
      version.baseHashes.includes(skillView.subject.versionHash),
  );
  const successorOptions = successorVersions.map((version) => ({
    value: version.versionHash,
    label: `${skillVersionCaption(version.versionHash, version.label)} · ${new Date(version.createdAt).toLocaleDateString(locale)}${version.retiredAt ? ` · ${t("skills.retired")}` : ""}`,
  }));
  const selectedSuccessor = successorVersions.find(
    (version) => version.versionHash === successor,
  );
  const pendingChange =
    question.state === "confirmed"
      ? resolutions.find(
          (resolution) =>
            resolution.revision === question.resolutionRevision &&
            resolution.skillOutcome?.kind === "change" &&
            !resolution.skillOutcome.successorVersionHash,
        )
      : undefined;
  const reviewedSkillOutcome = review?.input.skillOutcome as
    | { kind: "clarification" | "change"; successorVersionHash?: string }
    | undefined;
  const reviewedSuccessorHash =
    review?.preview.successorVersionHash ??
    reviewedSkillOutcome?.successorVersionHash;
  const canResolve =
    view.capabilities.resolve &&
    ["answered", "needs-reconfirmation"].includes(question.state);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const refreshSuccessors = async () => {
    const catalog = await questionnaireRequest<{
      skillVersions: SkillQuestionnaireOption[];
    }>(basePath, "/questionnaire");
    setRefreshedVersions(catalog.skillVersions);
  };
  const preview = async (
    route: string,
    input: Record<string, unknown>,
    texts: string[],
  ) => {
    const result = await questionnaireRequest<{ preview: Review["preview"] }>(
      basePath,
      `${route}-preview`,
      "POST",
      input,
    );
    setReview({
      path: route,
      input,
      preview: result.preview,
      requestId: crypto.randomUUID(),
      facts: texts.length
        ? texts
        : (result.preview.facts ?? []).map(({ text }) => text),
    });
  };
  const resolve = async () => {
    const input: Record<string, unknown> = {
      revision: question.revision,
      kind,
    };
    if (reason.trim()) input.reason = reason;
    if (kind === "confirmed") {
      input.facts = drafts.map((d) => ({
        text: d.text,
        answers: d.answerKeys.map((key) => {
          const { personId, revision } = submittedByKey.get(key)!;
          return { personId, revision };
        }),
      }));
      if (skillView)
        input.skillOutcome =
          skillOutcome === "clarification"
            ? { kind: skillOutcome }
            : { kind: skillOutcome, successorVersionHash: successor };
    }
    if (kind === "deferred")
      Object.assign(input, {
        reason,
        deferredKind,
        ...(deferredKind === "skill-internal" ? { skillId } : {}),
      });
    if (kind === "followed-up")
      input.followUp = {
        text: followUp,
        topic: question.topic,
        targets: question.targets,
        rationale: reason || question.rationale,
        evidence: question.evidence,
        assignees: question.assignees,
        priority: question.priority,
      };
    await preview(
      `${path}/questions/${encodeURIComponent(question.id)}/resolution`,
      input,
      kind === "confirmed"
        ? drafts.map((d) => d.text)
        : [kind === "followed-up" ? followUp : reason],
    );
  };
  const ready =
    kind === "confirmed"
      ? drafts.every(
          (draft) =>
            draft.text.trim() &&
            draft.text.length <= factTextLimit &&
            draft.answerKeys.length &&
            draft.answerKeys.every((key) => submittedByKey.has(key)),
        ) &&
        (!skillView ||
          skillOutcome === "clarification" ||
          !successor ||
          selectedSuccessor !== undefined)
      : kind === "followed-up"
        ? followUp.trim()
        : kind === "deferred"
          ? reason.trim() && (deferredKind !== "skill-internal" || skillId)
          : true;
  return (
    <section
      className="questionnaire-record"
      aria-label={t("resolution.title")}
    >
      <h3>{t("resolution.title")}</h3>
      {question.parentQuestionId && (
        <p>
          <Link
            to={`/questionnaire/questions/${encodeURIComponent(question.parentQuestionId)}`}
          >
            {t("resolution.parent")}
          </Link>
        </p>
      )}
      {failure && <Alert type="error" showIcon message={failure} />}
      {question.state === "needs-reconfirmation" && (
        <Alert
          type="warning"
          showIcon
          message={t("resolution.needsReconfirmation")}
        />
      )}
      {facts.map((fact) => {
        const own = fact.answers.some((a) => a.personId === view.personId);
        const response = fact.acknowledgements.find(
          (a) => a.personId === view.personId,
        );
        return (
          <article
            className="questionnaire-answer"
            key={fact.id}
            data-testid="confirmed-fact"
          >
            <Tag>
              {t(
                fact.active
                  ? "resolution.currentFact"
                  : "resolution.superseded",
              )}
            </Tag>
            {fact.locale !== "und" && (
              <span className="muted">{fact.locale}</span>
            )}
            <p className="questionnaire-text" lang={fact.locale}>
              {fact.text}
            </p>
            {workflowView && (
              <RecordOriginLink
                origin={fact.origin}
                workflowId={workflowView.workflow.id}
              />
            )}
            <EvidenceChanges changes={fact.evidenceChanges} />
            <p className="muted">
              {t("resolution.confirmedBy")}: {fact.actorName} ·{" "}
              {new Date(fact.createdAt).toLocaleString(locale)}
            </p>
            <ul>
              {fact.answers.map((answer) => (
                <li key={answer.personId}>
                  {view.answers.find(
                    (a) =>
                      a.questionId === question.id &&
                      a.personId === answer.personId,
                  )?.personName ?? answer.personId}{" "}
                  ·{" "}
                  {format("questionnaire.answerRevision", {
                    number: answer.revision,
                  })}
                </li>
              ))}
            </ul>
            <AttachmentLinks
              attachments={fact.attachments ?? []}
              basePath={basePath}
              path={path}
            />
            {fact.acknowledgements.map((a) => (
              <p key={a.personId}>
                {a.personName}: <Tag>{t(`resolution.${a.decision}`)}</Tag>
                {a.reason}
              </p>
            ))}
            {fact.active &&
              fact.acknowledgements.length < fact.answers.length && (
                <p className="muted">
                  {t("resolution.pendingAcknowledgement")}
                </p>
              )}
            {view.capabilities.acknowledge &&
              fact.active &&
              own &&
              !response && (
                <Space wrap>
                  <Button
                    loading={busy}
                    onClick={() =>
                      void run(() =>
                        preview(
                          `${path}/facts/${encodeURIComponent(fact.id)}/acknowledgement`,
                          { decision: "acknowledged" },
                          [fact.text],
                        ),
                      )
                    }
                  >
                    {t("resolution.acknowledge")}
                  </Button>
                  <Button
                    disabled={busy}
                    danger
                    onClick={() => {
                      setDisputing(fact.id);
                      setDisputeReason("");
                    }}
                  >
                    {t("resolution.dispute")}
                  </Button>
                </Space>
              )}
          </article>
        );
      })}
      {canResolve && (
        <form
          className="questionnaire-resolution-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void run(resolve);
          }}
        >
          <label className="field">
            {t("resolution.kind")}
            <Select
              virtual={false}
              aria-label={t("resolution.kind")}
              value={kind}
              onChange={setKind}
              options={(
                ["confirmed", "followed-up", "deferred", "withdrawn"] as const
              ).map((value) => ({
                value,
                label: t(`questionnaire.state.${value}`),
              }))}
            />
          </label>
          {kind === "confirmed" && (
            <>
              {workflowView && (
                <p>
                  {format("resolution.localeHint", {
                    locale: workflowView.version.locale,
                  })}
                </p>
              )}
              {skillView && (
                <>
                  <label className="field">
                    {t("resolution.skillOutcome")}
                    <Select
                      virtual={false}
                      aria-label={t("resolution.skillOutcome")}
                      value={skillOutcome}
                      onChange={setSkillOutcome}
                      options={(["clarification", "change"] as const).map(
                        (value) => ({
                          value,
                          label: t(`resolution.${value}`),
                        }),
                      )}
                    />
                  </label>
                  {skillOutcome === "change" && (
                    <label className="field">
                      {t("resolution.successorVersion")}
                      <Select
                        allowClear
                        virtual={false}
                        aria-label={t("resolution.successorVersion")}
                        placeholder={t("resolution.pendingSuccessor")}
                        value={successor}
                        onChange={setSuccessor}
                        options={successorOptions}
                      />
                    </label>
                  )}
                </>
              )}
              {drafts.map((draft, index) => (
                <div key={index}>
                  <label className="field">
                    {format("resolution.factNumber", { number: index + 1 })}
                    <Input.TextArea
                      aria-label={format("resolution.factNumber", {
                        number: index + 1,
                      })}
                      rows={3}
                      status={
                        draft.text.length > factTextLimit ? "error" : undefined
                      }
                      value={draft.text}
                      onChange={(e) =>
                        setDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, text: e.target.value } : d,
                          ),
                        )
                      }
                    />
                    {draft.text.length > factTextLimit && (
                      <span role="alert">
                        {format("questionnaire.textTooLong", {
                          limit: factTextLimit,
                        })}
                      </span>
                    )}
                  </label>
                  {importableAnswers.length > 0 && (
                    <div className="questionnaire-fact-import">
                      <TextImportButton
                        label={t(
                          draft.text
                            ? "resolution.replaceWithAnswer"
                            : "resolution.useAnswer",
                        )}
                        sources={importableAnswers}
                        disabled={busy}
                        onImport={(key) => {
                          const answer = submittedByKey.get(key);
                          if (answer)
                            setDrafts((current) =>
                              current.map((item, position) =>
                                position === index
                                  ? { text: answer.text, answerKeys: [key] }
                                  : item,
                              ),
                            );
                        }}
                      />
                    </div>
                  )}
                  <label className="field">
                    {t("resolution.answers")}
                    <Select
                      virtual={false}
                      mode="multiple"
                      aria-label={format("resolution.factAnswers", {
                        number: index + 1,
                      })}
                      value={draft.answerKeys}
                      onChange={(answerKeys) =>
                        setDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, answerKeys } : d,
                          ),
                        )
                      }
                      options={answerOptions}
                    />
                  </label>
                  {drafts.length > 1 && (
                    <Button
                      onClick={() =>
                        setDrafts(drafts.filter((_, i) => i !== index))
                      }
                    >
                      {t("questionnaire.remove")}
                    </Button>
                  )}
                </div>
              ))}
              <Button
                onClick={() =>
                  setDrafts([
                    ...drafts,
                    { text: "", answerKeys: [...submittedByKey.keys()] },
                  ])
                }
              >
                {t("resolution.addFact")}
              </Button>
            </>
          )}
          {kind === "followed-up" && (
            <label className="field">
              {t("resolution.followUp")}
              <Input.TextArea
                aria-label={t("resolution.followUp")}
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
              />
            </label>
          )}
          {kind === "deferred" && (
            <>
              <label className="field">
                {t("resolution.deferral")}
                <Select
                  virtual={false}
                  aria-label={t("resolution.deferral")}
                  value={deferredKind}
                  onChange={setDeferredKind}
                  options={[
                    {
                      value: "out-of-scope",
                      label: t("resolution.outOfScope"),
                    },
                    {
                      value: "skill-internal",
                      label: t("resolution.skillInternal"),
                    },
                  ]}
                />
              </label>
              {deferredKind === "skill-internal" && (
                <label className="field">
                  {t("resolution.skill")}
                  <Select
                    virtual={false}
                    aria-label={t("resolution.skill")}
                    value={skillId}
                    onChange={setSkillId}
                    options={(workflowView?.pins ?? []).map((p) => ({
                      value: p.skillId,
                      label: p.skillName,
                    }))}
                  />
                </label>
              )}
            </>
          )}
          {kind !== "confirmed" && (
            <label className="field">
              {t("resolution.reason")}
              <Input.TextArea
                aria-label={t("resolution.reason")}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <Button
            type="primary"
            loading={busy}
            disabled={!ready}
            htmlType="submit"
          >
            {t("resolution.review")}
          </Button>
        </form>
      )}
      {pendingChange && (
        <>
          <p>{t("resolution.pendingSuccessor")}</p>
          {view.capabilities.resolve && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedSuccessor) return;
                void run(() =>
                  preview(
                    `${path}/questions/${encodeURIComponent(question.id)}/link-successor`,
                    {
                      resolutionId: pendingChange.id,
                      successorVersionHash: selectedSuccessor.versionHash,
                    },
                    [],
                  ),
                );
              }}
            >
              <label className="field">
                {t("resolution.successorVersion")}
                <Select
                  virtual={false}
                  aria-label={t("resolution.successorVersion")}
                  value={successor}
                  onChange={setSuccessor}
                  options={successorOptions}
                />
              </label>
              <Button
                disabled={busy}
                onClick={() => void run(refreshSuccessors)}
              >
                {t("resolution.refreshSuccessors")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!selectedSuccessor}
                htmlType="submit"
              >
                {t("resolution.reviewSuccessorLink")}
              </Button>
            </form>
          )}
        </>
      )}
      {resolutions.length > 0 && (
        <details
          className="questionnaire-history"
          open={linkedRevision > 0 || undefined}
        >
          <summary>{t("resolution.history")}</summary>
          {resolutions.map((r) => (
            <div key={r.id} id={`resolution-${r.revision}`}>
              <Tag>{t(`questionnaire.state.${r.kind}`)}</Tag>
              {skillView && (
                <Tag>
                  {format("resolution.reviewedRevision", {
                    number: r.revision,
                  })}
                </Tag>
              )}
              <p>{r.reason}</p>
              {skillView && r.skillOutcome && (
                <p>
                  {t(`resolution.${r.skillOutcome.kind}`)} ·{" "}
                  {t("resolution.discussedVersion")}{" "}
                  <Link
                    to={skillVersionHref(
                      skillView.skill.id,
                      r.skillOutcome.versionHash,
                    )}
                  >
                    {r.skillOutcome.versionHash.slice(0, 12)}
                  </Link>
                  {r.skillOutcome.successorVersionHash ? (
                    <>
                      {" · "}
                      {t("resolution.successorVersion")}{" "}
                      <Link
                        to={skillVersionHref(
                          skillView.skill.id,
                          r.skillOutcome.successorVersionHash,
                        )}
                      >
                        {r.skillOutcome.successorVersionHash.slice(0, 12)}
                      </Link>
                    </>
                  ) : (
                    r.skillOutcome.kind === "change" &&
                    r.id !== pendingChange?.id &&
                    ` · ${t("resolution.pendingSuccessor")}`
                  )}
                </p>
              )}
              {r.skillOutcome?.successorLink && (
                <p className="muted">
                  {format("resolution.successorLinkedBy", {
                    name: r.skillOutcome.successorLink.actorName,
                    date: new Date(
                      r.skillOutcome.successorLink.createdAt,
                    ).toLocaleString(locale),
                  })}
                </p>
              )}
              <p className="muted">
                {r.actorName} · {new Date(r.createdAt).toLocaleString(locale)}
              </p>
              {r.childQuestionId && (
                <Link
                  to={`/questionnaire/questions/${encodeURIComponent(r.childQuestionId)}`}
                >
                  {t("resolution.child")}
                </Link>
              )}
              {r.skillId && (
                <Link to={`/skills/${encodeURIComponent(r.skillId)}`}>
                  {t("resolution.skillBacklog")}
                </Link>
              )}
            </div>
          ))}
        </details>
      )}
      <Modal
        open={disputing !== null}
        title={t("resolution.dispute")}
        okText={t("resolution.review")}
        cancelText={t("common.cancel")}
        onCancel={() => setDisputing(null)}
        confirmLoading={busy}
        okButtonProps={{ disabled: !disputeReason.trim() }}
        onOk={() =>
          void run(async () => {
            const fact = facts.find((f) => f.id === disputing)!;
            await preview(
              `${path}/facts/${encodeURIComponent(fact.id)}/acknowledgement`,
              { decision: "disputed", reason: disputeReason },
              [fact.text, disputeReason],
            );
            setDisputing(null);
          })
        }
      >
        <label className="field">
          {t("resolution.reason")}
          <Input.TextArea
            aria-label={t("resolution.reason")}
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
          />
        </label>
      </Modal>
      <Modal
        open={review !== null}
        title={t("resolution.reviewTitle")}
        okText={t("resolution.signOff")}
        cancelText={t("common.cancel")}
        onCancel={() => setReview(null)}
        confirmLoading={busy}
        onOk={() =>
          void run(async () => {
            if (!review) return;
            const endpoint = review.path.endsWith("/resolution")
              ? review.path.replace(/\/resolution$/u, "/resolve")
              : review.path.replace(/\/acknowledgement$/u, "/acknowledge");
            await questionnaireRequest(basePath, endpoint, "POST", {
              ...review.input,
              confirmed: true,
              confirmationHash: review.preview.confirmationHash,
              requestId: review.requestId,
            });
            setReview(null);
            setDrafts([{ text: "", answerKeys: [...submittedByKey.keys()] }]);
            await reload();
          })
        }
      >
        {review && (
          <>
            <p>
              {review.path.endsWith("/link-successor") &&
              review.preview.resolutionRevision !== undefined
                ? format("resolution.reviewedRevision", {
                    number: review.preview.resolutionRevision,
                  })
                : review.input.kind
                  ? t(`questionnaire.state.${review.input.kind as Kind}`)
                  : t(
                      `resolution.${review.input.decision as "acknowledged" | "disputed"}`,
                    )}
            </p>
            {review.facts.map((text, index) => (
              <p className="questionnaire-text" key={index}>
                {text}
              </p>
            ))}
            {skillView && (reviewedSkillOutcome || reviewedSuccessorHash) && (
              <p>
                {t(`resolution.${reviewedSkillOutcome?.kind ?? "change"}`)} ·{" "}
                {t("resolution.discussedVersion")}{" "}
                <Link
                  to={skillVersionHref(
                    skillView.skill.id,
                    skillView.subject.versionHash,
                  )}
                >
                  {skillView.subject.versionHash}
                </Link>
                {reviewedSuccessorHash ? (
                  <>
                    {" · "}
                    {t("resolution.successorVersion")}{" "}
                    <Link
                      to={skillVersionHref(
                        skillView.skill.id,
                        reviewedSuccessorHash,
                      )}
                    >
                      {reviewedSuccessorHash}
                    </Link>
                  </>
                ) : (
                  reviewedSkillOutcome?.kind === "change" &&
                  ` · ${t("resolution.pendingSuccessor")}`
                )}
              </p>
            )}
            {review.input.kind === "confirmed" &&
              !!review.preview.drafts?.length && (
                <>
                  <h3>{t("ledger.linkedDrafts")}</h3>
                  <p>{t("ledger.linkedDraftsHelp")}</p>
                  {review.preview.drafts.map((draft) => (
                    <p className="questionnaire-text" key={draft.id}>
                      {draft.statement} · {t("ledger.recordRevision")}{" "}
                      {draft.revision}
                    </p>
                  ))}
                </>
              )}
            {review.preview.locale !== "und" && <p>{review.preview.locale}</p>}
            <h3>{t("resolution.answers")}</h3>
            <ul>
              {review.preview.answers.map((answer) => (
                <li key={answer.personId}>
                  {view.assignees.find((a) => a.personId === answer.personId)
                    ?.name ?? answer.personId}{" "}
                  ·{" "}
                  {format("questionnaire.answerRevision", {
                    number: answer.revision,
                  })}
                  {answer.text && (
                    <AnswerContent
                      answer={{
                        text: answer.text,
                        value: answer.value ?? null,
                        attachments: answer.attachments ?? [],
                      }}
                      type={review.preview.answerType}
                      basePath={basePath}
                      path={path}
                    />
                  )}
                </li>
              ))}
            </ul>
            {!!review.preview.evidence?.length && (
              <>
                <h3>{t("questionnaire.evidence")}</h3>
                <ul>
                  {review.preview.evidence.map((link, index) => (
                    <li key={index}>
                      {link.path}:{link.startLine}–{link.endLine}
                      <code className="skills-hash">{link.fileHash}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>{t("resolution.boundPreview")}</p>
            <code className="skills-hash">
              {review.preview.confirmationHash}
            </code>
          </>
        )}
        {failure && <Alert type="error" showIcon message={failure} />}
      </Modal>
    </section>
  );
}
