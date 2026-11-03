import { Alert, Button, Collapse, Modal, Space, Spin, Table, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  ReviewView,
  PublishedPackageRead,
  PublishedPackage,
} from "../../api/publications.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { WorkflowHostInstall } from "./WorkflowHostInstall.js";
import { WorkflowPanel } from "./WorkflowPanel.js";

export function WorkflowPublication({
  basePath,
  detail,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  onChanged(): void;
}) {
  const { t, locale } = useI18n();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const [view, setView] = useState<ReviewView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    action: "approve" | "publish";
    preview: GatePreview;
    requestId: string;
  } | null>(null);
  const [published, setPublished] = useState<PublishedPackageRead | null>(null);
  const [installing, setInstalling] = useState<PublishedPackage | null>(null);
  const path = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}/review`;
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<ReviewView>(
      basePath,
      path,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setView(value);
          setFailure(null);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("publication.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, path, detail.version.revision]);
  useEffect(() => {
    if (location.hash === "#review-publication" && view)
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, Boolean(view)]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("publication.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function prepare(action: "approve" | "publish") {
    const { preview } = await questionnaireRequest<{ preview: GatePreview }>(
      basePath,
      `${path}/${action}-preview`,
      "POST",
      {},
    );
    setPreview({
      action,
      preview,
      requestId: crypto.randomUUID(),
    });
  }
  async function commit() {
    if (!preview) return;
    await questionnaireRequest(basePath, `${path}/${preview.action}`, "POST", {
      confirmed: true,
      confirmationHash: preview.preview.confirmationHash,
      requestId: preview.requestId,
    });
    setPreview(null);
    onChanged();
  }
  async function inspect(publication: PublishedPackage) {
    setPublished(
      await questionnaireRequest<PublishedPackageRead>(
        basePath,
        `/workflows/${encodeURIComponent(detail.workflow.id)}/publications/${encodeURIComponent(publication.id)}/package?packageHash=${encodeURIComponent(publication.packageHash)}`,
      ),
    );
  }
  const currentPublished = view?.publications.some(
    (p) => p.reviewId === view.approvalId,
  );
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <WorkflowPanel
      title={t("publication.title")}
      ref={section}
      id="review-publication"
      className="publication-panel"
      aria-labelledby="publication-title"
      actions={
        currentPublished && (
          <Tag color="success">{t("publication.published")}</Tag>
        )
      }
    >
      <p className="muted">{t("publication.description")}</p>
      {failure && <Alert type="error" showIcon title={failure} />}
      {!view ? (
        <Spin />
      ) : (
        <>
          {view.currentPackageHash ? (
            <p>
              {t("evaluation.hash")}{" "}
              <code className="publication-hash">
                {view.currentPackageHash}
              </code>
            </p>
          ) : (
            <Alert
              type="info"
              showIcon
              title={t("publication.assembleFirst")}
            />
          )}
          {view.readiness && (
            <>
              <div className="publication-readiness">
                {(["authoring", "runtime", "publication"] as const).map(
                  (key) => {
                    const ready = view.readiness![key];
                    return (
                      <div className="publication-readiness-card" key={key}>
                        <strong>{t(`publication.section.${key}`)}</strong>
                        <Tag
                          color={
                            ready.state === "ready" ? "success" : "warning"
                          }
                        >
                          {t(
                            ready.state === "ready"
                              ? "publication.ready"
                              : "publication.blocked",
                          )}
                        </Tag>
                        {ready.blockers.length > 0 && (
                          <ul>
                            {ready.blockers.map((blocker) => (
                              <li key={blocker}>{blocker}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
              {view.readiness.blockers.length > 0 && (
                <Collapse
                  items={[
                    {
                      key: "blockers",
                      label: t("publication.blockers"),
                      children: (
                        <ul>
                          {[...new Set(view.readiness.blockers)].map(
                            (blocker) => (
                              <li key={blocker}>{blocker}</li>
                            ),
                          )}
                        </ul>
                      ),
                    },
                  ]}
                />
              )}
            </>
          )}
          <Space wrap>
            {view.canPublish && (
              <Button
                type="primary"
                loading={busy}
                disabled={view.readiness?.state !== "reviewable"}
                onClick={() => void run(() => prepare("approve"))}
              >
                {t("publication.review")}
              </Button>
            )}
            {view.canPublish && (
              <Button
                type="primary"
                loading={busy}
                disabled={
                  view.readiness?.state !== "publishable" || currentPublished
                }
                onClick={() => void run(() => prepare("publish"))}
              >
                {t("publication.publish")}
              </Button>
            )}
            <Link
              to={`/evaluations?workflow=${encodeURIComponent(detail.workflow.id)}&version=${encodeURIComponent(detail.version.id)}`}
            >
              {t("page.evaluations.title")}
            </Link>
          </Space>
          <h3>{t("publication.reviewHistory")}</h3>
          {view.reviews.length === 0 ? (
            <p className="muted">{t("publication.noReviews")}</p>
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: 760 }}
              dataSource={view.reviews}
              columns={[
                { title: t("publication.reviewer"), dataIndex: "reviewerName" },
                {
                  title: t("evaluation.hash"),
                  dataIndex: "packageHash",
                  render: (value) => (
                    <code className="publication-hash">{value}</code>
                  ),
                },
                {
                  title: t("publication.approvedAt"),
                  dataIndex: "approvedAt",
                  render: date,
                },
                {
                  title: t("publication.status"),
                  render: (_, r) => (
                    <>
                      <Tag color={r.invalidatedAt ? "default" : "success"}>
                        {t(
                          r.invalidatedAt
                            ? "publication.superseded"
                            : "publication.approved",
                        )}
                      </Tag>
                      {r.overrideReason && (
                        <p>
                          {t("publication.overrideReason")}: {r.overrideReason}
                        </p>
                      )}
                      {r.invalidationReason && <p>{r.invalidationReason}</p>}
                    </>
                  ),
                },
              ]}
            />
          )}
          <h3>{t("publication.history")}</h3>
          <p className="muted">{t("publication.retained")}</p>
          {view.publications.length === 0 ? (
            <p className="muted">{t("publication.noPublications")}</p>
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: 760 }}
              dataSource={view.publications}
              columns={[
                {
                  title: t("evaluation.version"),
                  render: (_, p) => `${p.versionName} · v${p.versionNumber}`,
                },
                {
                  title: t("evaluation.hash"),
                  dataIndex: "packageHash",
                  render: (value) => (
                    <code className="publication-hash">{value}</code>
                  ),
                },
                {
                  title: t("publication.publisher"),
                  dataIndex: "publisherName",
                },
                {
                  title: t("publication.publishedAt"),
                  dataIndex: "publishedAt",
                  render: date,
                },
                {
                  title: t("publication.package"),
                  render: (_, p) => (
                    <Space wrap>
                      <Button
                        loading={busy}
                        onClick={() => void run(() => inspect(p))}
                      >
                        {t("publication.inspect")}
                      </Button>
                      <Button onClick={() => setInstalling(p)}>
                        {t("hosts.open")}
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <Modal
        open={preview !== null}
        title={t(
          preview?.action === "publish"
            ? "publication.publishConfirm"
            : "publication.reviewConfirm",
        )}
        onCancel={() => {
          if (!busy) setPreview(null);
        }}
        onOk={() => void run(commit)}
        confirmLoading={busy}
        okText={t(
          preview?.action === "publish"
            ? "publication.confirmPublish"
            : "publication.confirmReview",
        )}
        cancelText={t("common.cancel")}
        destroyOnHidden
      >
        <p>
          {t(
            preview?.action === "publish"
              ? "publication.publishHelp"
              : "publication.reviewHelp",
          )}
        </p>
        <p>
          {t("evaluation.hash")}:{" "}
          <code className="publication-hash">
            {preview?.preview.boundHashes.package}
          </code>
        </p>
      </Modal>
      <WorkflowHostInstall
        workflowId={detail.workflow.id}
        publication={installing}
        deploymentUrl={`${window.location.origin}${basePath === "/" ? "" : basePath}`}
        onClose={() => setInstalling(null)}
      />
      <Modal
        open={published !== null}
        title={t("publication.package")}
        onCancel={() => setPublished(null)}
        footer={
          <Button onClick={() => setPublished(null)}>
            {t("common.close")}
          </Button>
        }
        width={900}
        destroyOnHidden
      >
        {published && (
          <>
            <Alert type="success" showIcon title={t("publication.verified")} />
            <p>
              <code className="publication-hash">
                {published.snapshot.packageHash}
              </code>
            </p>
            <Table
              rowKey="path"
              size="small"
              pagination={{ pageSize: 10 }}
              scroll={{ x: 620 }}
              dataSource={published.snapshot.inventory}
              columns={[
                { title: t("publication.file"), dataIndex: "path" },
                { title: t("publication.bytes"), dataIndex: "bytes" },
                {
                  title: "SHA-256",
                  dataIndex: "sha256",
                  render: (value) => (
                    <code className="publication-hash">{value}</code>
                  ),
                },
              ]}
            />
          </>
        )}
      </Modal>
    </WorkflowPanel>
  );
}
