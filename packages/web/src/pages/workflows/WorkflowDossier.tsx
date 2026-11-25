import { Alert, Button, Modal, Select, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DossierView } from "../../api/dossier.js";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import { workingDossierPath } from "../../api/working-dossier.js";
import type { WorkingDossierView } from "@realityjunky/badger";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { ConfirmationHistory } from "../../components/ConfirmationHistory.js";
import { DossierComposer } from "./DossierComposer.js";
import { DossierContent } from "./DossierContent.js";
import { WorkflowPanel } from "./WorkflowPanel.js";
import { selectedWorkflowTab } from "./WorkflowTabs.js";
import {
  DossierReadiness,
  RemovedDossierFields,
} from "../working-dossier/DossierReadiness.js";
import { useWorkingDossier } from "../working-dossier/useWorkingDossier.js";

export function WorkflowDossier({
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
  const [view, setView] = useState<DossierView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [findings, setFindings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{
    preview: GatePreview;
    requestId: string;
    versionId?: string;
    dossier?: Pick<WorkingDossierView, "revision" | "pinsHash">;
  } | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  const dossierPath = workingDossierPath(detail.workflow.id, detail.version.id);
  const active = selectedWorkflowTab(location) === "dossier";
  const {
    dossier,
    failure: dossierFailure,
    reload,
  } = useWorkingDossier(basePath, dossierPath, detail.version.id, active);
  const working = dossier && !dossier.legacy;
  const selectedId = new URLSearchParams(location.search).get("dossierVersion");
  const selected =
    view?.versions.find((v) => v.id === selectedId) ??
    view?.versions.find((v) => v.id === view.headVersionId);
  const superseded =
    selected !== undefined && selected.id !== view?.currentVersionId;
  const approved =
    selected !== undefined &&
    view?.confirmation?.invalidatedAt === null &&
    view.confirmation.boundHashes.dossier === selected.hash;
  const currentVersion = view?.versions.find(
    ({ id }) => id === view?.currentVersionId,
  );
  const approvedRevision =
    currentVersion &&
    view?.confirmation?.invalidatedAt === null &&
    view.confirmation.boundHashes.dossier === currentVersion.hash &&
    currentVersion.snapshot.dossier.workingDossier?.revision ===
      dossier?.revision;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void questionnaireRequest<DossierView>(
      basePath,
      `${path}/dossier`,
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
            error instanceof Error ? error.message : t("dossier.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [active, basePath, path, detail.version.revision, dossier, refresh]);
  useEffect(() => {
    if (location.hash === "#dossier" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    setFindings([]);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("dossier.failed"));
      if (error instanceof QuestionnaireError)
        setFindings(error.findings.map(({ message }) => message));
      setReview(null);
      setRefresh((r) => r + 1);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (!working && !selected) return;
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/gates/dossier/preview`,
      "POST",
      {},
    );
    if (
      working &&
      !preview.records.some(
        ({ type, id }) =>
          type === "working-dossier-revision" &&
          id === String(dossier.revision),
      )
    ) {
      void reload();
      throw new Error(t("workingDossier.approvalChanged"));
    }
    if (!working && preview.boundHashes.dossier !== selected?.hash) {
      setRefresh((r) => r + 1);
      throw new Error(t("dossier.supersededHelp"));
    }
    setReview({
      preview,
      ...(working
        ? {
            dossier: { revision: dossier.revision, pinsHash: dossier.pinsHash },
          }
        : { versionId: selected?.id }),
      requestId: crypto.randomUUID(),
    });
  }
  async function approve() {
    if (!review) return;
    await questionnaireRequest(
      basePath,
      `${path}/gates/dossier/commit`,
      "POST",
      {
        confirmationHash: review.preview.confirmationHash,
        requestId: review.requestId,
      },
    );
    setReview(null);
    setRefresh((r) => r + 1);
    await inbox.refresh();
    onChanged();
  }
  const reviewed = view?.versions.find((v) => v.id === review?.versionId);
  const reviewDossier = review?.dossier;
  const reviewChanged =
    reviewDossier &&
    (reviewDossier.revision !== dossier?.revision ||
      reviewDossier.pinsHash !== dossier?.pinsHash);

  return (
    <WorkflowPanel
      title={t("dossier.title")}
      ref={section}
      id="dossier"
      data-testid="workflow-dossier"
      aria-labelledby="dossier-title"
      actions={
        view &&
        dossier?.legacy &&
        detail.capabilities.composeDossier && (
          <Button
            type="primary"
            disabled={busy || view.handoff.status !== "complete"}
            onClick={() => setEditing(true)}
          >
            {t("dossier.compose")}
          </Button>
        )
      }
    >
      {dossier && (
        <p className="muted">
          {t(
            working
              ? "workingDossier.approvalDescription"
              : "dossier.description",
          )}
        </p>
      )}
      {dossierFailure && (
        <Alert
          type="error"
          showIcon
          title={dossierFailure}
          action={
            <Button onClick={() => void reload()}>
              {t("workflow.reload")}
            </Button>
          }
        />
      )}
      {failure && (
        <Alert
          type="error"
          showIcon
          title={failure}
          description={
            findings.length > 1 && (
              <ul>
                {findings.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            )
          }
          action={
            <Button
              onClick={() => {
                setFailure(null);
                setFindings([]);
                void reload();
                setRefresh((r) => r + 1);
              }}
            >
              {t("workflow.reload")}
            </Button>
          }
        />
      )}
      {(!view || !dossier) && !failure && !dossierFailure && (
        <Spin aria-label={t("common.loading")} />
      )}
      {view && (
        <>
          <p>
            <Link
              to={`/questionnaire?workflow=${encodeURIComponent(detail.workflow.id)}&version=${encodeURIComponent(detail.version.id)}&panel=ledger`}
            >
              {t("ledger.title")}
            </Link>
          </p>
          {working && (
            <section
              className="working-dossier-approval"
              aria-label={t("workingDossier.title")}
            >
              <div className="working-dossier-toolbar">
                <h3>
                  {format("workingDossier.revision", {
                    revision: dossier.revision,
                  })}
                </h3>
                <Space wrap>
                  {approvedRevision && (
                    <Tag color="success">{t("dossier.approved")}</Tag>
                  )}
                  {!approvedRevision &&
                    detail.capabilities.approveDossier &&
                    dossier.available && (
                      <Button
                        type="primary"
                        loading={busy}
                        onClick={() => void run(preview)}
                      >
                        {t("dossier.reviewApproval")}
                      </Button>
                    )}
                </Space>
              </div>
              {!dossier.available && (
                <Alert
                  type="info"
                  showIcon
                  title={t("workingDossier.waitForCheck")}
                />
              )}
              <DossierReadiness dossier={dossier} />
              <RemovedDossierFields dossier={dossier} />
            </section>
          )}
          {dossier?.legacy && view.handoff.status !== "complete" && (
            <Alert
              className="dossier-readiness"
              type="warning"
              showIcon
              title={t("ledger.blocked")}
              description={
                <ul>
                  {view.handoff.readiness
                    .filter((r) => !r.ready)
                    .map((r) => (
                      <li key={r.topic}>
                        {t(`questionnaire.topic.${r.topic}`)}:{" "}
                        {r.blockers
                          .map((b) => t(`ledger.blocker.${b.code}`))
                          .join(" · ")}
                      </li>
                    ))}
                </ul>
              }
            />
          )}
          {!selected ? (
            dossier && (
              <p className="empty-state">
                {t(working ? "workingDossier.noApprovals" : "dossier.empty")}
              </p>
            )
          ) : (
            <>
              <Space wrap className="dossier-version-heading">
                <Select
                  aria-label={t("dossier.version")}
                  value={selected.id}
                  options={view.versions.map((v) => ({
                    value: v.id,
                    label: format("dossier.versionNumber", {
                      number: v.number,
                    }),
                  }))}
                  onChange={(id) => {
                    const params = new URLSearchParams(location.search);
                    params.set("dossierVersion", id);
                    navigate({ search: params.toString(), hash: "#dossier" });
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
                        ? "dossier.approved"
                        : "dossier.awaiting",
                  )}
                </Tag>
                {dossier?.legacy &&
                  detail.capabilities.approveDossier &&
                  !superseded &&
                  !approved && (
                    <Button
                      type="primary"
                      loading={busy}
                      onClick={() => void run(preview)}
                    >
                      {t("dossier.reviewApproval")}
                    </Button>
                  )}
              </Space>
              {superseded && (
                <Alert
                  type="warning"
                  showIcon
                  title={t("dossier.supersededHelp")}
                />
              )}
              <ConfirmationHistory
                confirmations={view.confirmations}
                bound={{ name: "dossier", hash: selected.hash }}
              />
              <DossierContent
                key={selected.id}
                snapshot={selected.snapshot}
                hash={selected.hash}
                canonicalJson={selected.canonicalJson}
                workflowId={detail.workflow.id}
                basePath={basePath}
              />
            </>
          )}
          {dossier?.legacy && editing && (
            <DossierComposer
              basePath={basePath}
              path={`${path}/dossier`}
              detail={detail}
              view={view}
              onClose={() => setEditing(false)}
              onComposed={() => {
                setEditing(false);
                onChanged();
              }}
            />
          )}
        </>
      )}
      <Modal
        open={review !== null}
        width={reviewDossier ? undefined : 900}
        title={t("dossier.reviewApproval")}
        okText={t("dossier.approve")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: Boolean(reviewChanged) }}
        closable={!busy}
        maskClosable={!busy}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() => void run(approve)}
      >
        <p>{t("dossier.approvalHelp")}</p>
        {reviewChanged && (
          <Alert
            type="warning"
            showIcon
            title={t("workingDossier.approvalChanged")}
          />
        )}
        {review?.dossier && (
          <div className="dossier-content">
            <p>
              {format("workingDossier.revision", {
                revision: review.dossier.revision,
              })}
            </p>
            <div>
              <p className="field-label">{t("dossier.hash")}</p>
              <code className="dossier-hash">
                {review.preview.boundHashes.dossier}
              </code>
            </div>
          </div>
        )}
        {reviewed && (
          <DossierContent
            snapshot={reviewed.snapshot}
            hash={reviewed.hash}
            canonicalJson={reviewed.canonicalJson}
            workflowId={detail.workflow.id}
            basePath={basePath}
          />
        )}
      </Modal>
    </WorkflowPanel>
  );
}
