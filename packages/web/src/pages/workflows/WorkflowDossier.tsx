import { Alert, Button, Modal, Select, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DossierView } from "../../api/dossier.js";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import {
  approvedDossierFields,
  workingDossierPath,
} from "../../api/working-dossier.js";
import type {
  ApprovedWorkingDossier,
  WorkingDossierView,
} from "@realityjunky/badger";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { ReloadRecordsButton } from "../../components/ReloadRecordsButton.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { ConfirmationHistory } from "../../components/ConfirmationHistory.js";
import { DossierComposer } from "./DossierComposer.js";
import { DossierContent } from "./DossierContent.js";
import { WorkingDossierApproval } from "./WorkingDossierApproval.js";
import { WorkflowPanel } from "./WorkflowPanel.js";
import { AuthoringStageFinding } from "./AuthoringStageFinding.js";
import { selectedWorkflowTab } from "./WorkflowTabs.js";
import { DossierViews, SnapshotTopics } from "./DossierViews.js";
import { SnapshotJson } from "../../components/SnapshotJson.js";
import { WorkingDossierLedger } from "../working-dossier/WorkingDossierLedger.js";
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
  const { t, format, locale } = useI18n();
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
    dossier?: WorkingDossierView;
    previous?: ApprovedWorkingDossier;
  } | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  const dossierPath = workingDossierPath(detail.workflow.id, detail.version.id);
  const active = selectedWorkflowTab(location) === "dossier";
  const {
    dossier,
    accept,
    failure: dossierFailure,
    reload,
  } = useWorkingDossier(basePath, dossierPath, detail.version.id, active);
  const working = dossier && !dossier.legacy;
  const query = new URLSearchParams(location.search);
  const selectedId = query.get("dossierVersion");
  const selected = view?.versions.find(
    (v) => v.id === (selectedId ?? (working ? null : view.headVersionId)),
  );
  const draft = working && !selectedId ? dossier : undefined;
  const snapshot = selected?.snapshot;
  const captured = snapshot?.dossier.workingDossier;
  const basis = draft ?? captured;
  const fields =
    draft?.projection.fields ??
    (captured ? approvedDossierFields(captured) : []);
  const context = {
    basePath,
    path: dossierPath,
    revision: basis?.revision ?? 0,
    pins: basis?.pins ?? [],
  };
  const questionnaireQuery = new URLSearchParams({
    workflow: detail.workflow.id,
    version: detail.version.id,
  });
  function select(key: "dossierVersion" | "dossierTab", value: string) {
    const params = new URLSearchParams(location.search);
    if (key === "dossierVersion") params.delete("dossierField");
    if (value === "working") params.delete(key);
    else params.set(key, value);
    navigate({ search: params.toString(), hash: "#dossier" });
  }
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
    if (active && view) section.current?.scrollIntoView({ block: "start" });
  }, [active, Boolean(view)]);

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
            dossier,
            previous: view?.versions.find(
              ({ hash }) => hash === view.confirmation?.boundHashes.dossier,
            )?.snapshot.dossier.workingDossier,
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
      <AuthoringStageFinding basePath={basePath} path={path} stage="dossier" />
      {dossierFailure && (
        <Alert
          type="error"
          showIcon
          title={dossierFailure}
          action={<ReloadRecordsButton onClick={() => void reload()} />}
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
            <ReloadRecordsButton
              onClick={() => {
                setFailure(null);
                setFindings([]);
                void reload();
                setRefresh((r) => r + 1);
              }}
            />
          }
        />
      )}
      {(!view || !dossier) && !failure && !dossierFailure && (
        <Spin aria-label={t("common.loading")} />
      )}
      {view && (
        <>
          {dossier && (
            <>
              <div className="dossier-version-heading working-dossier-toolbar">
                <Space wrap>
                  <Select
                    aria-label={t("dossier.version")}
                    value={draft ? "working" : selected?.id}
                    placeholder={t("dossier.version")}
                    options={[
                      ...(working
                        ? [
                            {
                              value: "working",
                              label: format("workingDossier.revision", {
                                revision: dossier.revision,
                              }),
                            },
                          ]
                        : []),
                      ...view.versions.map((v) => ({
                        value: v.id,
                        label: format("dossier.versionNumber", {
                          number: v.number,
                        }),
                      })),
                    ]}
                    onChange={(value) => select("dossierVersion", value)}
                  />
                  {draft && approvedRevision && (
                    <Tag color="success">{t("dossier.approved")}</Tag>
                  )}
                  {selected && (
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
                            ? "dossier.approved"
                            : "dossier.awaiting",
                      )}
                    </Tag>
                  )}
                </Space>
                {detail.capabilities.approveDossier &&
                  ((draft?.available && !approvedRevision) ||
                    (dossier.legacy &&
                      selected &&
                      !approved &&
                      !superseded)) && (
                    <Button
                      type="primary"
                      loading={busy}
                      onClick={() => void run(preview)}
                    >
                      {t("dossier.reviewApproval")}
                    </Button>
                  )}
              </div>
              {superseded && (
                <Alert
                  type="warning"
                  showIcon
                  title={t("dossier.supersededHelp")}
                />
              )}
              {dossier.legacy && view.handoff.status !== "complete" && (
                <Alert
                  type="warning"
                  showIcon
                  title={t("ledger.blocked")}
                  description={
                    <ul>
                      {view.handoff.readiness
                        .filter((r) => !r.ready)
                        .map((r) => (
                          <li key={r.topic}>
                            {t(`questionnaire.topic.${r.topic}`)} ·{" "}
                            {r.blockers
                              .map((b) => t(`ledger.blocker.${b.code}`))
                              .join(" · ")}
                          </li>
                        ))}
                    </ul>
                  }
                />
              )}
              {draft || selected ? (
                <DossierViews
                  key={selected?.id ?? "working"}
                  basis={basis}
                  fields={fields}
                  context={context}
                  isDraft={Boolean(draft)}
                  tab={query.get("dossierTab")}
                  onTab={(value) => select("dossierTab", value)}
                  topics={
                    draft ? (
                      <WorkingDossierLedger
                        key={query.get("dossierField") ?? ""}
                        dossier={draft}
                        context={context}
                        linkedField={query.get("dossierField")}
                        onAsk={(field, handoffId) => {
                          const params = new URLSearchParams(
                            questionnaireQuery,
                          );
                          params.set("askField", field.id);
                          if (handoffId) params.set("askHandoff", handoffId);
                          navigate(`/questionnaire?${params}`);
                        }}
                        onSaved={(updated) => {
                          accept(updated);
                          onChanged();
                        }}
                        onReload={reload}
                      />
                    ) : captured ? (
                      <SnapshotTopics fields={fields} context={context} />
                    ) : undefined
                  }
                  legacyDetails={
                    selected && !captured ? (
                      <DossierContent
                        snapshot={selected.snapshot}
                        workflowId={detail.workflow.id}
                        hash={selected.hash}
                        canonicalJson={null}
                      />
                    ) : undefined
                  }
                  revisionDetails={
                    <div className="dossier-content">
                      <p>
                        {snapshot?.dossier.workflow.goal ?? detail.version.goal}
                      </p>
                      {basis && (
                        <p>
                          {format("workingDossier.revision", {
                            revision: basis.revision,
                          })}
                        </p>
                      )}
                      {selected && (
                        <>
                          <p>
                            {new Date(selected.createdAt).toLocaleString(
                              locale,
                            )}{" "}
                            · {selected.createdBy}
                          </p>
                          <p className="field-label">{t("dossier.hash")}</p>
                          <code className="dossier-hash">{selected.hash}</code>
                          <ConfirmationHistory
                            confirmations={view.confirmations}
                            bound={{ name: "dossier", hash: selected.hash }}
                          />
                        </>
                      )}
                      {basis && (
                        <>
                          <p className="field-label">{t("dossier.pinsHash")}</p>
                          <code className="dossier-hash">{basis.pinsHash}</code>
                        </>
                      )}
                      {draft && (
                        <WorkingDossierApproval
                          dossier={draft}
                          previous={
                            view.versions.find(
                              (v) =>
                                v.hash ===
                                view.confirmation?.boundHashes.dossier,
                            )?.snapshot.dossier.workingDossier
                          }
                          basePath={basePath}
                          path={dossierPath}
                        />
                      )}
                    </div>
                  }
                  json={
                    draft ? (
                      <SnapshotJson
                        data={{
                          revision: draft.revision,
                          pinsHash: draft.pinsHash,
                          pins: draft.pins,
                          content: draft.content,
                        }}
                      />
                    ) : selected?.canonicalJson != null ? (
                      <SnapshotJson canonical={selected.canonicalJson} />
                    ) : undefined
                  }
                />
              ) : (
                <p className="empty-state">
                  {t(selectedId ? "workflow.versionMissing" : "dossier.empty")}
                </p>
              )}
              {(draft || dossier.legacy) && (
                <Link to={`/questionnaire?${questionnaireQuery}&panel=records`}>
                  {t("ledger.records")}
                </Link>
              )}
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
        width={900}
        className={reviewDossier ? "dossier-review-dialog" : undefined}
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
            <WorkingDossierApproval
              dossier={review.dossier}
              previous={review.previous}
              basePath={basePath}
              path={dossierPath}
            />
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
