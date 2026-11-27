import { Alert, Button, Modal, Space, Tabs, Select } from "antd";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { PlanView } from "../../api/plans.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type {
  GatePreview,
  WorkflowVersionDetail,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { WorkflowPackage } from "./WorkflowPackage.js";
import { WorkflowPublication } from "./WorkflowPublication.js";
import { SnapshotJson } from "../../components/SnapshotJson.js";

export function WorkflowRelease({
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
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const requested = location.hash.slice(1) || params.get("stage") || "";
  const tab =
    params.get("releaseTab") ??
    (params.has("planVersion") ||
    ["plan", "plan-proposal", "proposal"].includes(requested)
      ? "history"
      : requested === "review-publication"
        ? "review"
        : "package");
  const [history, setHistory] = useState<PlanView>();
  const [preview, setPreview] = useState<{
    preview: GatePreview;
    plan: object;
    requestId: string;
  }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const versionPath = `/workflows/${encodeURIComponent(detail.workflow.id)}/versions/${encodeURIComponent(detail.version.id)}`;
  const path = versionPath + "/gates/workflow-build";
  useEffect(() => {
    if (tab !== "history") return;
    const controller = new AbortController();
    void questionnaireRequest<PlanView>(
      basePath,
      versionPath + "/plan",
      "GET",
      undefined,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted) setHistory(data);
      },
      (error) => {
        if (!controller.signal.aborted) setFailure(String(error));
      },
    );
    return () => controller.abort();
  }, [basePath, versionPath, tab, detail.version.revision]);
  const version = history?.versions.find(
    (entry) =>
      entry.id === (params.get("planVersion") ?? history.headVersionId),
  );
  function chooseTab(key: string, planVersion?: string) {
    const query = new URLSearchParams(location.search);
    query.set("releaseTab", key);
    if (planVersion) query.set("planVersion", planVersion);
    else query.delete("planVersion");
    navigate({ search: query.toString(), hash: "release" });
  }
  async function build(confirm: boolean) {
    setBusy(true);
    setFailure(undefined);
    try {
      if (confirm && preview) {
        await questionnaireRequest(basePath, path + "/commit", "POST", {
          confirmationHash: preview.preview.confirmationHash,
          requestId: preview.requestId,
        });
        setPreview(undefined);
        onChanged();
      } else {
        const result = await questionnaireRequest<{
          preview: GatePreview;
          plan: object;
        }>(basePath, path + "/preview", "POST", {});
        setPreview({ ...result, requestId: crypto.randomUUID() });
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("package.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={t("mapping.release")}>
      <Space wrap>
        {detail.capabilities.generate && (
          <Button
            type="primary"
            loading={busy}
            onClick={() => void build(false)}
          >
            {t("mapping.build")}
          </Button>
        )}
        <Link
          to={`/evaluations?workflow=${detail.workflow.id}&version=${detail.version.id}`}
        >
          {t("stage.evaluation")}
        </Link>
      </Space>
      {failure && <Alert type="error" showIcon title={failure} />}
      <Tabs
        activeKey={tab}
        onChange={(key) => chooseTab(key)}
        items={[
          {
            key: "history",
            label: t("mapping.history"),
            children: (
              <>
                {history?.versions.length ? (
                  <>
                    <Select
                      aria-label={t("mapping.lastPlan")}
                      value={version?.id}
                      onChange={(id) => chooseTab("history", id)}
                      options={history.versions.map((entry) => ({
                        value: entry.id,
                        label: `${t("plan.title")} ${entry.number} · ${entry.hash.slice(0, 12)}`,
                      }))}
                    />
                    {version && (
                      <SnapshotJson
                        canonical={JSON.stringify(
                          version.snapshot.plan.workflow,
                          null,
                          2,
                        )}
                      />
                    )}
                  </>
                ) : (
                  <p>{t("plan.empty")}</p>
                )}
              </>
            ),
          },
          {
            key: "package",
            label: t("package.title"),
            children: (
              <WorkflowPackage
                basePath={basePath}
                detail={detail}
                onChanged={onChanged}
                mapped
              />
            ),
          },
          {
            key: "review",
            label: t("publication.title"),
            children: (
              <WorkflowPublication
                basePath={basePath}
                detail={detail}
                onChanged={onChanged}
              />
            ),
          },
        ]}
      />
      <Modal
        open={!!preview}
        title={t("mapping.plan")}
        okText={t("mapping.build")}
        confirmLoading={busy}
        onOk={() => void build(true)}
        onCancel={() => setPreview(undefined)}
      >
        {preview && (
          <>
            <p>{preview.preview.records[0]?.label}</p>
            <SnapshotJson canonical={JSON.stringify(preview.plan, null, 2)} />
          </>
        )}
        {failure && <Alert type="error" title={failure} />}
      </Modal>
    </section>
  );
}
