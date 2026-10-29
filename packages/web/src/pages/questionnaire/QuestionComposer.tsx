import { Alert, Button, Form, Input, InputNumber, Select, Space } from "antd";
import { useRef, useState } from "react";
import {
  questionnaireRequest,
  type Question,
  type QuestionContent,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

const TOPICS = [
  "scope",
  "inputs",
  "prerequisites",
  "bindings",
  "interfaces",
  "requiredSkillCalls",
  "augmentations",
  "outputSchemas",
  "completionEvidence",
  "decisions",
  "guardrails",
  "routes",
  "boundedCycles",
  "capabilities",
  "finalization",
  "executableDisclosures",
  "recoveryPolicy",
] as const;
interface Values extends Omit<QuestionContent, "assignees" | "evidence"> {
  assignees: string[];
  evidence: {
    version: string;
    path: string;
    startLine: number;
    endLine: number;
  }[];
}

export function QuestionComposer({
  basePath,
  path,
  roundId,
  question,
  view,
  onSaved,
  onCancel,
}: {
  basePath: string;
  path: string;
  roundId: string;
  question?: Question;
  view: QuestionnaireView;
  onSaved(question: Question): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<Values>();
  const revision = useRef(question?.revision);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const required = [{ required: true, message: t("questionnaire.required") }];
  const initial: Values = question
    ? {
        ...question,
        assignees: question.assignees.map((a) =>
          a.kind === "person" ? `person:${a.personId}` : `role:${a.role}`,
        ),
        evidence: question.evidence.map((e) => ({
          ...e,
          version: JSON.stringify([e.skillId, e.versionHash]),
        })),
      }
    : {
        text: "",
        topic: "scope",
        priority: 10,
        rationale: "",
        evidence: [],
        targets: [{ kind: "workflow", id: view.workflow.id }],
        assignees: [
          view.assignees.some((a) => a.role === "Field expert")
            ? "role:Field expert"
            : "role:Workflow owner",
        ],
      };
  const save = async (values: Values) => {
    setBusy(true);
    setFailure(null);
    try {
      const content: QuestionContent = {
        ...values,
        evidence: (values.evidence ?? []).map((e) => {
          const [skillId, versionHash] = JSON.parse(e.version) as [
            string,
            string,
          ];
          return {
            skillId,
            versionHash,
            path: e.path,
            startLine: e.startLine,
            endLine: e.endLine,
          };
        }),
        assignees: values.assignees.map((value) =>
          value.startsWith("person:")
            ? { kind: "person", personId: value.slice(7) }
            : {
                kind: "role",
                role: value.slice(5) as "Workflow owner" | "Field expert",
              },
        ),
      };
      const result = await questionnaireRequest<{ question: Question }>(
        basePath,
        question
          ? `${path}/questions/${encodeURIComponent(question.id)}`
          : `${path}/rounds/${encodeURIComponent(roundId)}/questions`,
        question ? "PATCH" : "POST",
        { ...content, ...(question ? { revision: revision.current } : {}) },
      );
      onSaved(result.question);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const people = [
    ...new Map(
      view.assignees
        .filter((a) => a.personId !== null)
        .map((a) => [a.personId, a]),
    ).values(),
  ];
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initial}
      onFinish={(values) => void save(values)}
    >
      <h2 className="pane-title">
        {t(
          question ? "questionnaire.editQuestion" : "questionnaire.newQuestion",
        )}
      </h2>
      {failure && <Alert type="error" showIcon message={failure} />}
      <Form.Item
        name="text"
        label={t("questionnaire.questionText")}
        rules={required}
      >
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 12 }}
          maxLength={20000}
        />
      </Form.Item>
      <Form.Item name="topic" label={t("questionnaire.topic")} rules={required}>
        <Select
          options={TOPICS.map((value) => ({
            value,
            label: t(`questionnaire.topic.${value}`),
          }))}
        />
      </Form.Item>
      <Form.Item
        name="rationale"
        label={t("questionnaire.rationale")}
        rules={required}
      >
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 8 }}
          maxLength={4000}
        />
      </Form.Item>
      <Form.Item
        name="priority"
        label={t("questionnaire.priority")}
        rules={required}
      >
        <InputNumber min={0} max={100} precision={0} />
      </Form.Item>
      <Form.Item
        name="assignees"
        label={t("questionnaire.assignees")}
        rules={required}
      >
        <Select
          mode="multiple"
          options={[
            {
              value: "role:Field expert",
              label: t("questionnaire.allExperts"),
            },
            { value: "role:Workflow owner", label: t("questionnaire.owner") },
            ...people.map((a) => ({
              value: `person:${a.personId}`,
              label: a.name,
            })),
          ]}
        />
      </Form.Item>
      <h3>{t("questionnaire.targets")}</h3>
      <Form.List name="targets">
        {(entries, { add, remove }) => (
          <>
            {entries.map((entry) => (
              <div className="questionnaire-fields" key={entry.key}>
                <Form.Item
                  name={[entry.name, "kind"]}
                  label={t("questionnaire.targetKind")}
                  rules={required}
                >
                  <Select
                    onChange={(kind) =>
                      form.setFieldValue(
                        ["targets", entry.name, "id"],
                        kind === "workflow" ? view.workflow.id : "",
                      )
                    }
                    options={(
                      ["workflow", "node", "skill", "interface"] as const
                    ).map((value) => ({
                      value,
                      label: t(`questionnaire.target.${value}`),
                    }))}
                  />
                </Form.Item>
                <Form.Item noStyle shouldUpdate>
                  {() => {
                    const kind = form.getFieldValue([
                      "targets",
                      entry.name,
                      "kind",
                    ]);
                    return (
                      <Form.Item
                        name={[entry.name, "id"]}
                        hidden={kind === "workflow"}
                        label={t("questionnaire.targetId")}
                        rules={required}
                      >
                        {kind === "skill" ? (
                          <Select
                            options={view.pins.map((pin) => ({
                              value: pin.skillId,
                              label: pin.skillName,
                            }))}
                          />
                        ) : (
                          <Input />
                        )}
                      </Form.Item>
                    );
                  }}
                </Form.Item>
                <Button
                  onClick={() => remove(entry.name)}
                  disabled={entries.length === 1}
                >
                  {t("questionnaire.remove")}
                </Button>
              </div>
            ))}
            <Button onClick={() => add({ kind: "node", id: "" })}>
              {t("questionnaire.addTarget")}
            </Button>
          </>
        )}
      </Form.List>
      <h3>{t("questionnaire.evidence")}</h3>
      <Form.List name="evidence">
        {(entries, { add, remove }) => (
          <>
            {entries.map((entry) => (
              <fieldset className="questionnaire-evidence" key={entry.key}>
                <legend>{t("questionnaire.evidence")}</legend>
                <Form.Item
                  name={[entry.name, "version"]}
                  label={t("questionnaire.skillVersion")}
                  rules={required}
                >
                  <Select
                    options={view.pins.map((p) => ({
                      value: JSON.stringify([p.skillId, p.hash]),
                      label: `${p.skillName} · ${p.hash.slice(0, 12)}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  name={[entry.name, "path"]}
                  label={t("questionnaire.filePath")}
                  rules={required}
                >
                  <Input />
                </Form.Item>
                <div className="questionnaire-fields">
                  <Form.Item
                    name={[entry.name, "startLine"]}
                    label={t("questionnaire.startLine")}
                    rules={required}
                  >
                    <InputNumber min={1} precision={0} />
                  </Form.Item>
                  <Form.Item
                    name={[entry.name, "endLine"]}
                    label={t("questionnaire.endLine")}
                    rules={required}
                  >
                    <InputNumber min={1} precision={0} />
                  </Form.Item>
                </div>
                <Button onClick={() => remove(entry.name)}>
                  {t("questionnaire.remove")}
                </Button>
              </fieldset>
            ))}
            <Button
              disabled={view.pins.length === 0}
              onClick={() => add({ startLine: 1, endLine: 1 })}
            >
              {t("questionnaire.addEvidence")}
            </Button>
          </>
        )}
      </Form.List>
      <Space className="questionnaire-actions" wrap>
        <Button type="primary" htmlType="submit" loading={busy}>
          {t("questionnaire.saveQuestion")}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
      </Space>
    </Form>
  );
}
