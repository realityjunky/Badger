import { Alert, Button, Modal, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ProposalView } from "../../api/proposals.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { ConfirmationHistory } from "../../components/ConfirmationHistory.js";
import { AuthoringStageFinding } from "./AuthoringStageFinding.js";

export function WorkflowProposal({
  basePath,
  detail,
  active,
  planRefresh,
  approvedPlanHash,
  historical,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  active: boolean;
  planRefresh: number;
  approvedPlanHash?: string;
  historical: boolean;
  onChanged(): void;
}) {
  const { t, locale } = useI18n();
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
    if (!active) return;
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
  }, [
    active,
    basePath,
    path,
    detail.version.revision,
    refresh,
    planRefresh,
    approvedPlanHash,
  ]);
  useEffect(() => {
    if (
      !active ||
      !view?.jobs.some(
        (job) => job.status === "queued" || job.status === "running",
      )
    )
      return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [view, active]);
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
  const planReady =
    !!approvedPlanHash && approvedPlanHash === view?.planVersionHash;
  const canInitialize = planReady && approved && !!proposal?.canInitialize;
  const alreadyInitialized =
    canInitialize &&
    !!view?.currentState &&
    view.currentState.planVersionHash === approvedPlanHash &&
    view.currentState.proposalHash === proposal?.proposalHash &&
    view.currentState.proposalConfirmationId === view.confirmation?.id;
  const initializationButton = detail.capabilities.initialize && (
    <Button
      type={alreadyInitialized ? "default" : "primary"}
      danger={!!view?.currentState}
      disabled={busy || pending || !canInitialize}
      onClick={() =>
        view &&
        setReview({ kind: "initialize", view, requestId: crypto.randomUUID() })
      }
    >
      {t(view?.currentState ? "proposal.replace" : "proposal.initialize")}
    </Button>
  );
  return (
    <section
      ref={section}
      id="proposal"
      data-testid="workflow-proposal"
      aria-label={t("proposal.title")}
    >
      <AuthoringStageFinding basePath={basePath} path={path} stage="proposal" />
      {failure && <Alert type="error" showIcon title={failure} />}
      {!view ? (
        <Spin />
      ) : (
        <>
          <section
            className="proposal-action-row"
            aria-labelledby="proposal-approval-title"
          >
            <div className="proposal-action-controls">
              <h3 id="proposal-approval-title">{t("proposal.approval")}</h3>
              {!approved && detail.capabilities.approveProposal && (
                <Button
                  type="primary"
                  loading={busy}
                  disabled={!planReady || !proposal?.canInitialize}
                  onClick={() => void run(reviewApproval)}
                >
                  {t("proposal.reviewApproval")}
                </Button>
              )}
              {!proposal && <Link to="#plan">{t("plan.title")}</Link>}
            </div>
            <div className="proposal-action-info">
              {historical && (
                <Alert
                  type="info"
                  showIcon
                  title={t("proposal.historicalPlan")}
                />
              )}
              {view.confirmation?.invalidatedAt && (
                <Alert
                  type="warning"
                  showIcon
                  title={t("proposal.invalidated")}
                />
              )}
              {approved && <Tag color="success">{t("proposal.approved")}</Tag>}
              {!approved && proposal?.canInitialize && (
                <Tag color="processing">{t("dossier.awaiting")}</Tag>
              )}
              {!proposal ? (
                <Alert type="info" showIcon title={t("proposal.needPlan")} />
              ) : (
                <>
                  <p>{proposal.goal}</p>
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
                    <Alert
                      key={warning}
                      type="warning"
                      showIcon
                      title={warning}
                    />
                  ))}
                </>
              )}
              <ConfirmationHistory confirmations={view.confirmations} />
            </div>
          </section>
          <section
            className="proposal-action-row"
            aria-label={t("proposal.project")}
          >
            <div className="proposal-action-controls">
              <h3>{t("proposal.project")}</h3>
              {alreadyInitialized ? (
                <>
                  <Link to="#package">{t("proposal.continuePackage")}</Link>
                  {initializationButton && (
                    <details>
                      <summary>{t("proposal.restart")}</summary>
                      {initializationButton}
                    </details>
                  )}
                </>
              ) : (
                initializationButton
              )}
              {view.currentState && !alreadyInitialized && (
                <Link to="#package">{t("proposal.inspectPackage")}</Link>
              )}
            </div>
            <div className="proposal-action-info">
              {canInitialize && view.currentState && !alreadyInitialized ? (
                <Alert
                  type="warning"
                  showIcon
                  title={t("proposal.replaceNeeded")}
                  description={t("proposal.replaceImpact")}
                />
              ) : (
                <p className="muted">
                  {t(
                    alreadyInitialized
                      ? "proposal.currentProject"
                      : "proposal.projectHelp",
                  )}
                </p>
              )}
              {view.jobs.length > 0 && (
                <div role="status" aria-live="polite">
                  <h4>{t("proposal.jobs")}</h4>
                  <ul className="proposal-jobs">
                    {view.jobs.map((job) => (
                      <li key={job.id}>
                        <div className="proposal-job-heading">
                          <span>
                            {t("proposal.jobId")} <code>{job.id}</code>
                          </span>
                          <Tag
                            color={
                              {
                                queued: "default",
                                running: "processing",
                                succeeded: "success",
                                failed: "error",
                                cancelled: "default",
                              }[job.status]
                            }
                          >
                            {t(`proposal.status.${job.status}`)}
                          </Tag>
                        </div>
                        <dl className="proposal-job-times">
                          {(
                            ["requestedAt", "startedAt", "finishedAt"] as const
                          ).map((key) => {
                            const timestamp = job[key];
                            return (
                              timestamp && (
                                <div key={key}>
                                  <dt>{t(`proposal.${key}`)}</dt>
                                  <dd>
                                    <time dateTime={timestamp}>
                                      {new Date(timestamp).toLocaleString(
                                        locale,
                                      )}
                                    </time>
                                  </dd>
                                </div>
                              )
                            );
                          })}
                        </dl>
                        {job.error && <p>{job.error}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
          {(proposal || view.currentState) && (
            <div className="proposal-references">
              {proposal && (
                <details>
                  <summary>
                    {t("workflow.sources")} ({proposal.sources.length})
                  </summary>
                  <ul className="gate-pins">
                    {proposal.sources.map((source) => (
                      <li key={source.id}>
                        {source.name} <Tag>{source.location}</Tag>
                        <code>{source.hash}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>{t("plan.hashes")}</summary>
                <dl className="gate-hashes">
                  {proposal && (
                    <div>
                      <dt>{t("proposal.hash")}</dt>
                      <dd>
                        <code>{proposal.proposalHash}</code>
                      </dd>
                    </div>
                  )}
                  {view.planVersionHash && (
                    <div>
                      <dt>{t("plan.hash")}</dt>
                      <dd>
                        <code>{view.planVersionHash}</code>
                      </dd>
                    </div>
                  )}
                  {view.currentState && (
                    <div>
                      <dt>{t("proposal.currentState")}</dt>
                      <dd>
                        <code>{view.currentState.hash}</code>
                      </dd>
                    </div>
                  )}
                </dl>
              </details>
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
