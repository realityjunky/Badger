import { Alert, Button, Modal, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ProposalView } from "../../api/proposals.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";

export function WorkflowProposal({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const inbox = useInbox();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const hadPendingJob = useRef(false);
  const [view, setView] = useState<ProposalView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{
    kind: "approve" | "initialize";
    view: ProposalView;
    preview?: GatePreview;
    requestId: string;
  } | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<ProposalView>(
      basePath,
      `${path}/proposal`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (controller.signal.aborted) return;
        setView(value);
        const pending = value.jobs.some(
          (job) => job.status === "queued" || job.status === "running",
        );
        if (hadPendingJob.current && !pending) onChanged();
        hadPendingJob.current = pending;
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("proposal.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, detail.version.revision, refresh]);
  useEffect(() => {
    if (
      !view?.jobs.some(
        (job) => job.status === "queued" || job.status === "running",
      )
    )
      return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [view]);
  useEffect(() => {
    if (location.hash === "#proposal" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("proposal.failed"));
    } finally {
      setBusy(false);
    }
  }
  async function reviewApproval() {
    if (!view?.proposal) return;
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/gates/proposal/preview`,
      "POST",
      {},
    );
    if (
      preview.boundHashes.proposal !== view.proposal.proposalHash ||
      preview.boundHashes.plan !== view.planVersionHash
    ) {
      setRefresh((value) => value + 1);
      throw new Error(t("proposal.changed"));
    }
    setReview({
      kind: "approve",
      view,
      preview,
      requestId: crypto.randomUUID(),
    });
  }
  async function confirm() {
    if (!review?.view.proposal) return;
    if (review.kind === "approve") {
      await questionnaireRequest(
        basePath,
        `${path}/gates/proposal/commit`,
        "POST",
        {
          confirmationHash: review.preview!.confirmationHash,
          requestId: review.requestId,
        },
      );
    } else {
      await questionnaireRequest(
        basePath,
        `${path}/proposal/initialize`,
        "POST",
        {
          proposalHash: review.view.proposal.proposalHash,
          ...(review.view.currentState
            ? { replaceStateHash: review.view.currentState.hash }
            : {}),
          confirmed: true,
          requestId: review.requestId,
        },
      );
    }
    setReview(null);
    setRefresh((value) => value + 1);
    onChanged();
    await inbox.refresh();
  }
  const proposal = view?.proposal;
  const approved =
    !!proposal &&
    view?.confirmation?.invalidatedAt === null &&
    view.confirmation.boundHashes.proposal === proposal.proposalHash &&
    view.confirmation.boundHashes.plan === view.planVersionHash;
  const pending = view?.jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );
  const reviewed = review?.view.proposal;
  const replacing = review?.kind === "initialize" && !!review.view.currentState;
  return (
    <section
      ref={section}
      id="proposal"
      className="workflow-panel"
      data-testid="workflow-proposal"
      aria-labelledby="proposal-title"
    >
      <div className="workflow-card-heading">
        <h2 id="proposal-title">{t("proposal.title")}</h2>
        <Space wrap>
          {proposal?.canInitialize &&
            !approved &&
            detail.capabilities.approveProposal && (
              <Button
                type="primary"
                loading={busy}
                onClick={() => void run(reviewApproval)}
              >
                {t("proposal.reviewApproval")}
              </Button>
            )}
          {approved && detail.capabilities.initialize && (
            <Button
              type="primary"
              disabled={busy || pending}
              onClick={() =>
                view &&
                setReview({
                  kind: "initialize",
                  view,
                  requestId: crypto.randomUUID(),
                })
              }
            >
              {t(
                view?.currentState ? "proposal.replace" : "proposal.initialize",
              )}
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              setFailure(null);
              setRefresh((value) => value + 1);
            }}
          >
            {t("workflow.reload")}
          </Button>
        </Space>
      </div>
      <p className="muted">{t("proposal.description")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {!view ? (
        <Spin />
      ) : (
        <>
          {view.confirmation?.invalidatedAt && (
            <Alert type="warning" showIcon title={t("proposal.invalidated")} />
          )}
          {approved && (
            <Alert type="success" showIcon title={t("proposal.approved")} />
          )}
          {!proposal ? (
            <Alert type="info" showIcon title={t("proposal.needPlan")} />
          ) : (
            <>
              <p>{proposal.goal}</p>
              <dl className="gate-hashes">
                <div>
                  <dt>{t("proposal.hash")}</dt>
                  <dd>
                    <code>{proposal.proposalHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("plan.hash")}</dt>
                  <dd>
                    <code>{view.planVersionHash}</code>
                  </dd>
                </div>
              </dl>
              <h3>{t("workflow.sources")}</h3>
              <ul className="gate-pins">
                {proposal.sources.map((source) => (
                  <li key={source.id}>
                    {source.name} <Tag>{source.location}</Tag>
                    <code>{source.hash}</code>
                  </li>
                ))}
              </ul>
              {proposal.blockers.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  title={t("proposal.blockers")}
                  description={
                    <ul>
                      {proposal.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  }
                />
              )}
              {proposal.warnings.map((warning) => (
                <Alert key={warning} type="warning" showIcon title={warning} />
              ))}
            </>
          )}
          {view.currentState && (
            <>
              <h3>{t("proposal.currentState")}</h3>
              <code className="gate-confirmation-hash">
                {view.currentState.hash}
              </code>
            </>
          )}
          {view.jobs.length > 0 && (
            <div role="status" aria-live="polite">
              <h3>{t("proposal.jobs")}</h3>
              <ul>
                {view.jobs.map((job) => (
                  <li key={job.id}>
                    <Tag>{t(`proposal.status.${job.status}`)}</Tag>
                    {job.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <Modal
        open={review !== null}
        title={t(
          review?.kind === "approve"
            ? "proposal.reviewApproval"
            : replacing
              ? "proposal.replace"
              : "proposal.initialize",
        )}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() => void run(confirm)}
        okText={t(
          review?.kind === "approve"
            ? "proposal.approve"
            : replacing
              ? "proposal.replace"
              : "proposal.initialize",
        )}
        cancelText={t("workflow.cancel")}
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        okButtonProps={{ danger: replacing }}
      >
        <p>
          {t(
            review?.kind === "approve"
              ? "proposal.approvalHelp"
              : replacing
                ? "proposal.replaceHelp"
                : "proposal.initHelp",
          )}
        </p>
        <p>{reviewed?.goal}</p>
        <dl className="gate-hashes">
          <div>
            <dt>{t("proposal.hash")}</dt>
            <dd>
              <code>{reviewed?.proposalHash}</code>
            </dd>
          </div>
          <div>
            <dt>{t("plan.hash")}</dt>
            <dd>
              <code>{review?.view.planVersionHash}</code>
            </dd>
          </div>
          {replacing && (
            <div>
              <dt>{t("proposal.currentState")}</dt>
              <dd>
                <code>{review?.view.currentState?.hash}</code>
              </dd>
            </div>
          )}
        </dl>
        <h3>{t("workflow.sources")}</h3>
        <ul className="gate-pins">
          {reviewed?.sources.map((source) => (
            <li key={source.id}>
              {source.name}
              <code>{source.hash}</code>
            </li>
          ))}
        </ul>
        {failure && <Alert type="error" showIcon title={failure} />}
      </Modal>
    </section>
  );
}
