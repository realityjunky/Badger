import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
} from "antd";
import { useEffect, useState } from "react";
import type { DecisionScalar } from "@realityjunky/badger";
import type { WorkflowGateAnswer } from "@realityjunky/badger/workflow-runtime";
import type { RunGate } from "../api/runs.js";
import { questionnaireRequest } from "../api/questionnaire.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useInbox } from "../inbox/InboxContext.js";

export function RunGatePanel({
  basePath,
  runId,
}: {
  basePath: string;
  runId: string;
}) {
  const { t } = useI18n();
  const [gates, setGates] = useState<RunGate[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await questionnaireRequest<{ gates: RunGate[] }>(
          basePath,
          `/runs/${encodeURIComponent(runId)}/gates`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setGates(result.gates);
          setFailure(null);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : t("run.failed"));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, runId, refresh]);
  const gate = gates.find((gate) => gate.state === "open") ?? gates[0];
  return (
    <>
      {failure && <Alert type="error" showIcon message={failure} />}
      {gate && (
        <GateForm
          key={`${gate.id}:${gate.state}`}
          basePath={basePath}
          runId={runId}
          gate={gate}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
    </>
  );
}

function GateForm({
  basePath,
  runId,
  gate,
  onChanged,
}: {
  basePath: string;
  runId: string;
  gate: RunGate;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const inbox = useInbox();
  const [choiceId, setChoiceId] = useState<string>();
  const [inputs, setInputs] = useState<Record<string, DecisionScalar>>({});
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [review, setReview] = useState<{
    answer: WorkflowGateAnswer;
    confirmationHash: string;
    requestId: string;
  } | null>(null);
  const action = gate.pendingAction;
  const choice = action.choices?.find((choice) => choice.id === choiceId);
  const fields =
    choice?.requiredInputs?.fields ?? action.requiredInputs?.fields ?? [];
  const path = `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gate.id)}`;
  const requestReview = async () => {
    if (!choiceId || busy) return;
    setBusy(true);
    setFailure(null);
    const answer = {
      choiceId,
      inputs,
      ...(rationale.trim() ? { rationale } : {}),
    };
    try {
      const { preview } = await questionnaireRequest<{
        preview: { confirmationHash: string };
      }>(basePath, `${path}/preview`, "POST", answer);
      setReview({
        answer,
        confirmationHash: preview.confirmationHash,
        requestId: crypto.randomUUID(),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("run.gateFailed"));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!review || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await questionnaireRequest(basePath, `${path}/answer`, "POST", {
        ...review.answer,
        confirmed: true,
        confirmationHash: review.confirmationHash,
        requestId: review.requestId,
      });
      setReview(null);
      onChanged();
      await inbox.refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("run.gateFailed"));
    } finally {
      setBusy(false);
    }
  };
  if (gate.state === "answered")
    return <Alert type="success" showIcon message={t("run.gateAnswered")} />;
  if (gate.state !== "open") return null;
  return (
    <section className="surface-card" aria-label={t("run.humanGate")}>
      <h2>{t("run.humanGate")}</h2>
      <p>{action.question ?? action.prompt}</p>
      <p>{t("run.humanGateHelp")}</p>
      {gate.finalizationPreview && (
        <Collapse
          items={[
            {
              key: "effects",
              label: t("run.gateEffects"),
              children: (
                <pre className="run-json">
                  {JSON.stringify(gate.finalizationPreview, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      )}
      {action.scope && (
        <Collapse
          items={[
            {
              key: "scope",
              label: t("run.gateScope"),
              children: (
                <pre className="run-json">
                  {JSON.stringify(action.scope, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      )}
      {!gate.canAnswer ? (
        <Alert type="info" showIcon message={t("run.gateAuthority")} />
      ) : (
        <Form layout="vertical" onFinish={() => void requestReview()}>
          <Form.Item
            label={t("run.gateDecision")}
            htmlFor={`gate-${gate.id}-choice`}
            required
          >
            <Select
              id={`gate-${gate.id}-choice`}
              value={choiceId}
              disabled={busy}
              options={action.choices?.map((choice) => ({
                value: choice.id,
                label: choice.label,
              }))}
              onChange={(value) => {
                setChoiceId(value);
                setInputs({});
              }}
            />
          </Form.Item>
          {fields.map((field) => {
            const id = `gate-${gate.id}-${field.id}`;
            const values =
              field.values ??
              field.enum ??
              (field.type === "boolean" ? [true, false] : undefined);
            const change = (value: DecisionScalar | undefined) =>
              setInputs((current) => {
                const next = { ...current };
                if (value === undefined) delete next[field.id];
                else next[field.id] = value;
                return next;
              });
            return (
              <Form.Item
                key={field.id}
                label={field.id}
                htmlFor={id}
                required={field.required}
              >
                {values ? (
                  <Select
                    id={id}
                    disabled={busy}
                    allowClear
                    value={
                      inputs[field.id] === undefined
                        ? undefined
                        : String(inputs[field.id])
                    }
                    options={values.map((value) => ({
                      value: String(value),
                      label: String(value),
                    }))}
                    onChange={(value) =>
                      change(values.find((entry) => String(entry) === value))
                    }
                  />
                ) : field.type === "number" ? (
                  <InputNumber
                    id={id}
                    disabled={busy}
                    value={inputs[field.id] as number | undefined}
                    onChange={(value) => change(value ?? undefined)}
                  />
                ) : (
                  <Input
                    id={id}
                    disabled={busy}
                    maxLength={10000}
                    value={(inputs[field.id] as string) ?? ""}
                    onChange={(event) => change(event.target.value)}
                  />
                )}
              </Form.Item>
            );
          })}
          <Form.Item
            label={t("run.gateRationale")}
            htmlFor={`gate-${gate.id}-rationale`}
            required={
              action.rationale?.required ||
              (action.repair !== undefined &&
                choiceId === "retry-with-new-approach")
            }
          >
            <Input.TextArea
              id={`gate-${gate.id}-rationale`}
              value={rationale}
              disabled={busy}
              maxLength={10000}
              onChange={(event) => setRationale(event.target.value)}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
          </Form.Item>
          {failure && !review && (
            <Alert type="error" showIcon message={failure} />
          )}
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={!choiceId}
          >
            {t("run.gateReview")}
          </Button>
        </Form>
      )}
      <Modal
        open={review !== null}
        title={t("run.gateReview")}
        onCancel={() => {
          if (!busy) setReview(null);
        }}
        footer={
          <Space>
            <Button disabled={busy} onClick={() => setReview(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="primary"
              loading={busy}
              onClick={() => void confirm()}
            >
              {t("run.gateConfirm")}
            </Button>
          </Space>
        }
      >
        <p>{t("run.gateAttestation")}</p>
        <p>{choice?.label}</p>
        <pre className="run-json">
          {JSON.stringify(review?.answer, null, 2)}
        </pre>
        <p>
          {t("run.gateRevision")}: {gate.revision}
        </p>
        <code>{review?.confirmationHash}</code>
        {failure && <Alert type="error" showIcon message={failure} />}
      </Modal>
    </section>
  );
}
