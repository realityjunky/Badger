import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
} from "antd";
import type {
  DossierEvidence,
  DossierFieldState,
  DossierInterface,
  DossierOccurrence,
  DossierRoute,
  WorkingDossierView,
} from "@realityjunky/badger";
import { useId, type ReactNode } from "react";
import {
  dossierEvidenceKey,
  type WorkingDossierField,
} from "../../api/working-dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { type EvidenceContext } from "./DossierEvidence.js";
import {
  dossierAnswerId,
  DossierFieldValue,
  handoffLabel,
  routeLabel,
} from "./DossierFields.js";
import { useDossierEdit } from "./useDossierEdit.js";

export type DossierEditTarget =
  | { kind: "field"; field: WorkingDossierField }
  | { kind: "node"; id: string; node?: DossierOccurrence }
  | { kind: "interface"; id: string; edge?: DossierInterface }
  | { kind: "route"; id: string; route?: DossierRoute };
interface FieldForm {
  state: DossierFieldState;
  value?: string;
  reason?: string;
  evidence: string[];
  answers: string[];
}
type InterfaceForm = Omit<
  DossierInterface,
  "producerEvidence" | "consumerEvidence"
> & {
  producerEvidence: string[];
  consumerEvidence: string[];
};
const fieldStates: DossierFieldState[] = [
  "source",
  "proposed",
  "decision",
  "missing",
  "conflict",
  "not-applicable",
];
const observationOnly: DossierFieldState[] = [
  "missing",
  "conflict",
  "not-applicable",
];

function knownEvidence(dossier: WorkingDossierView) {
  const { fields, interfaces, findings } = dossier.content;
  return new Map(
    [
      ...Object.values(fields).flatMap((value) => value.evidence ?? []),
      ...Object.values(interfaces).flatMap((edge) => [
        ...edge.producerEvidence,
        ...edge.consumerEvidence,
      ]),
      ...Object.values(findings).flatMap((finding) => finding.evidence),
    ]
      .filter(({ skillId, hash }) =>
        dossier.pins.some(
          (pin) => pin.skillId === skillId && pin.hash === hash,
        ),
      )
      .map((evidence) => [dossierEvidenceKey(evidence), evidence]),
  );
}

function EvidenceSelect({
  options,
  value,
  onChange,
}: {
  options: Map<string, DossierEvidence>;
  value?: string[];
  onChange?(value: string[]): void;
}) {
  return (
    <Select<string[]>
      mode="multiple"
      value={value}
      onChange={onChange}
      options={[...options].map(([id, locator]) => ({
        value: id,
        label: `${locator.path} · ${locator.startLine}–${locator.endLine} · ${locator.skillId}`,
      }))}
      optionFilterProp="label"
    />
  );
}

