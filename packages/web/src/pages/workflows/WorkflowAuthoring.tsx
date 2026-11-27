import { Alert, Button, Collapse, Input, Modal, Space, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  AuthoringReadiness,
  AuthoringRepairTarget,
  AuthoringWaveId,
} from "@realityjunky/badger";
import type { AuthoringDraftingJob } from "../../api/drafting-jobs.js";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import { AgentPromptButton } from "../../components/AgentPromptButton.js";
import { ReloadRecordsButton } from "../../components/ReloadRecordsButton.js";
import { StageReviewGuidance } from "../../components/StageReviewGuidance.js";
import { useI18n } from "../../i18n/I18nContext.js";

type LaneJob = AuthoringDraftingJob & {
  createdAt: string;
  decision: {
    decision?: {
      reason?: string;
      laneOutput?: NonNullable<AuthoringDraftingJob["result"]>["laneOutput"];
    };
    followUp?: StageFollowUp;
  } | null;
};

function reportResult(job: LaneJob) {
  const accepted =
    job.status === "accepted" && job.decision?.decision?.laneOutput;
  return accepted
    ? { laneOutput: accepted }
    : (job.review?.result ?? job.result);
}
type StageFollowUp = {
  stage: AuthoringRepairTarget["stage"] | null;
  targetId: string | null;
  planDraftId: string | null;
};

const stageLabels = {
  plan: "plan.title",
  sources: "workflow.sources",
  dossier: "dossier.title",
  proposal: "proposal.title",
} as const;

function followUpLocation(jobId: string, followUp: StageFollowUp) {
  const search = new URLSearchParams({ authoringFinding: jobId });
  if (followUp.planDraftId) search.set("planDraft", followUp.planDraftId);
  if (followUp.stage === "dossier" && followUp.targetId)
    search.set("dossierVersion", followUp.targetId);
  return { search: search.toString(), hash: followUp.stage ?? "package" };
}

