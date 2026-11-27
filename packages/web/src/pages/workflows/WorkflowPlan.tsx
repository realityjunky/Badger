import { InfoCircleOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ReloadRecordsButton } from "../../components/ReloadRecordsButton.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { useLiveUpdates } from "../../live/LiveUpdatesContext.js";
import { ConfirmationHistory } from "../../components/ConfirmationHistory.js";
import { PlanContent, PlanTabs } from "./PlanContent.js";
import { PlanEditor } from "./PlanEditor.js";
import { WorkflowPanel } from "./WorkflowPanel.js";
import { WorkflowProposal } from "./WorkflowProposal.js";
import { StageReviewGuidance } from "../../components/StageReviewGuidance.js";
import { selectedWorkflowTab } from "./WorkflowTabs.js";
import { PlanDraftingJobs } from "./PlanDraftingJobs.js";
import { AuthoringStageFinding } from "./AuthoringStageFinding.js";

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
  const { connected, notice } = useLiveUpdates();
  const location = useLocation();
  const navigate = useNavigate();
  const active = ["plan", "proposal"].includes(selectedWorkflowTab(location));
  const section = useRef<HTMLElement>(null);
  const [view, setView] = useState<PlanView | null>(null);
  const [jobs, setJobs] = useState<PlanDraftingJob[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
  const [deleting, setDeleting] = useState<PlanDraftingJob | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  const params = new URLSearchParams(location.search);
  const selectedId = params.get("planVersion");
  const draftId = params.get("planDraft");
  const findingId = params.get("authoringFinding");
  const tab = params.get("planTab");
  function selectTab(key: string) {
    if (key === "jobs") params.delete("planTab");
    else params.set("planTab", key);
    navigate({ search: params.toString(), hash: "#plan" });
  }
  const selectedDraft = jobs.find((job) => job.id === draftId);
  const selected =
    view?.versions.find((v) => v.id === selectedId) ??
    view?.versions.find((v) => v.id === view.headVersionId);
  const superseded = !!selected && selected.id !== view?.currentVersionId;
  const approved =
    !!selected &&
    !superseded &&
    view?.confirmation?.invalidatedAt === null &&
    view.confirmation.boundHashes.plan === selected.hash;
  useEffect(() => {
    if (!active) return;
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
    active,
    basePath,
    path,
    detail.version.revision,
    detail.capabilities.editPlan,
    refresh,
  ]);
  useEffect(() => {
    if (active && notice.versionIds.includes(detail.version.id))
      setRefresh((value) => value + 1);
  }, [active, detail.version.id, notice]);
  useEffect(() => {
    if (!active || connected) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, connected]);
  useEffect(() => {
    if (location.hash === "#plan" && !params.has("planTab") && !draftId && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);
  const revealDraft = useCallback(
    (row: HTMLLIElement | null) => {
      if (!active || !row || (tab && tab !== "jobs")) return;
      const history = row.closest<HTMLDetailsElement>("details");
      if (history) history.open = true;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "center" });
    },
    [active, tab],
  );

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
  async function requestDraft() {
    await questionnaireRequest(basePath, `${path}/drafting-jobs`, "POST", {
      kind: "draft-plan",
      confirmed: true,
    });
    if (tab && tab !== "jobs") selectTab("jobs");
    await changed();
  }
  async function requestRepair(job: PlanDraftingJob) {
    const { job: repair } = await questionnaireRequest<{
      job: PlanDraftingJob;
    }>(
      basePath,
      path + "/drafting-jobs/" + job.id + "/request-plan-repair",
      "POST",
      { revision: job.revision, confirmed: true },
    );
    navigate({
      search: new URLSearchParams({ planDraft: repair.id }).toString(),
      hash: "#plan",
    });
    await changed();
  }
  async function deleteDraft() {
    if (!deleting) return;
    const { id, revision } = deleting;
    await questionnaireRequest(
      basePath,
      `${path}/drafting-jobs/${encodeURIComponent(id)}`,
      "DELETE",
      { revision, confirmed: true },
    );
    setJobs((current) => current.filter((job) => job.id !== id));
    setDeleting(null);
    if (draftId === id) {
      params.delete("planDraft");
      navigate({ search: params.toString(), hash: "#plan" }, { replace: true });
    }
    await changed();
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
  function askForDraftChanges(job: PlanDraftingJob) {
    setFailure(null);
    setDiscard({ job, reason: "", requestId: crypto.randomUUID() });
  }
  async function discardSuggestion() {
    if (!discard) return;
    const body = { revision: discard.job.revision, reason: discard.reason };
    if (discard.job.planRepair) {
      await questionnaireRequest(
        basePath,
        path + "/drafting-jobs/" + discard.job.id + "/return-plan",
        "POST",
        { ...body, confirmed: true },
      );
      setDiscard(null);
      setEditing(null);
      navigate({
        search: new URLSearchParams({ planDraft: discard.job.id }).toString(),
        hash: "plan",
      });
      await changed();
      return;
    }
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
    <WorkflowPanel
      title={t("stage.planProposal")}
      hideHeading
      showGuidance={false}
      ref={section}
      id="plan"
      data-testid="workflow-plan"
      aria-labelledby="plan-title"
    >
      <div className="proposal-toolbar">
        <StageReviewGuidance stage="plan-proposal" />
        <Space size={2}>
          <Tooltip
            title={t("proposal.description")}
            trigger={["hover", "focus", "click"]}
          >
            <Button
              type="text"
              aria-label={t("proposal.about")}
              icon={<InfoCircleOutlined aria-hidden="true" />}
            />
          </Tooltip>
          <ReloadRecordsButton
            disabled={busy}
            onClick={() => {
              setFailure(null);
              setRefresh((value) => value + 1);
            }}
          />
        </Space>
      </div>
      <section className="proposal-action-row" aria-label={t("plan.title")}>
        <div className="proposal-action-controls">
          <h3>{t("plan.title")}</h3>
          {view?.skeleton && detail.capabilities.editPlan && (
            <>
              <Space size={4} align="start">
                <Button loading={busy} onClick={() => void run(requestDraft)}>
                  {t("plan.request")}
                </Button>
                <Tooltip
                  title={t("plan.requestHelp")}
                  trigger={["hover", "focus"]}
                  placement="topRight"
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={t("drafting.about")}
                    icon={<InfoCircleOutlined aria-hidden="true" />}
                  />
                </Tooltip>
              </Space>
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
          {selected &&
            detail.capabilities.approvePlan &&
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
        </div>
        <div className="proposal-action-info plan-action-info">
          {!selectedDraft && (
            <AuthoringStageFinding
              basePath={basePath}
              path={path}
              stage="plan"
            />
          )}
          {failure && !deleting && (
            <Alert type="error" showIcon title={failure} />
          )}
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
              {selected && (
                <>
                  <Space wrap className="dossier-version-heading">
                    <Select
                      aria-label={t("plan.version")}
                      value={selected.id}
                      options={view.versions.map((v) => ({
                        value: v.id,
                        label: format("plan.versionNumber", {
                          number: v.number,
                        }),
                      }))}
                      onChange={(id) => {
                        const params = new URLSearchParams(location.search);
                        params.set("planVersion", id);
                        navigate({ search: params.toString(), hash: "#plan" });
                      }}
                    />
                    <Tag
                      color={
                        superseded
                          ? "warning"
                          : approved
                            ? "success"
                            : "processing"
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
                  </Space>
                  {superseded && (
                    <Alert
                      type="warning"
                      showIcon
                      title={t("plan.supersededHelp")}
                    />
                  )}
                  <ConfirmationHistory
                    confirmations={view.confirmations}
                    bound={{ name: "plan", hash: selected.hash }}
                  />
                </>
              )}
              <PlanTabs version={selected} tab={tab} onTab={selectTab}>
                {detail.capabilities.editPlan && jobs.length > 0 ? (
                  <PlanDraftingJobs
                    jobs={jobs}
                    basePath={basePath}
                    path={path}
                    selectedId={draftId}
                    selectedRow={revealDraft}
                    selectedFinding={
                      findingId && (
                        <AuthoringStageFinding
                          basePath={basePath}
                          path={path}
                          stage="plan"
                        />
                      )
                    }
                    busy={busy}
                    hasSkeleton={!!view.skeleton}
                    onRequestRepair={(job) =>
                      void run(() => requestRepair(job))
                    }
                    onReview={(job, plan) => setEditing({ job, plan })}
                    onDiscard={askForDraftChanges}
                    onDelete={(job) => {
                      setFailure(null);
                      setDeleting(job);
                    }}
                  />
                ) : (
                  <p className="empty-state">
                    {t(
                      detail.capabilities.editPlan
                        ? "plan.noDrafts"
                        : "plan.draftsRestricted",
                    )}
                  </p>
                )}
              </PlanTabs>
              {editing && (
                <PlanEditor
                  key={editing.job?.id ?? "plan-editor"}
                  basePath={basePath}
                  path={path}
                  view={view}
                  initialPlan={editing.plan}
                  job={editing.job}
                  onClose={() => setEditing(null)}
                  returning={!!discard}
                  onReturnToAgent={askForDraftChanges}
                  onSaved={() => {
                    setEditing(null);
                    void changed();
                  }}
                />
              )}
            </>
          )}
        </div>
      </section>
      <WorkflowProposal
        basePath={basePath}
        detail={detail}
        active={active}
        planRefresh={refresh}
        approvedPlanHash={approved ? selected?.hash : undefined}
        historical={
          !!selected &&
          !!view?.headVersionId &&
          selected.id !== view.headVersionId
        }
        onChanged={onChanged}
      />
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
        title={t(
          discard?.job.planRepair
            ? "plan.sendBack"
            : discard?.hash
              ? "drafting.preview"
              : "drafting.discard",
        )}
        okText={t(
          discard?.job.planRepair
            ? "plan.sendBack"
            : discard?.hash
              ? "drafting.discard"
              : "drafting.preview",
        )}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !discard?.reason.trim() }}
        onCancel={() => {
          if (!busy) setDiscard(null);
        }}
        onOk={() => void run(discardSuggestion)}
      >
        {discard?.job.planRepair && <p>{t("plan.returnHelp")}</p>}
        <label className="field-label" htmlFor="plan-discard-reason">
          {t(discard?.job.planRepair ? "plan.feedback" : "drafting.reason")}
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
      <Modal
        open={deleting !== null}
        title={t("plan.confirmDeleteDraft")}
        okText={t("plan.deleteDraft")}
        okButtonProps={{ danger: true }}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        onCancel={() => {
          if (busy) return;
          setDeleting(null);
          setFailure(null);
        }}
        onOk={() => void run(deleteDraft)}
      >
        <p className="plan-draft-id">
          <code>{deleting?.id}</code>
        </p>
        {failure && <Alert type="error" showIcon title={failure} />}
      </Modal>
    </WorkflowPanel>
  );
}
