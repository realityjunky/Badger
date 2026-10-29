import { Alert, Button, Input, Modal, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  questionnaireRequest,
  type Question,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

type Kind = "confirmed" | "followed-up" | "deferred" | "withdrawn";
interface FactDraft {
  text: string;
  people: string[];
}
interface Review {
  path: string;
  input: Record<string, unknown>;
  preview: {
    confirmationHash: string;
    locale: string;
    answers: { personId: string; revision: number; text?: string }[];
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
}: {
  question: Question;
  view: QuestionnaireView;
  path: string;
  basePath: string;
  reload: () => Promise<unknown>;
}) {
  const { t, format, locale } = useI18n();
  const [kind, setKind] = useState<Kind>("confirmed");
  const [reason, setReason] = useState("");
  const [deferredKind, setDeferredKind] = useState("out-of-scope");
  const [skillId, setSkillId] = useState<string>();
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const submitted = view.answers
    .filter((a) => a.questionId === question.id && a.eligibleForResolution)
    .flatMap((a) => {
      const latest = a.revisions.filter((r) => r.state === "submitted").at(-1);
      return latest
        ? [{ ...latest, personId: a.personId, personName: a.personName }]
        : [];
    });
  const [drafts, setDrafts] = useState<FactDraft[]>([
    { text: "", people: submitted.map((a) => a.personId) },
  ]);
  const answerPeople = JSON.stringify(submitted.map((a) => a.personId));
  useEffect(() => {
    const eligible = JSON.parse(answerPeople) as string[];
    setDrafts((current) =>
      current.map((d) => ({
        ...d,
        people:
          !d.text && d.people.length === 0
            ? eligible
            : d.people.filter((personId) => eligible.includes(personId)),
      })),
    );
  }, [answerPeople]);
  const facts = view.facts.filter((f) => f.questionId === question.id);
  const resolutions = view.resolutions.filter(
    (r) => r.questionId === question.id,
  );
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
      facts: texts,
    });
  };
  const resolve = async () => {
    const input: Record<string, unknown> = {
      revision: question.revision,
      kind,
    };
    if (reason.trim()) input.reason = reason;
    if (kind === "confirmed")
      input.facts = drafts.map((d) => ({
        text: d.text,
        answers: d.people.map((personId) => ({
          personId,
          revision: submitted.find((a) => a.personId === personId)!.revision,
        })),
      }));
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
      ? drafts.every((d) => d.text.trim() && d.people.length)
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
            <span className="muted">{fact.locale}</span>
            <p className="questionnaire-text" lang={fact.locale}>
              {fact.text}
            </p>
            <p className="muted">
              {t("resolution.confirmedBy")}: {fact.actorName} ·{" "}
              {new Date(fact.createdAt).toLocaleString(locale)}
            </p>
            <ul>
              {fact.answers.map((answer) => (
                <li key={answer.personId}>
                  {view.assignees.find((a) => a.personId === answer.personId)
                    ?.name ?? answer.personId}{" "}
                  ·{" "}
                  {format("questionnaire.answerRevision", {
                    number: answer.revision,
                  })}
                </li>
              ))}
            </ul>
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
              <p>
                {format("resolution.localeHint", {
                  locale: view.version.locale,
                })}
              </p>
              {drafts.map((draft, index) => (
                <div key={index}>
                  <label className="field">
                    {format("resolution.factNumber", { number: index + 1 })}
                    <Input.TextArea
                      aria-label={format("resolution.factNumber", {
                        number: index + 1,
                      })}
                      rows={3}
                      value={draft.text}
                      onChange={(e) =>
                        setDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, text: e.target.value } : d,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    {t("resolution.answers")}
                    <Select
                      virtual={false}
                      mode="multiple"
                      aria-label={format("resolution.factAnswers", {
                        number: index + 1,
                      })}
                      value={draft.people}
                      onChange={(people) =>
                        setDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, people } : d,
                          ),
                        )
                      }
                      options={submitted.map((a) => ({
                        value: a.personId,
                        label: `${a.personName} · ${format("questionnaire.answerRevision", { number: a.revision })}`,
                      }))}
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
                    { text: "", people: submitted.map((a) => a.personId) },
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
                    options={view.pins.map((p) => ({
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
      {resolutions.length > 0 && (
        <details className="questionnaire-history">
          <summary>{t("resolution.history")}</summary>
          {resolutions.map((r) => (
            <div key={r.id}>
              <Tag>{t(`questionnaire.state.${r.kind}`)}</Tag>
              <p>{r.reason}</p>
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
            setDrafts([{ text: "", people: submitted.map((a) => a.personId) }]);
            await reload();
          })
        }
      >
        {review && (
          <>
            <p>
              {review.input.kind
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
            <p>{review.preview.locale}</p>
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
                    <p className="questionnaire-text">{answer.text}</p>
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