export function DossierEditor({
  dossier,
  target,
  context,
  onSaved,
  onReload,
  onCancel,
}: {
  dossier: WorkingDossierView;
  target: DossierEditTarget;
  context: EvidenceContext;
  onSaved(view: WorkingDossierView): void;
  onReload(): Promise<void>;
  onCancel(): void;
}) {
  const { t, format } = useI18n();
  const formId = useId();
  const { busy, changed, editable, failure, save, rebase } = useDossierEdit(
    dossier,
    context,
    onSaved,
    onReload,
  );
  const currentField =
    target.kind === "field"
      ? dossier.projection.fields.find((field) => field.id === target.field.id)
      : undefined;
  const unavailable =
    !editable ||
    (target.kind === "field" && !currentField) ||
    (target.kind === "node" &&
      target.node !== undefined &&
      !Object.hasOwn(dossier.content.nodes, target.id)) ||
    (target.kind === "interface" &&
      target.edge !== undefined &&
      !Object.hasOwn(dossier.content.interfaces, target.id)) ||
    (target.kind === "route" &&
      target.route !== undefined &&
      !Object.hasOwn(dossier.content.routes ?? {}, target.id));
  const evidence = knownEvidence(dossier);
  const selectedEvidence = (
    ids: string[],
    available = evidence,
    original: DossierEvidence[] = [],
  ) => {
    const originalById = new Map(
      original.map((locator) => [dossierEvidenceKey(locator), locator]),
    );
    return ids.flatMap((id) => {
      const locator = available.get(id) ?? originalById.get(id);
      return locator ? [locator] : [];
    });
  };

  const required = [{ required: true, message: t("questionnaire.required") }];
  let title: string;
  let submit: string;
  let form: ReactNode;
  if (target.kind === "field") {
    const { field } = target;
    title = `${field.ownerLabel} · ${field.label}`;
    submit = t("workingDossier.saveField");
    const previous = field.content;
    const answers = dossier.reviewedAnswers.filter((answer) =>
      answer.fields.includes(field.id),
    );
    const answerOptions = new Map(
      answers.map((answer) => [dossierAnswerId(answer), answer]),
    );
    const previousAnswers = new Map(
      (previous?.answers ?? []).map((answer) => [
        dossierAnswerId(answer),
        answer,
      ]),
    );
    const initialValues: FieldForm = {
      state: previous?.state ?? "missing",
      value: previous?.value,
      reason: previous?.reason,
      evidence: previous?.evidence?.map(dossierEvidenceKey) ?? [],
      answers: previous?.answers?.map(dossierAnswerId) ?? [],
    };
    form = (
      <Form<FieldForm>
        id={formId}
        layout="vertical"
        disabled={busy}
        initialValues={initialValues}
        onFinish={(values) => {
          const selectedAnswers = values.answers.flatMap((id) => {
            const answer = answerOptions.get(id) ?? previousAnswers.get(id);
            if (!answer) return [];
            const { questionId, resolutionRevision, personId, revision } =
              answer;
            return [{ questionId, resolutionRevision, personId, revision }];
          });
          const value = observationOnly.includes(values.state)
            ? undefined
            : values.value?.trim();
          void save({
            fields: {
              [field.id]: {
                state: values.state,
                ...(value ? { value } : {}),
                ...(values.reason?.trim()
                  ? { reason: values.reason.trim() }
                  : {}),
                evidence: selectedEvidence(
                  values.evidence,
                  evidence,
                  previous?.evidence,
                ),
                answers: selectedAnswers,
              },
            },
          });
        }}
      >
        <Form.Item name="state" label={t("workingDossier.state")}>
          <Select
            options={fieldStates.map((state) => ({
              value: state,
              label: t(`workingDossier.state.${state}`),
            }))}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate>
          {({ getFieldValue }) => {
            const state: DossierFieldState = getFieldValue("state");
            const answers: string[] = getFieldValue("answers") ?? [];
            return (
              <>
                <Form.Item
                  name="value"
                  hidden={observationOnly.includes(state)}
                  label={t("workingDossier.value")}
                  rules={observationOnly.includes(state) ? [] : required}
                >
                  <Input.TextArea rows={3} maxLength={4000} />
                </Form.Item>
                <Form.Item
                  name="reason"
                  label={t("workingDossier.reason")}
                  rules={
                    state !== "source" &&
                    (state !== "decision" || !answers.length)
                      ? required
                      : []
                  }
                >
                  <Input.TextArea rows={2} maxLength={4000} />
                </Form.Item>
                <Form.Item
                  name="evidence"
                  label={t("questionnaire.evidence")}
                  rules={state === "source" ? required : []}
                >
                  <EvidenceSelect options={evidence} />
                </Form.Item>
              </>
            );
          }}
        </Form.Item>
        <Form.Item name="answers" label={t("workingDossier.reviewedAnswers")}>
          <Select<string[]>
            mode="multiple"
            optionFilterProp="label"
            options={answers.map((answer) => ({
              value: dossierAnswerId(answer),
              label: `${answer.text} · ${format("questionnaire.answerRevision", { number: answer.revision })}`,
            }))}
          />
        </Form.Item>
      </Form>
    );
  } else if (target.kind === "node") {
    const { node, id } = target;
    title = t(
      node ? "workingDossier.editOccurrence" : "workingDossier.addOccurrence",
    );
    submit = t("workingDossier.saveOccurrence");
    const occurrences = Object.entries(dossier.content.nodes);
    const initialValues = node ?? {
      kind: "node",
      order: Math.max(-1, ...occurrences.map(([, node]) => node.order)) + 1,
    };
    form = (
      <Form<DossierOccurrence>
        id={formId}
        layout="vertical"
        disabled={busy}
        initialValues={initialValues}
        onFinish={(values) => {
          const pin = dossier.pins.find(
            ({ skillId }) => skillId === values.skillId,
          );
          if (pin)
            void save({
              nodes: {
                [id]: {
                  label: values.label.trim(),
                  skillId: pin.skillId,
                  hash: pin.hash,
                  kind: values.kind,
                  order: values.order,
                  ...(values.kind === "required-skill-call" && values.parent
                    ? { parent: values.parent }
                    : {}),
                },
              },
            });
        }}
      >
        <Form.Item
          name="label"
          label={t("workingDossier.occurrenceLabel")}
          rules={required}
        >
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item
          name="skillId"
          label={t("questionnaire.skillVersion")}
          rules={required}
        >
          <Select
            options={dossier.pins.map((pin) => ({
              value: pin.skillId,
              label: `${pin.name} · ${pin.hash.slice(0, 12)}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="kind"
          label={t("workingDossier.occurrenceKind")}
          rules={required}
        >
          <Select
            options={(["node", "required-skill-call"] as const).map((kind) => ({
              value: kind,
              label: t(`workingDossier.kind.${kind}`),
            }))}
          />
        </Form.Item>
        <Form.Item
          name="order"
          label={t("workingDossier.occurrenceOrder")}
          rules={required}
        >
          <InputNumber min={0} precision={0} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate>
          {({ getFieldValue }) =>
            getFieldValue("kind") === "required-skill-call" && (
              <Form.Item
                name="parent"
                label={t("workingDossier.parentNode")}
                rules={required}
              >
                <Select
                  options={occurrences
                    .filter(
                      ([otherId, occurrence]) =>
                        otherId !== id && occurrence.kind === "node",
                    )
                    .map(([id, occurrence]) => ({
                      value: id,
                      label: occurrence.label,
                    }))}
                />
              </Form.Item>
            )
          }
        </Form.Item>
      </Form>
    );
  } else if (target.kind === "interface") {
    const { edge, id } = target;
    title = t(
      edge ? "workingDossier.editHandoff" : "workingDossier.addHandoff",
    );
    submit = t("workingDossier.saveHandoff");
    const nodes = Object.entries(dossier.content.nodes);
    const nodeOptions = nodes.map(([id, node]) => ({
      value: id,
      label: node.label,
    }));
    const initialValues: Partial<InterfaceForm> = {
      ...edge,
      status: edge?.status ?? "proposed",
      producerEvidence: edge?.producerEvidence.map(dossierEvidenceKey) ?? [],
      consumerEvidence: edge?.consumerEvidence.map(dossierEvidenceKey) ?? [],
    };
    form = (
      <Form<InterfaceForm>
        id={formId}
        layout="vertical"
        disabled={busy}
        initialValues={initialValues}
        onFinish={(values) => {
          void save({
            interfaces: {
              [id]: {
                ...values,
                producerEvidence: selectedEvidence(
                  values.producerEvidence,
                  evidence,
                  edge?.producerEvidence,
                ),
                consumerEvidence: selectedEvidence(
                  values.consumerEvidence,
                  evidence,
                  edge?.consumerEvidence,
                ),
              },
            },
          });
        }}
      >
        <Form.Item name="status" label={t("workingDossier.state")}>
          <Select
            options={(["documented", "proposed"] as const).map((status) => ({
              value: status,
              label: t(`workingDossier.interface.${status}`),
            }))}
          />
        </Form.Item>
        {(["producer", "consumer"] as const).map((side) => (
          <section key={side}>
            <Form.Item
              name={side}
              label={t(`workingDossier.${side}`)}
              rules={required}
            >
              <Select options={nodeOptions} />
            </Form.Item>
            <Form.Item noStyle shouldUpdate>
              {({ getFieldValue }) => {
                const node = dossier.content.nodes[getFieldValue(side)];
                const available = new Map(
                  [...evidence].filter(
                    ([, locator]) =>
                      locator.skillId === node?.skillId &&
                      locator.hash === node.hash,
                  ),
                );
                return (
                  <Form.Item
                    name={`${side}Evidence`}
                    label={t("questionnaire.evidence")}
                    rules={
                      getFieldValue("status") === "documented" ? required : []
                    }
                  >
                    <EvidenceSelect options={available} />
                  </Form.Item>
                );
              }}
            </Form.Item>
          </section>
        ))}
      </Form>
    );
  } else {
    const { route, id } = target;
    title = t(route ? "workingDossier.editRoute" : "workingDossier.addRoute");
    submit = t("workingDossier.saveRoute");
    const options = Object.entries(dossier.content.nodes)
      .filter(([, node]) => node.kind === "node")
      .map(([value, node]) => ({ value, label: node.label }));
    form = (
      <Form<DossierRoute>
        id={formId}
        name={formId}
        layout="vertical"
        disabled={busy || unavailable}
        initialValues={route ?? { kind: "next" }}
        onFinish={({ from, to, kind, condition, maxVisits }) => {
          if (unavailable) return;
          void save({
            routes: {
              [id]: {
                from,
                to,
                kind,
                ...(condition?.trim() ? { condition: condition.trim() } : {}),
                ...(kind === "rework" ? { maxVisits } : {}),
              },
            },
          });
        }}
      >
        <Form.Item
          name="from"
          label={t("workingDossier.routeFrom")}
          rules={required}
        >
          <Select
            aria-label={t("workingDossier.routeFrom")}
            options={options}
          />
        </Form.Item>
        <Form.Item
          name="to"
          label={t("workingDossier.routeTo")}
          rules={required}
        >
          <Select aria-label={t("workingDossier.routeTo")} options={options} />
        </Form.Item>
        <Form.Item
          name="kind"
          label={t("workingDossier.routeKind")}
          rules={required}
        >
          <Select
            aria-label={t("workingDossier.routeKind")}
            options={(["next", "optional", "rework"] as const).map((kind) => ({
              value: kind,
              label: t(`workingDossier.route.${kind}`),
            }))}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate>
          {({ getFieldValue }) => {
            const kind = getFieldValue("kind");
            return (
              <>
                <Form.Item
                  name="condition"
                  label={t("workingDossier.routeCondition")}
                  rules={kind === "next" ? [] : required}
                >
                  <Input.TextArea rows={2} maxLength={4000} />
                </Form.Item>
                {kind === "rework" && (
                  <Form.Item
                    name="maxVisits"
                    label={t("workingDossier.maxVisits")}
                    rules={required}
                  >
                    <InputNumber min={1} precision={0} />
                  </Form.Item>
                )}
              </>
            );
          }}
        </Form.Item>
      </Form>
    );
  }
  let currentIdentity: string | undefined;
  if (target.kind === "node") {
    const node = dossier.content.nodes[target.id];
    if (node)
      currentIdentity = `${node.label} · ${node.skillId} · ${node.hash}`;
  } else if (target.kind === "interface") {
    const edge = dossier.content.interfaces[target.id];
    if (edge)
      currentIdentity = handoffLabel(
        dossier.content,
        edge.producer,
        edge.consumer,
      );
  } else if (target.kind === "route") {
    const route = dossier.content.routes?.[target.id];
    if (route) currentIdentity = routeLabel(dossier.content, route, t, format);
  }
  return (
    <Modal
      open
      title={title}
      okText={submit}
      cancelText={t("common.cancel")}
      okButtonProps={{
        htmlType: "submit",
        form: formId,
        disabled: changed || unavailable,
      }}
      confirmLoading={busy}
      onCancel={onCancel}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <div className="working-dossier-editor">
        {failure && <Alert type="error" showIcon title={failure} />}
        {changed && (
          <Alert
            type="warning"
            showIcon
            title={t("workingDossier.conflict")}
            description={
              <Space orientation="vertical">
                <span>
                  {format("workingDossier.conflictDetail", {
                    revision: dossier.revision,
                  })}
                </span>
                {currentField ? (
                  <DossierFieldValue field={currentField} context={context} />
                ) : (
                  currentIdentity
                )}
                {!unavailable && (
                  <Button onClick={rebase}>
                    {t("workingDossier.reconcile")}
                  </Button>
                )}
              </Space>
            }
          />
        )}
        {unavailable && (
          <Alert
            type="warning"
            showIcon
            title={t("workingDossier.editUnavailable")}
          />
        )}
        {form}
      </div>
    </Modal>
  );
}
