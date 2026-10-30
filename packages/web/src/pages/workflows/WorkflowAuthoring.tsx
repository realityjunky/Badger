import { Alert, Button, Collapse, Input, Modal, Space, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AuthoringReadiness,
  AuthoringLaneOutput,
} from "@realityjunky/badger";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

type LaneJob = {
  id: string;
  laneId: string;
  kind: string;
  status: string;
  revision: number;
  result: { laneOutput: AuthoringLaneOutput } | null;
  decision: {
    decision?: { reason?: string };
    authoringRevision?: number;
  } | null;
};
type View = {
  current: boolean;
  readiness: AuthoringReadiness;
  jobs: LaneJob[];
  followUps: {
    laneId: string;
    questionId: string | null;
    repairJobId: string | null;
  }[];
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
  const { t } = useI18n();
  const [view, setView] = useState<View | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<LaneJob | null>(null);
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
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("package.failed"));
    } finally {
      setBusy(false);
    }
  }
  async function preview(job: LaneJob, action: "accept" | "reject") {
    const body =
      action === "accept"
        ? { revision: job.revision, ...job.result }
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
  return (
    <section
      className="authoring-panel"
      aria-labelledby="authoring-title"
      data-testid="workflow-authoring"
    >
      <div className="workflow-card-heading">
        <h3 id="authoring-title">{t("authoring.title")}</h3>
        <Space wrap>
          {canManage && view?.current && (
            <Button
              disabled={busy || view.readiness.status === "assembled"}
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
          <Button disabled={busy} onClick={refresh}>
            {t("workflow.reload")}
          </Button>
        </Space>
      </div>
      <p className="muted">{t("authoring.help")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {view && (
        <>
          <Tag>
            {view.readiness.status === "assembled"
              ? t("authoring.assembled")
              : `${view.readiness.completedLanes.length}/6`}
          </Tag>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={Object.values(view.readiness.lanes)}
            columns={[
              { title: t("package.lane"), dataIndex: "id" },
              {
                title: t("authoring.status"),
                render: (_, lane) => (
                  <>
                    <Tag>{lane.status}</Tag>
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
                title: t("authoring.revision"),
                render: (_, lane) =>
                  view.readiness.records[lane.id]?.revision ?? "—",
              },
            ]}
          />
          <h4>{t("authoring.jobs")}</h4>
          <ul className="gate-pins">
            {view.jobs.map((job) => (
              <li key={job.id}>
                <Space wrap>
                  <strong>{job.laneId}</strong>
                  <Tag>
                    {job.kind === "review-vote"
                      ? t("authoring.reviewVote")
                      : t("authoring.laneDraft")}
                  </Tag>
                  <Tag>{job.status}</Tag>
                  {canManage && job.status === "submitted" && (
                    <Button
                      onClick={() => {
                        setReview(job);
                        setReason("");
                      }}
                    >
                      {t("authoring.inspect")}
                    </Button>
                  )}
                </Space>
                {job.decision?.decision?.reason && (
                  <p>{job.decision.decision.reason}</p>
                )}
              </li>
            ))}
          </ul>
          {view.followUps.length > 0 && (
            <>
              <h4>{t("authoring.followUps")}</h4>
              <ul>
                {view.followUps.map((item, i) => (
                  <li key={i}>
                    {item.laneId}:{" "}
                    {item.questionId ? (
                      <Link
                        to={`/questionnaire/questions/${encodeURIComponent(item.questionId)}`}
                      >
                        {t("authoring.question")}
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
        title={`${review?.laneId ?? ""} — ${t("authoring.inspect")}`}
        onCancel={() => !busy && setReview(null)}
        footer={
          <Space>
            <Button
              disabled={busy || !reason.trim()}
              onClick={() =>
                review && void run(() => preview(review, "reject"))
              }
            >
              {t("authoring.reject")}
            </Button>
            <Button
              type="primary"
              disabled={busy}
              onClick={() =>
                review && void run(() => preview(review, "accept"))
              }
            >
              {t("authoring.accept")}
            </Button>
          </Space>
        }
        width={860}
      >
        <Tag>{review?.result?.laneOutput.status}</Tag>
        <p>{review?.result?.laneOutput.summary}</p>
        <Collapse
          items={[
            {
              key: "claims",
              label: t("authoring.claims"),
              children: (
                <ul>
                  {review?.result?.laneOutput.claims?.map((claim) => (
                    <li key={claim.id}>
                      <strong>{claim.id}</strong>: {claim.summary}
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
        <label className="field-label" htmlFor="authoring-rejection-reason">
          {t("authoring.reason")}
        </label>
        <Input.TextArea
          id="authoring-rejection-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={8000}
        />
      </Modal>
      <Modal
        open={!!decision}
        title={t("authoring.confirmDecision")}
        confirmLoading={busy}
        okText={t("authoring.confirm")}
        onCancel={() => !busy && setDecision(null)}
        onOk={() =>
          decision &&
          void run(async () => {
            await request(
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
          })
        }
      >
        <p>
          {decision?.job.laneId} ·{" "}
          {decision?.action === "accept"
            ? t("authoring.accept")
            : t("authoring.reject")}
        </p>
        <code>{decision?.confirmationHash}</code>
      </Modal>
      <Modal
        open={!!assembly}
        title={t("authoring.confirmAssembly")}
        confirmLoading={busy}
        okText={t("authoring.confirm")}
        onCancel={() => !busy && setAssembly(null)}
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
          })
        }
      >
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