type View = {
  current: boolean;
  readiness: AuthoringReadiness;
  jobs: LaneJob[];
  planRepairs?: { id: string; status: string; wave: AuthoringWaveId }[];
  followUps: (StageFollowUp & {
    jobId: string;
    laneId: string;
    questionId: string | null;
    repairJobId: string | null;
  })[];
};
export function WorkflowAuthoring({
  basePath,
  path,
  packageId,
  canManage,
  onChanged,
}: {
  basePath: string;
  path: string;
  packageId: string;
  canManage: boolean;
  onChanged(): void;
}) {
  const { t, format, locale } = useI18n();
  const navigate = useNavigate();
  const [view, setView] = useState<View | null>(null);
  const regenerationRequired =
    view?.readiness.recovery.regenerationRequired === true;
  const [failure, setFailure] = useState<string | null>(null);
  const [dialogFailure, setDialogFailure] = useState<{
    message: string;
    findings: { message: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<LaneJob | null>(null);
  const reviewLane =
    view &&
    Object.values(view.readiness.lanes).find(
      (lane) => lane.id === review?.laneId,
    );
  const reviewFollowUp = view?.followUps.find(
    (item) => item.jobId === review?.id,
  );
  const canReviewSelected =
    canManage &&
    view?.current &&
    !regenerationRequired &&
    review?.status === "submitted";
  const canReviseSelected =
    canManage &&
    view?.current &&
    !regenerationRequired &&
    review?.status === "accepted" &&
    reviewLane &&
    reviewLane.status === "DONE_WITH_CONCERNS" &&
    !reviewLane.action?.target &&
    reviewLane.action?.kind !== "bug" &&
    !view.readiness.completedLanes.includes(reviewLane.id) &&
    !view.jobs.some(
      (job) =>
        job.laneId === reviewLane.id &&
        ["queued", "claimed", "submitted"].includes(job.status),
    ) &&
    view.readiness.records[reviewLane.id]?.revision !== undefined &&
    [...view.jobs]
      .reverse()
      .find((job) => job.laneId === reviewLane.id && job.status === "accepted")
      ?.id === review.id;
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<{
    job: LaneJob;
    action: "accept" | "reject";
    body: object;
    confirmationHash: string;
    requestId: string;
  } | null>(null);
  const [assembly, setAssembly] = useState<{
    stateHash: string;
    revision: number;
    confirmationHash: string;
    requestId: string;
  } | null>(null);
  const request = <T,>(suffix: string, method = "GET", body?: object) =>
    questionnaireRequest<T>(basePath, `${path}${suffix}`, method, body);
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<View>(
      basePath,
      `${path}/package/authoring`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setView(value);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("package.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, packageId, reload]);
  useEffect(() => {
    const timer = setInterval(() => setReload((r) => r + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  async function run(action: () => Promise<void>, inDialog = false) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setDialogFailure(null);
    try {
      await action();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("package.failed");
      if (inDialog)
        setDialogFailure({
          message,
          findings: error instanceof QuestionnaireError ? error.findings : [],
        });
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(job: LaneJob, action: "accept" | "reject") {
    const body =
      action === "accept"
        ? { revision: job.revision, ...(job.review?.result ?? job.result) }
        : { revision: job.revision, reason };
    const { preview } = await request<{
      preview: { confirmationHash: string };
    }>(
      `/drafting-jobs/${encodeURIComponent(job.id)}/${action}-preview`,
      "POST",
      body,
    );
    setDecision({
      job,
      action,
      body,
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    });
  }
  const refresh = () => {
    setReload((r) => r + 1);
    onChanged();
  };
  const laneRows = view
    ? Object.values(view.readiness.lanes).map((lane) => {
        const jobs = view.jobs
          .filter((job) => job.laneId === lane.id)
          .reverse();
        const job =
          jobs.find(({ status }) =>
            ["queued", "claimed", "submitted"].includes(status),
          ) ?? jobs[0];
        const record = view.readiness.records[lane.id];
        return {
          ...lane,
          job,
          earlierJobs: jobs.filter((entry) => entry.id !== job?.id),
          sessionRevision: record?.revision,
          queuedRepair:
            job?.status === "queued" &&
            view.followUps.some(({ repairJobId }) => repairJobId === job.id),
          repairRequirement: record?.action?.requirement,
          bug: record?.action?.kind === "bug" ? record.action : null,
        };
      })
    : [];
  const jobStatus = (status: LaneJob["status"]) =>
    status === "submitted"
      ? t("authoring.submitted")
      : t(`drafting.state.${status}`);
  const openReport = (job: LaneJob) => {
    setDialogFailure(null);
    setReview({ ...job, result: reportResult(job) });
    setReason("");
  };
  const target =
    decision?.action === "accept"
      ? decision.job.result?.laneOutput.action?.target
      : undefined;
  const dialogAlert = dialogFailure && (
    <Alert
      type="error"
      showIcon
      title={dialogFailure.message}
      description={
        dialogFailure.findings.length > 0 && (
          <ul>
            {dialogFailure.findings.map(({ message }, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        )
      }
    />
  );
  return (
    <section
      className="authoring-panel"
      aria-labelledby="authoring-title"
      data-testid="workflow-authoring"
    >
      <h3 id="authoring-title" className="sr-only">
        {t("authoring.title")}
      </h3>
      <div className="workflow-card-heading">
        <Space wrap>
          {canManage && view?.current && (
            <Button
              disabled={
                busy ||
                regenerationRequired ||
                view.readiness.status === "assembled"
              }
              onClick={() =>
                void run(async () => {
                  await request("/package/authoring-jobs", "POST", {
                    confirmed: true,
                  });
                  refresh();
                })
              }
            >
              {t("authoring.request")}
            </Button>
          )}
          {canManage && view?.current && (
            <Button
              type="primary"
              disabled={
                busy ||
                view.readiness.state !== "ready" ||
                view.readiness.status === "assembled"
              }
              onClick={() =>
                void run(async () => {
                  const { preview } = await request<{
                    preview: Omit<NonNullable<typeof assembly>, "requestId">;
                  }>("/package/assemble-preview", "POST", {});
                  setAssembly({ ...preview, requestId: crypto.randomUUID() });
                })
              }
            >
              {t("authoring.assemble")}
            </Button>
          )}
          <ReloadRecordsButton disabled={busy} onClick={refresh} />
          <StageReviewGuidance stage="package" />
        </Space>
      </div>
      {regenerationRequired ? (
        <Alert type="info" showIcon title={t("authoring.regenerateHelp")} />
      ) : (
        <p className="muted">{t("authoring.help")}</p>
      )}
      {failure && <Alert type="error" showIcon title={failure} />}
      {view && (
        <>
          <Tag>
            {view.readiness.status === "assembled"
              ? t("authoring.assembled")
              : `${view.readiness.completedLanes.length}/6`}
          </Tag>
          <Table
            className="authoring-lanes-table"
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={laneRows}
            expandable={{
              rowExpandable: (lane) =>
                lane.sessionRevision !== undefined ||
                Boolean(lane.job?.decision?.decision?.reason) ||
                lane.earlierJobs.length > 0,
              expandedRowRender: (lane) => (
                <>
                  {lane.sessionRevision !== undefined && (
                    <dl className="gate-hashes">
                      <dt>{t("authoring.revision")}</dt>
                      <dd>{lane.sessionRevision}</dd>
                    </dl>
                  )}
                  {lane.job?.decision?.decision?.reason && (
                    <dl className="gate-hashes">
                      <dt>{t("authoring.reason")}</dt>
                      <dd>{lane.job.decision.decision.reason}</dd>
                    </dl>
                  )}
                  {lane.earlierJobs.length > 0 && (
                    <>
                      <h4>{t("authoring.earlierJobs")}</h4>
                      <ul className="gate-pins">
                        {lane.earlierJobs.map((job) => (
                          <li key={job.id}>
                            <Space wrap>
                              <Tag>{jobStatus(job.status)}</Tag>
                              <time dateTime={job.createdAt}>
                                {new Date(job.createdAt).toLocaleString(locale)}
                              </time>
                            </Space>
                            {job.decision?.decision?.reason && (
                              <p>{job.decision.decision.reason}</p>
                            )}
                            {reportResult(job) && (
                              <Button onClick={() => openReport(job)}>
                                {t("authoring.viewReport")}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ),
            }}
            columns={[
              { title: t("package.lane"), dataIndex: "id", rowScope: "row" },
              {
                title: t("authoring.status"),
                render: (_, lane) => (
                  <>
                    <Tag>{lane.status}</Tag>
                    {lane.status === "DONE_WITH_CONCERNS" && lane.summary && (
                      <p>{lane.summary}</p>
                    )}
                    {lane.blockers.length > 0 && (
                      <details>
                        <summary>{t("authoring.blockers")}</summary>
                        <ul>
                          {lane.blockers.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ),
              },
              {
                title: t("authoring.jobStatus"),
                render: (_, { job, queuedRepair, repairRequirement, bug }) => {
                  if (!job)
                    return (
                      <span className="muted">{t("authoring.noJob")}</span>
                    );
                  const result = reportResult(job);
                  const canCopy =
                    canManage &&
                    view.current &&
                    !regenerationRequired &&
                    ["submitted", "queued"].includes(job.status);
                  return (
                    <Space orientation="vertical" size="small">
                      <Space wrap size={[4, 4]}>
                        <Tag>{jobStatus(job.status)}</Tag>
                        {job.kind === "review-vote" && (
                          <span>{t("authoring.reviewVote")}</span>
                        )}
                        {result &&
                          ["claimed", "submitted"].includes(job.status) && (
                            <span className="muted">
                              {format("authoring.draftOutcome", {
                                status: result.laneOutput.status,
                              })}
                            </span>
                          )}
                      </Space>
                      {bug && (
                        <Alert
                          type="warning"
                          showIcon
                          title={
                            bug.area
                              ? format("authoring.badgerIssueArea", {
                                  area: t(`authoring.area.${bug.area}`),
                                })
                              : t("authoring.badgerBug")
                          }
                          description={
                            <>
                              <div>{bug.requirement}</div>
                              <div>{bug.prompt}</div>
                            </>
                          }
                        />
                      )}
                      {canManage && queuedRepair && (
                        <Alert
                          type="info"
                          showIcon
                          title={t("authoring.repairNeedsDispatch")}
                          description={
                            <>
                              {repairRequirement && (
                                <div>{repairRequirement}</div>
                              )}
                              <div>{t("authoring.dispatchRepairHelp")}</div>
                            </>
                          }
                        />
                      )}
                      {(canCopy || result) && (
                        <Space wrap>
                          {result && (
                            <Button onClick={() => openReport(job)}>
                              {t(
                                canManage &&
                                  view.current &&
                                  !regenerationRequired &&
                                  job.status === "submitted"
                                  ? "authoring.inspect"
                                  : "authoring.viewReport",
                              )}
                            </Button>
                          )}
                          {canCopy && (
                            <AgentPromptButton
                              key={job.id}
                              basePath={basePath}
                              path={`${path}/drafting-jobs/${job.id}/prompt`}
                            />
                          )}
                        </Space>
                      )}
                    </Space>
                  );
                },
              },
            ]}
          />
          {view.planRepairs?.map((repair) => (
            <Space key={repair.id} wrap>
              <Link
                to={{
                  search: new URLSearchParams({
                    planDraft: repair.id,
                  }).toString(),
                  hash: "plan",
                }}
              >
                {t(`plan.repair.${repair.wave}`)}
              </Link>
              <Tag>
                {t(
                  `drafting.state.${repair.status}` as "drafting.state.queued",
                )}
              </Tag>
              {canManage && ["queued", "submitted"].includes(repair.status) && (
                <AgentPromptButton
                  basePath={basePath}
                  path={path + "/drafting-jobs/" + repair.id + "/prompt"}
                />
              )}
            </Space>
          ))}
          {view.followUps.length > 0 && (
            <>
              <h4>{t("authoring.followUps")}</h4>
              <ul>
                {view.followUps.map((item) => (
                  <li key={item.jobId}>
                    {item.laneId}:{" "}
                    {item.stage === "plan" &&
                    !item.planDraftId &&
                    view.current ? (
                      t("plan.waitingReports")
                    ) : item.questionId ? (
                      <Link
                        to={`/questionnaire/questions/${encodeURIComponent(item.questionId)}`}
                      >
                        {t("authoring.question")}
                      </Link>
                    ) : item.stage ? (
                      <Link to={followUpLocation(item.jobId, item)}>
                        {item.planDraftId
                          ? t("authoring.openPlanDraft")
                          : format("authoring.openStageFinding", {
                              stage: t(stageLabels[item.stage]),
                            })}
                      </Link>
                    ) : (
                      <span>
                        {t("authoring.repair")} <code>{item.repairJobId}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <Modal
        open={!!review}
        title={`${review?.laneId ?? ""} · ${t("authoring.report")}`}
        onCancel={() => {
          if (busy) return;
          setReview(null);
          setDialogFailure(null);
        }}
        footer={
          canReviewSelected ? (
            <Space>
              <Button
                disabled={busy || !reason.trim()}
                onClick={() =>
                  review && void run(() => preview(review, "reject"), true)
                }
              >
                {t("authoring.reject")}
              </Button>
              <Button
                type="primary"
                disabled={busy}
                onClick={() =>
                  review && void run(() => preview(review, "accept"), true)
                }
              >
                {t("authoring.accept")}
              </Button>
            </Space>
          ) : canReviseSelected ? (
            <Button
              type="primary"
              loading={busy}
              onClick={() => {
                const revision =
                  view?.readiness.records[reviewLane.id]?.revision;
                void run(async () => {
                  await request("/package/authoring-jobs", "POST", {
                    confirmed: true,
                    lane: reviewLane.id,
                    authoringRevision: revision,
                  });
                  setReview(null);
                  refresh();
                }, true);
              }}
            >
              {t("authoring.requestRevision")}
            </Button>
          ) : null
        }
        width={860}
      >
        {!decision && dialogAlert}
        <Tag>{review?.result?.laneOutput.status}</Tag>
        <p>{review?.result?.laneOutput.summary}</p>
        {!!review?.result?.laneOutput.findings?.length && (
          <>
            <h4>{t("authoring.findings")}</h4>
            <ul className="gate-pins">
              {review.result.laneOutput.findings.map((finding, index) => (
                <li key={index}>
                  <Tag>{t(`authoring.severity.${finding.severity}`)}</Tag>
                  {finding.path && <code>{finding.path}</code>}
                  <p>{finding.problem}</p>
                  {finding.impact && <p>{finding.impact}</p>}
                  {finding.claim && (
                    <p>
                      <code>{finding.claim}</code>
                    </p>
                  )}
                  {finding.evidence?.map((entry, i) => (
                    <p key={i}>{entry}</p>
                  ))}
                  <p>
                    {format("authoring.owner", {
                      owner:
                        finding.owner ??
                        (finding.evaluationCheck
                          ? t("stage.evaluation")
                          : t("authoring.engineer")),
                    })}
                  </p>
                  {finding.fix && <p>{finding.fix}</p>}
                  {finding.evaluationCheck && (
                    <Link to={{ hash: "evaluation" }}>
                      {format("authoring.evaluationCheck", {
                        check: finding.evaluationCheck,
                      })}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {canReviseSelected && <p>{t("authoring.requestRevisionHelp")}</p>}
        {reviewFollowUp?.stage && (
          <Link
            to={followUpLocation(reviewFollowUp.jobId, reviewFollowUp)}
            onClick={() => setReview(null)}
          >
            {format("authoring.openStageFinding", {
              stage: t(stageLabels[reviewFollowUp.stage]),
            })}
          </Link>
        )}
        <Collapse
          items={[
            {
              key: "claims",
              label: t("authoring.claims"),
              children: (
                <ul>
                  {review?.result?.laneOutput.claims?.map((claim) => (
                    <li key={claim.id}>
                      <strong>{claim.id}</strong> · {claim.status}
                      {claim.summary && <p>{claim.summary}</p>}
                      {claim.evidence?.map((entry, index) => (
                        <p key={index}>{entry}</p>
                      ))}
                    </li>
                  ))}
                </ul>
              ),
            },
            ...(review?.result?.laneOutput.artifacts ?? []).map((artifact) => ({
              key: artifact.path,
              label: artifact.path,
              children: (
                <pre className="package-file-preview">{artifact.content}</pre>
              ),
            })),
            ...(review?.result?.laneOutput.review
              ? [
                  {
                    key: "vote",
                    label: t("authoring.reviewVote"),
                    children: (
                      <pre className="package-file-preview">
                        {JSON.stringify(
                          review.result.laneOutput.review,
                          null,
                          2,
                        )}
                      </pre>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {review?.result?.laneOutput.action && (
          <Alert
            type="info"
            title={review.result.laneOutput.action.prompt}
            description={review.result.laneOutput.action.requirement}
          />
        )}
        {canReviewSelected && (
          <>
            <label className="field-label" htmlFor="authoring-rejection-reason">
              {t("authoring.reason")}
            </label>
            <Input.TextArea
              id="authoring-rejection-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={8000}
            />
          </>
        )}
      </Modal>
      <Modal
        open={!!decision}
        title={t("authoring.confirmDecision")}
        confirmLoading={busy}
        okText={t(
          target?.stage === "plan"
            ? "authoring.confirmOpenPlan"
            : "authoring.confirm",
        )}
        onCancel={() => {
          if (busy) return;
          setDecision(null);
          setDialogFailure(null);
        }}
        onOk={() =>
          decision &&
          void run(async () => {
            const { job } = await request<{ job: LaneJob }>(
              `/drafting-jobs/${encodeURIComponent(decision.job.id)}/${decision.action}`,
              "POST",
              {
                ...decision.body,
                confirmed: true,
                confirmationHash: decision.confirmationHash,
                requestId: decision.requestId,
              },
            );
            setDecision(null);
            setReview(null);
            refresh();
            if (job.decision?.followUp)
              navigate(followUpLocation(job.id, job.decision.followUp));
          }, true)
        }
      >
        {dialogAlert}
        {target && (
          <p>
            {target.stage === "plan"
              ? t("authoring.confirmPlanDraftHelp")
              : format("authoring.confirmStageFindingHelp", {
                  stage: t(stageLabels[target.stage]),
                })}
          </p>
        )}
        {decision?.action === "accept" &&
          decision.job.result?.laneOutput.action?.kind === "bug" && (
            <p>{t("authoring.confirmBugHelp")}</p>
          )}
        <p>
          {decision?.job.laneId} ·{" "}
          {decision?.action === "accept"
            ? t("authoring.accept")
            : t("authoring.reject")}
        </p>
        {decision?.action === "accept" &&
          decision.job.result?.laneOutput.findings?.some(
            (finding) => finding.evaluationCheck,
          ) && <p>{t("authoring.evaluationConfirm")}</p>}
        <code>{decision?.confirmationHash}</code>
      </Modal>
      <Modal
        open={!!assembly}
        title={t("authoring.confirmAssembly")}
        confirmLoading={busy}
        okText={t("authoring.confirm")}
        onCancel={() => {
          if (busy) return;
          setAssembly(null);
          setDialogFailure(null);
        }}
        onOk={() =>
          assembly &&
          void run(async () => {
            await request("/package/assemble", "POST", {
              confirmed: true,
              confirmationHash: assembly.confirmationHash,
              requestId: assembly.requestId,
            });
            setAssembly(null);
            refresh();
          }, true)
        }
      >
        {dialogAlert}
        <p>{t("authoring.assemblyHelp")}</p>
        <dl className="gate-hashes">
          <dt>{t("authoring.revision")}</dt>
          <dd>{assembly?.revision}</dd>
          <dt>{t("proposal.currentState")}</dt>
          <dd>
            <code>{assembly?.stateHash}</code>
          </dd>
        </dl>
      </Modal>
    </section>
  );
}
