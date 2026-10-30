import { Alert, Button, Input, Modal, Space, Spin, Table, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { PackageView } from "../../api/packages.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function WorkflowPackage({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const pendingBefore = useRef(false);
  const [view, setView] = useState<PackageView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{
    preview: GatePreview;
    requestId: string;
    stateHash: string;
  } | null>(null);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<PackageView>(
      basePath,
      `${path}/package`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (controller.signal.aborted) return;
        setView(value);
        const pending = value.jobs.some(
          (j) => j.status === "queued" || j.status === "running",
        );
        if (pendingBefore.current && !pending) onChanged();
        pendingBefore.current = pending;
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("package.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, detail.version.revision, refresh]);
  useEffect(() => {
    if (
      !view?.jobs.some((j) => j.status === "queued" || j.status === "running")
    )
      return;
    const timer = setTimeout(() => setRefresh((r) => r + 1), 1000);
    return () => clearTimeout(timer);
  }, [view]);
  useEffect(() => {
    if (location.hash === "#package" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);
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
  async function preview() {
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/gates/generation/preview`,
      "POST",
      {},
    );
    if (preview.boundHashes.creatorState !== view?.currentStateHash) {
      setRefresh((r) => r + 1);
      throw new Error(t("package.changed"));
    }
    setReview({
      preview,
      stateHash: view.currentStateHash!,
      requestId: crypto.randomUUID(),
    });
  }
  async function confirm() {
    if (!review) return;
    const { confirmation } = await questionnaireRequest<{
      confirmation: { confirmationHash: string };
    }>(basePath, `${path}/gates/generation/commit`, "POST", {
      confirmationHash: review.preview.confirmationHash,
      requestId: review.requestId,
    });
    await questionnaireRequest(basePath, `${path}/package/generate`, "POST", {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: review.stateHash,
      requestId: review.requestId,
    });
    setReview(null);
    setRefresh((r) => r + 1);
    onChanged();
  }
  const saved = view?.package;
  const pending = view?.jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  return (
    <section
      ref={section}
      id="package"
      className="workflow-panel"
      data-testid="workflow-package"
      aria-labelledby="package-title"
    >
      <div className="workflow-card-heading">
        <h2 id="package-title">{t("package.title")}</h2>
        <Space wrap>
          {view?.canGenerate && detail.capabilities.generate && (
            <Button
              type="primary"
              disabled={busy || pending}
              onClick={() => void run(preview)}
            >
              {t(saved ? "package.regenerate" : "package.generate")}
            </Button>
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
      <p className="muted">{t("package.description")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {!view ? (
        <Spin />
      ) : (
        <>
          {!view.canGenerate && (
            <Alert
              type="info"
              showIcon
              title={t("package.needInitialization")}
            />
          )}
          {saved?.status === "invalidated" && (
            <Alert
              type="warning"
              showIcon
              title={t("package.invalidated")}
              description={saved.invalidationReason}
            />
          )}
          {saved && (
            <>
              <dl className="gate-hashes">
                <div>
                  <dt>{t("package.hash")}</dt>
                  <dd>
                    <code>{saved.scaffoldHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("proposal.hash")}</dt>
                  <dd>
                    <code>{saved.proposalHash}</code>
                  </dd>
                </div>
              </dl>
              <h3>{t("package.files")}</h3>
              <label>
                {t("package.filterFiles")}
                <Input
                  value={fileFilter}
                  allowClear
                  onChange={(event) => setFileFilter(event.target.value)}
                />
              </label>
              <Table
                size="small"
                rowKey="path"
                dataSource={saved.files.filter((entry) =>
                  entry.path.toLowerCase().includes(fileFilter.toLowerCase()),
                )}
                pagination={{ pageSize: 10, showSizeChanger: false }}
                scroll={{ x: 720 }}
                columns={[
                  {
                    title: t("package.file"),
                    dataIndex: "path",
                    render: (value: string) => (
                      <Button
                        type="link"
                        onClick={() =>
                          void run(async () =>
                            setFile(
                              await questionnaireRequest(
                                basePath,
                                `${path}/package/file?path=${encodeURIComponent(value)}`,
                              ),
                            ),
                          )
                        }
                      >
                        {value}
                      </Button>
                    ),
                  },
                  {
                    title: t("package.owner"),
                    dataIndex: "owner",
                    render: (value: "auto" | "authored" | "source") => (
                      <Tag>{t(`package.owner.${value}`)}</Tag>
                    ),
                  },
                  {
                    title: "SHA-256",
                    dataIndex: "sha256",
                    render: (value: string) => (
                      <code className="package-file-hash">{value}</code>
                    ),
                  },
                ]}
              />
              <h3>{t("package.authoringPlan")}</h3>
              <dl className="gate-hashes">
                <div>
                  <dt>{t("package.authoringHash")}</dt>
                  <dd>
                    <code>{saved.authoringPlan.authoringPlanHash}</code>
                  </dd>
                </div>
              </dl>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={saved.authoringPlan.lanes}
                columns={[
                  { title: t("package.lane"), dataIndex: "id" },
                  {
                    title: t("package.wave"),
                    render: (_, lane) =>
                      Object.entries(saved.authoringPlan.dag).find(
                        ([, lanes]) => (lanes as string[]).includes(lane.id),
                      )?.[0],
                  },
                  {
                    title: t("package.dependencies"),
                    dataIndex: "dependencies",
                    render: (ids: string[]) => ids.join(", ") || "—",
                  },
                ]}
              />
            </>
          )}
          {view.jobs.length > 0 && (
            <>
              <h3>{t("package.jobs")}</h3>
              <ul className="gate-pins" aria-live="polite">
                {view.jobs.map((job) => (
                  <li key={job.id}>
                    <Tag>{t(`package.status.${job.status}`)}</Tag>
                    <code>{job.id}</code>
                    {job.error && <p>{job.error}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <Modal
        open={!!review}
        title={t("package.review")}
        onCancel={() => !busy && setReview(null)}
        onOk={() => void run(confirm)}
        okText={t("package.confirm")}
        cancelText={t("workflow.cancel")}
        confirmLoading={busy}
      >
        <p>{t("package.confirmHelp")}</p>
        <dl className="gate-hashes">
          {review &&
            Object.entries(review.preview.boundHashes).map(([key, hash]) => (
              <div key={key}>
                <dt>
                  {t(
                    key === "proposal"
                      ? "proposal.hash"
                      : key === "plan"
                        ? "plan.hash"
                        : "proposal.currentState",
                  )}
                </dt>
                <dd>
                  <code>{hash}</code>
                </dd>
              </div>
            ))}
        </dl>
      </Modal>
      <Modal
        open={!!file}
        title={file?.path}
        onCancel={() => setFile(null)}
        footer={null}
        width={960}
      >
        <pre className="package-file-preview">{file?.text}</pre>
      </Modal>
    </section>
  );
}
