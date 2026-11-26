import { Cascader } from "antd";
import { RightOutlined } from "@ant-design/icons";
import {
  skillVersionCaption,
  type QuestionnaireSubject,
  type QuestionnaireVersion,
  type SkillQuestionnaireOption,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { workflowVersionLabel } from "../../util/workflowVersion.js";

interface SubjectOption {
  value: string;
  label: string;
  children?: SubjectOption[];
  subject?: QuestionnaireSubject;
}
type SubjectGroup = SubjectOption & { children: SubjectOption[] };

export function QuestionnaireSubjectPicker({
  workflows,
  skills,
  selection,
  onSelect,
}: {
  workflows: QuestionnaireVersion[];
  skills: SkillQuestionnaireOption[];
  selection: QuestionnaireSubject | null;
  onSelect(subject: QuestionnaireSubject): void;
}) {
  const { t } = useI18n();
  const workflowOptions = new Map<string, SubjectGroup>();
  const skillOptions = new Map<string, SubjectGroup>();

  function addVersion(
    groups: Map<string, SubjectGroup>,
    id: string,
    name: string,
    version: SubjectOption,
  ) {
    const group = groups.get(id);
    if (group) group.children.push(version);
    else groups.set(id, { value: id, label: name, children: [version] });
  }

  for (const version of workflows)
    addVersion(workflowOptions, version.workflowId, version.workflowName, {
      value: version.versionId,
      label: workflowVersionLabel(version),
      subject: version,
    });
  for (const version of skills)
    addVersion(
      skillOptions,
      version.skillId,
      `${version.skillName} · ${version.groupName}`,
      {
        value: version.versionHash,
        label:
          skillVersionCaption(version.versionHash, version.label) +
          (version.retiredAt
            ? ` · ${t("questionnaire.retiredSkillVersion")}`
            : ""),
        subject: {
          kind: "skill",
          skillId: version.skillId,
          versionHash: version.versionHash,
        },
      },
    );

  const options = [
    {
      value: "workflow",
      label: t("nav.workflows"),
      children: [...workflowOptions.values()],
    },
    {
      value: "skill",
      label: t("nav.skills"),
      children: [...skillOptions.values()],
    },
  ].filter((group) => group.children.length > 0);
  const value =
    selection &&
    ("workflowId" in selection
      ? ["workflow", selection.workflowId, selection.versionId]
      : ["skill", selection.skillId, selection.versionHash]);

  return (
    <Cascader<SubjectOption>
      className="questionnaire-subject-picker"
      classNames={{ popup: { root: "questionnaire-subject-popup" } }}
      aria-label={t("questionnaire.subject")}
      placeholder={t("questionnaire.chooseVersion")}
      value={value ?? []}
      options={options}
      allowClear={false}
      expandIcon={<RightOutlined aria-hidden="true" />}
      showSearch
      onChange={(_, path) => {
        const subject = path.at(-1)?.subject;
        if (subject) onSelect(subject);
      }}
    />
  );
}
