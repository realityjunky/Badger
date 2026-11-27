import { Button, Space, Tag } from "antd";
import type { ReactNode, Ref } from "react";
import { Link } from "react-router-dom";
import type { PlanDraftingJob } from "../../api/drafting-jobs.js";
import type { FactoryPlan } from "../../api/plans.js";
import { AgentPromptButton } from "../../components/AgentPromptButton.js";
import { useI18n } from "../../i18n/I18nContext.js";

function canReconcile(job: PlanDraftingJob) {
  return (
    !!job.reconciliationHeadId &&
    (job.status === "submitted" || job.status === "cancelled")
  );
}

export function PlanDraftingJobs({
  jobs,
  basePath,
  path,
  selectedId,
  selectedRow,
  selectedFinding,
  busy,
  hasSkeleton,
  onRequestRepair,
  onReview,
  onDiscard,
  onDelete,
}: {
  jobs: PlanDraftingJob[];
  basePath: string;
  path: string;
  selectedId: string | null;
  selectedRow: Ref<HTMLLIElement>;
  selectedFinding: ReactNode;
  busy: boolean;
  hasSkeleton: boolean;
  onRequestRepair(job: PlanDraftingJob): void;
  onReview(job: PlanDraftingJob, plan: FactoryPlan): void;
  onDiscard(job: PlanDraftingJob): void;
  onDelete(job: PlanDraftingJob): void;
}) {
  const { t, format, locale } = useI18n();
  const successors = new Map<string, PlanDraftingJob>();
  for (const job of jobs) {
    if (job.planRepair && job.status !== "cancelled") {
      for (const id of job.planRepair.sourceDraftIds) successors.set(id, job);
    }
  }
  const current: PlanDraftingJob[] = [];
  const earlier: PlanDraftingJob[] = [];
  for (const job of [...jobs].reverse()) {
    if (
      !successors.has(job.id) &&
      (["queued", "claimed", "submitted"].includes(job.status) ||
        canReconcile(job))
    )
      current.push(job);
    else earlier.push(job);
  }
  const activeRepair = current.find(
    (job) => job.planRepair && !canReconcile(job),
  );
  const renderJob = (job: PlanDraftingJob) => {
    const successor = successors.get(job.id);
    const repair = job.planRepair;
    const followUp = job.authoringFollowUp;
    const needsReconciliation = canReconcile(job);
    const result = job.review?.result ?? job.result;
    const reviewable =
      job.status === "submitted" &&
      !successor &&
      !needsReconciliation &&
      !!result;
    const lanes = [...new Set(repair?.items.map((item) => item.source))].filter(
      (source) => source !== "reconciliation",
    );
    const needsEvidence =
      repair?.items.filter(
        (item) => result?.resolutions?.[item.id]?.status === "needs-evidence",
      ).length ?? 0;
    const title = repair
      ? t(`plan.repair.${repair.wave}`)
      : followUp
        ? format("authoring.findingOrigin", { lane: followUp.lane })
        : t("plan.draft");
    const prompt = !successor && !job.reconciliationHeadId && (
      <AgentPromptButton
        basePath={basePath}
        path={`${path}/drafting-jobs/${job.id}/prompt`}
        disabled={busy}
      />
    );
    return (
      <li
        key={job.id}
        className="plan-draft-row"
        ref={job.id === selectedId ? selectedRow : undefined}
        aria-current={job.id === selectedId ? "true" : undefined}
        tabIndex={-1}
      >
        <div className="plan-draft-heading">
          <h4>
            {title} {!repair && !followUp && <code>{job.id.slice(0, 8)}</code>}
          </h4>
          <Tag color={reviewable ? "processing" : undefined}>
            {t(
              needsReconciliation
                ? "plan.newerVersion"
                : successor && job.status === "submitted"
                  ? "plan.included"
                  : job.feedback && job.status === "queued"
                    ? "plan.returned"
                    : `drafting.state.${job.status}`,
            )}
          </Tag>
        </div>
        {lanes.length > 0 && (
          <p>
            {format("plan.findingLanes", {
              lanes: new Intl.ListFormat(locale).format(lanes),
            })}
          </p>
        )}
        {reviewable && repair && (
          <div className="plan-draft-guidance">
            {needsEvidence > 0 && (
              <Tag color="warning">
                {format("plan.needsEvidenceCount", { count: needsEvidence })}
              </Tag>
            )}
            <p>{t("plan.reviewRepairHelp")}</p>
          </div>
        )}
        {job.id === selectedId && selectedFinding}
        {!successor &&
          followUp &&
          !(job.id === selectedId && selectedFinding) && (
            <p>{followUp.action.requirement}</p>
          )}
        {job.feedback && (
          <p>
            <strong>{t("plan.feedback")}</strong> · {job.feedback.reason}
          </p>
        )}
        {job.status === "claimed" && result && (
          <p role="status">{t("plan.draftSaved")}</p>
        )}
        {successor ? (
          <Link
            to={{
              search: new URLSearchParams({
                planDraft: successor.id,
              }).toString(),
              hash: "#plan",
            }}
          >
            {t("plan.openRepair")}
          </Link>
        ) : needsReconciliation ? (
          <>
            <p>
              {t(activeRepair ? "plan.waitToReconcile" : "plan.reconcileHelp")}
            </p>
            <Button
              disabled={busy || !hasSkeleton || !!activeRepair}
              onClick={() => onRequestRepair(job)}
            >
              {t("plan.requestAgentRepair")}
            </Button>
          </>
        ) : reviewable ? (
          <Button
            type="primary"
            disabled={busy || !hasSkeleton}
            onClick={() => onReview(job, result.plan)}
          >
            {t(repair ? "plan.reviewRepair" : "plan.reviewSuggestion")}
          </Button>
        ) : job.status === "queued" ? (
          prompt
        ) : null}
        <details className="plan-draft-details">
          <summary>{t("plan.draftDetails")}</summary>
          <p>
            {t("proposal.jobId")} · <code>{job.id}</code>
          </p>
          {successor &&
            followUp &&
            !(job.id === selectedId && selectedFinding) && (
              <p>{followUp.action.requirement}</p>
            )}
          <Space wrap>
            {reviewable && prompt}
            {job.status === "submitted" && !repair && (
              <Button disabled={busy} onClick={() => onDiscard(job)}>
                {t("drafting.discard")}
              </Button>
            )}
            {job.status !== "claimed" && job.status !== "accepted" && (
              <Button danger disabled={busy} onClick={() => onDelete(job)}>
                {t("plan.deleteDraft")}
              </Button>
            )}
          </Space>
        </details>
      </li>
    );
  };
  return (
    <div className="plan-drafting-jobs">
      {current.length > 0 && (
        <ul className="plan-draft-list">
          {activeRepair && renderJob(activeRepair)}
          {current.filter((job) => job !== activeRepair).map(renderJob)}
        </ul>
      )}
      {earlier.length > 0 && (
        <details className="plan-draft-history">
          <summary>
            {format("plan.earlierDrafts", { count: earlier.length })}
          </summary>
          <ul className="plan-draft-list">{earlier.map(renderJob)}</ul>
        </details>
      )}
    </div>
  );
}
