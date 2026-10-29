import { Alert, Button, Input, Modal, Select, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { FactoryPlan, PlanView } from "../../api/plans.js";
import type {
  AnyDraftingJob,
  PlanDraftingJob,
} from "../../api/drafting-jobs.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { PlanContent } from "./PlanContent.js";
import { PlanEditor } from "./PlanEditor.js";

export function WorkflowPlan({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t, format } = useI18n();
  const inbox = useInbox();
  const location = useLocation();
  const navigate = useNavigate();
  const section = useRef<HTMLElement>(null);
  const [view, setView] = useState<PlanView | null>(null);
  const [jobs, setJobs] = useState<PlanDraftingJob[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [editing, setEditing] = useState<{
    plan: FactoryPlan;
    job?: PlanDraftingJob;
  } | null>(null);
  const [approval, setApproval] = useState<{
    preview: GatePreview;
    versionId: string;
    requestId: string;
  } | null>(null);
  const [discard, setDiscard] = useState<{
    job: PlanDraftingJob;
    reason: string;
    hash?: string;
    requestId: string;
  } | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  const selectedId = new URLSearchParams(location.search).get("planVersion");
  const selected =
    view?.versions.find((v) => v.id === selectedId) ?? view?.versions[0];
  const superseded = !!selected && selected.id !== view?.currentVersionId;
  const approved =
    !!selected &&
    !superseded &&
    view?.confirmation?.invalidatedAt === null &&
    view.confirmation.boundHashes.plan === selected.hash;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      questionnaireRequest<PlanView>(
        basePath,
        `${path}/plan`,
        "GET",
        undefined,
        controller.signal,
      ),
      detail.capabilities.editPlan
        ? questionnaireRequest<{ jobs: AnyDraftingJob[] }>(
            basePath,
            `${path}/drafting-jobs`,
            "GET",
            undefined,
            controller.signal,
          )
        : Promise.resolve({ jobs: [] }),
    ]).then(
      ([plan, drafting]) => {
        if (!controller.signal.aborted) {
          setView(plan);
          setJobs(
            drafting.jobs.filter(
              (job): job is PlanDraftingJob => job.kind === "draft-plan",
            ),
          );
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : t("plan.failed"));
      },
    );
    return () => controller.abort();
  }, [
    basePath,
    path,
    detail.version.revision,
    detail.capabilities.editPlan,
    refresh,
  ]);
  useEffect(() => {
    if (location.hash === "#plan" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);

  async function changed() {
    setRefresh((r) => r + 1);
    await inbox.refresh();
    onChanged();
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("plan.failed"));
    } finally {
      setBusy(false);
    }
  }
  async function previewApproval() {
    if (!selected) return;
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/gates/plan/preview`,
      "POST",
      {},
    );
    if (preview.boundHashes.plan !== selected.hash) {
      setRefresh((r) => r + 1);
      throw new Error(t("plan.supersededHelp"));
    }
    setApproval({
      preview,
      versionId: selected.id,
      requestId: crypto.randomUUID(),
    });
  }
  async function approve() {
    if (!approval) return;
    await questionnaireRequest(basePath, `${path}/gates/plan/commit`, "POST", {
      confirmationHash: approval.preview.confirmationHash,
      requestId: approval.requestId,
    });
    setApproval(null);
    await changed();
  }
  async function discardSuggestion() {
    if (!discard) return;
    const body = { revision: discard.job.revision, reason: discard.reason };
    if (!discard.hash) {
      const { preview } = await questionnaireRequest<{
        preview: { confirmationHash: string };
      }>(
        basePath,
        `${path}/drafting-jobs/${discard.job.id}/reject-preview`,
        "POST",
        body,
      );
      setDiscard({ ...discard, hash: preview.confirmationHash });
    } else {
      await questionnaireRequest(
        basePath,
        `${path}/drafting-jobs/${discard.job.id}/reject`,
        "POST",
        {
          ...body,
          confirmationHash: discard.hash,
          requestId: discard.requestId,
          confirmed: true,
        },
      );
      setDiscard(null);
      await changed();
    }
  }
  const reviewed = view?.versions.find(
    (version) => version.id === approval?.versionId,
  );
  return (
    <section
      ref={section}
      id="plan"
      className="workflow-panel"
      data-testid="workflow-plan"
      aria-labelledby="plan-title"
    >
      <div className="workflow-card-heading">
        <h2 id="plan-title">{t("plan.title")}</h2>
        <Space wrap>
          {view?.skeleton && detail.capabilities.editPlan && (
            <>
              <Button disabled={busy} onClick={() => setRequesting(true)}>
                {t("plan.request")}
              </Button>
              <Button
                type="primary"
                disabled={busy}
                onClick={() =>
                  setEditing({
                    plan:
                      view.versions.find((v) => v.id === view.currentVersionId)
                        ?.snapshot.plan ?? view.skeleton!,
                  })
                }
              >
                {t("plan.edit")}
              </Button>
            </>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              setFailure(null);
              setRefresh((r) => r + 1);
            }}
          >
            {t("workflow.reload")}
          </Button>
        </Space>
      </div>
      <p className="muted">{t("plan.description")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {!view && !failure && <Spin aria-label={t("common.loading")} />}
      {view && (
        <>
          {!view.skeleton && (
            <Alert
              type="warning"
              showIcon
              title={t("plan.needDossier")}
              description={<Link to="#dossier">{t("dossier.title")}</Link>}
            />
          )}
          {!selected ? (
            <p className="empty-state">{t("plan.empty")}</p>
          ) : (
            <>
              <Space wrap className="dossier-version-heading">
                <Select
                  aria-label={t("plan.version")}
                  value={selected.id}
                  options={view.versions.map((v) => ({
                    value: v.id,
                    label: format("plan.versionNumber", { number: v.number }),
                  }))}
                  onChange={(id) => {
                    const params = new URLSearchParams(location.search);
                    params.set("planVersion", id);
                    navigate({ search: params.toString(), hash: "#plan" });
                  }}
                />
                <Tag
                  color={
                    superseded ? "warning" : approved ? "success" : "processing"
                  }
                >
                  {t(
                    superseded
                      ? "ledger.state.superseded"
                      : approved
                        ? "plan.approved"
                        : "dossier.awaiting",
                  )}
                </Tag>
                {detail.capabilities.approvePlan &&
                  !superseded &&
                  !approved && (
                    <Button
                      type="primary"
                      loading={busy}
                      onClick={() => void run(previewApproval)}
                    >
                      {t("plan.reviewApproval")}
                    </Button>
                  )}
              </Space>
              {superseded && (
                <Alert
                  type="warning"
                  showIcon
                  title={t("plan.supersededHelp")}
                />
              )}
              <PlanContent version={selected} />
            </>
          )}
          {detail.capabilities.editPlan && jobs.length > 0 && (
            <>
              <h3>{t("plan.suggestions")}</h3>
              <ul className="questionnaire-concerns">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <Space wrap>
                      <span>{t("plan.draft")}</span>
                      <Tag>{t(`drafting.state.${job.status}`)}</Tag>
                      {job.status === "submitted" && (
                        <>
                          <Button
                            disabled={busy || !view.skeleton}
                            onClick={() =>
                              setEditing({
                                plan: structuredClone(job.result!.plan),
                                job,
                              })
                            }
                          >
                            {t("plan.reviewSuggestion")}
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              setDiscard({
                                job,
                                reason: "",
                                requestId: crypto.randomUUID(),
                              })
                            }
                          >
                            {t("drafting.discard")}
                          </Button>
                        </>
                      )}
                    </Space>
                  </li>
                ))}
              </ul>
            </>
          )}
          {editing && (
            <PlanEditor
              key={editing.job?.id ?? "plan-editor"}
              basePath={basePath}
              path={path}
              view={view}
              initialPlan={editing.plan}
              job={editing.job}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void changed();
              }}
            />
          )}
        </>
      )}
      <Modal
        open={requesting}
        title={t("plan.request")}
        okText={t("plan.request")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        onCancel={() => {
          if (!busy) setRequesting(false);
        }}
        onOk={() =>
          void run(async () => {
            await questionnaireRequest(
              basePath,
              `${path}/drafting-jobs`,
              "POST",
              { kind: "draft-plan", confirmed: true },
            );
            setRequesting(false);
            await changed();
          })
        }
      >
        <p>{t("plan.requestHelp")}</p>
        {failure && <Alert type="error" title={failure} />}
      </Modal>
      <Modal
        open={approval !== null}
        width={900}
        title={t("plan.reviewApproval")}
        okText={t("plan.approve")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        onCancel={() => {
          if (!busy) setApproval(null);
        }}
        onOk={() => void run(approve)}
      >
        <p>{t("plan.approvalHelp")}</p>
        {reviewed && <PlanContent version={reviewed} />}
        {failure && <Alert type="error" title={failure} />}
      </Modal>
      <Modal
        open={discard !== null}
        title={t(discard?.hash ? "drafting.preview" : "drafting.discard")}
        okText={t(discard?.hash ? "drafting.discard" : "drafting.preview")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !discard?.reason.trim() }}
        onCancel={() => {
          if (!busy) setDiscard(null);
        }}
        onOk={() => void run(discardSuggestion)}
      >
        <label className="field-label" htmlFor="plan-discard-reason">
          {t("drafting.reason")}
        </label>
        <Input.TextArea
          id="plan-discard-reason"
          value={discard?.reason ?? ""}
          disabled={!!discard?.hash || busy}
          maxLength={4000}
          onChange={(event) => {
            if (discard) setDiscard({ ...discard, reason: event.target.value });
          }}
        />
        {failure && <Alert type="error" title={failure} />}
      </Modal>
    </section>
  );
}
