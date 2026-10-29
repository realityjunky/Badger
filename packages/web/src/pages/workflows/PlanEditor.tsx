import { Alert, Button, Input, Modal, Spin } from "antd";
import { useEffect, useState } from "react";
import type {
  FactoryPlan,
  PlanComposition,
  PlanView,
} from "../../api/plans.js";
import type { PlanDraftingJob } from "../../api/drafting-jobs.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { PlanContent } from "./PlanContent.js";

export function PlanEditor({
  basePath,
  path,
  view,
  initialPlan,
  job,
  onClose,
  onSaved,
}: {
  basePath: string;
  path: string;
  view: PlanView;
  initialPlan: FactoryPlan;
  job?: PlanDraftingJob;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(JSON.stringify(initialPlan, null, 2));
  const [binding] = useState(() => ({
    dossierHash: view.dossierHash,
    expectedVersionId: view.versions[0]?.id ?? null,
  }));
  const [composition, setComposition] = useState<PlanComposition | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [validating, setValidating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{
    composition: PlanComposition;
    confirmationHash: string;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setComposition(null);
    setValidating(true);
    setFailure(null);
    const timer = setTimeout(() => {
      let plan: unknown;
      try {
        plan = JSON.parse(text);
      } catch {
        setFailure(t("plan.invalidJson"));
        setValidating(false);
        return;
      }
      void questionnaireRequest<{ composition: PlanComposition }>(
        basePath,
        `${path}/plan/preview`,
        "POST",
        {
          plan,
          dossierHash: binding.dossierHash,
        },
        controller.signal,
      ).then(
        (result) => {
          if (!controller.signal.aborted) {
            setComposition(result.composition);
            setValidating(false);
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setFailure(
              error instanceof Error ? error.message : t("plan.failed"),
            );
            setValidating(false);
          }
        },
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, basePath, path, binding.dossierHash]);

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
  async function preview() {
    if (!composition || composition.findings.length || validating) return;
    let confirmationHash = composition.hash;
    if (job) {
      const result = await questionnaireRequest<{
        preview: { confirmationHash: string };
      }>(basePath, `${path}/drafting-jobs/${job.id}/accept-preview`, "POST", {
        revision: job.revision,
        plan: composition.snapshot.plan,
      });
      confirmationHash = result.preview.confirmationHash;
    }
    setReview({
      composition,
      confirmationHash,
      requestId: crypto.randomUUID(),
    });
  }
  async function save() {
    if (!review) return;
    const plan = review.composition.snapshot.plan;
    await questionnaireRequest(
      basePath,
      job ? `${path}/drafting-jobs/${job.id}/accept` : `${path}/plan/save`,
      "POST",
      job
        ? {
            revision: job.revision,
            plan,
            confirmed: true,
            confirmationHash: review.confirmationHash,
            requestId: review.requestId,
          }
        : {
            plan,
            dossierHash: binding.dossierHash,
            confirmationHash: review.confirmationHash,
            expectedVersionId: binding.expectedVersionId,
          },
    );
    onSaved();
  }
  return (
    <>
      <Modal
        open={review === null}
        width={1000}
        title={t(job ? "plan.reviewSuggestion" : "plan.edit")}
        footer={null}
        onCancel={() => {
          if (!busy) onClose();
        }}
        closable={!busy}
        maskClosable={!busy}
      >
        <p>{t("plan.editorHelp")}</p>
        <label className="field-label" htmlFor="factory-plan-json">
          {t("plan.json")}
        </label>
        <Input.TextArea
          id="factory-plan-json"
          value={text}
          rows={18}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            setComposition(null);
            setValidating(true);
          }}
        />
        <div role="status" aria-live="polite" className="plan-validation">
          {validating ? (
            <Spin size="small" aria-label={t("plan.validating")} />
          ) : (
            composition && (
              <Alert
                type={composition.findings.length ? "warning" : "success"}
                showIcon
                title={t(
                  composition.findings.length
                    ? "dossier.findings"
                    : "plan.valid",
                )}
                description={
                  composition.findings.length ? (
                    <ul>
                      {composition.findings.map((finding, index) => (
                        <li key={index}>
                          <code>{finding.path}</code>: {finding.message}
                        </li>
                      ))}
                    </ul>
                  ) : undefined
                }
              />
            )
          )}
        </div>
        {failure && <Alert type="error" showIcon title={failure} />}
        <Button
          type="primary"
          loading={busy}
          disabled={
            validating || !composition || composition.findings.length > 0
          }
          onClick={() => void run(preview)}
        >
          {t("plan.reviewSave")}
        </Button>
      </Modal>
      <Modal
        open={review !== null}
        width={900}
        title={t("plan.reviewSave")}
        okText={t(job ? "plan.accept" : "plan.save")}
        cancelText={t("plan.backToEdit")}
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        onOk={() => void run(save)}
      >
        <p>{t("plan.saveHelp")}</p>
        {review && <PlanContent version={{ ...review.composition }} />}
        {failure && <Alert type="error" showIcon title={failure} />}
      </Modal>
    </>
  );
}
