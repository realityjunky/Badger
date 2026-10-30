import { Alert, Button, Modal, Select, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DossierView } from "../../api/dossier.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useInbox } from "../../inbox/InboxContext.js";
import { DossierComposer } from "./DossierComposer.js";
import { DossierContent } from "./DossierContent.js";

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
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{
    preview: GatePreview;
    requestId: string;
    versionId: string;
  } | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
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

  useEffect(() => {
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
  }, [basePath, path, detail.version.revision, refresh]);
  useEffect(() => {
    if (location.hash === "#dossier" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("dossier.failed"));
      setReview(null);
      setRefresh((r) => r + 1);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (!selected) return;
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/gates/dossier/preview`,
      "POST",
      {},
    );
    // The selected historical artifact is never substituted by a newer preview.
    if (preview.boundHashes.dossier !== selected.hash) {
      setRefresh((r) => r + 1);
      throw new Error(t("dossier.supersededHelp"));
    }
    setReview({
      preview,
      versionId: selected.id,
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
    await inbox.refresh();
    onChanged();
  }
  const reviewed = view?.versions.find((v) => v.id === review?.versionId);

  return (
    <section
      ref={section}
      id="dossier"
      className="workflow-panel"
      data-testid="workflow-dossier"
      aria-labelledby="dossier-title"
    >
      <div className="workflow-card-heading">
        <h2 id="dossier-title">{t("dossier.title")}</h2>
        {view && detail.capabilities.composeDossier && (
          <Button
            type="primary"
            disabled={busy || view.handoff.status !== "complete"}
            onClick={() => setEditing(true)}
          >
            {t("dossier.compose")}
          </Button>
        )}
      </div>
      <p className="muted">{t("dossier.description")}</p>
      {failure && (
        <Alert
          type="error"
          showIcon
          title={failure}
          action={
            <Button
              onClick={() => {
                setFailure(null);
                setRefresh((r) => r + 1);
              }}
            >
              {t("workflow.reload")}
            </Button>
          }
        />
      )}
      {!view && !failure && <Spin aria-label={t("common.loading")} />}
      {view && (
        <>
          <p>
            <Link
              to={`/questionnaire?workflow=${encodeURIComponent(detail.workflow.id)}&version=${encodeURIComponent(detail.version.id)}&panel=ledger`}
            >
              {t("ledger.title")}
            </Link>
          </p>
          {view.handoff.status !== "complete" && (
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
            <p className="empty-state">{t("dossier.empty")}</p>
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
                {detail.capabilities.approveDossier &&
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
              {(view.confirmations ?? [])
                .filter((c) => c.boundHashes.dossier === selected.hash)
                .map((c) => (
                  <p key={c.id}>
                    <Tag>
                      {t(
                        c.invalidatedAt
                          ? "versions.approvalSuperseded"
                          : "versions.approvalRecorded",
                      )}
                    </Tag>{" "}
                    {c.actorId} · {new Date(c.confirmedAt).toLocaleString()}
                    {c.invalidationReason && ` · ${c.invalidationReason}`}
                  </p>
                ))}
              <DossierContent
                snapshot={selected.snapshot}
                hash={selected.hash}
                canonicalJson={selected.canonicalJson}
                workflowId={detail.workflow.id}
              />
            </>
          )}
          {editing && (
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
        title={t("dossier.reviewApproval")}
        okText={t("dossier.approve")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() => void run(approve)}
      >
        <p>{t("dossier.approvalHelp")}</p>
        {reviewed && (
          <DossierContent
            snapshot={reviewed.snapshot}
            hash={reviewed.hash}
            canonicalJson={reviewed.canonicalJson}
            workflowId={detail.workflow.id}
          />
        )}
      </Modal>
    </section>
  );
}
