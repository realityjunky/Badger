import {
  Alert,
  AutoComplete,
  Button,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import type { TableColumnsType } from "antd";
import { useState } from "react";
import {
  assignWorkflowRole,
  removeWorkflowRole,
  WORKFLOW_ROLES,
  type WorkflowBinding,
  type WorkflowGroupMember,
  type WorkflowRole,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { MessageId } from "../../i18n/catalog.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";
import {
  resendInvitation,
  type InvitationDelivery,
} from "../../api/organization.js";
import { groupWorkflowBindings, type WorkflowTeamMember } from "./team.js";

const ROLE_MESSAGES: Record<WorkflowRole, MessageId> = {
  "Workflow owner": "workflow.role.owner",
  Engineer: "workflow.role.engineer",
  "Field expert": "workflow.role.expert",
  Operator: "workflow.role.operator",
  Observer: "workflow.role.observer",
};

export function WorkflowTeam({
  basePath,
  workflowId,
  bindings,
  groupMembers,
  mayManage,
  onChanged,
}: {
  basePath: string;
  workflowId: string;
  bindings: WorkflowBinding[];
  groupMembers: WorkflowGroupMember[];
  mayManage: boolean;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ email: string; role: WorkflowRole }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [delivery, setDelivery] = useState<InvitationDelivery | null>(null);
  const members = groupWorkflowBindings(bindings);

  const assign = async ({
    email,
    role,
  }: {
    email: string;
    role: WorkflowRole;
  }) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await assignWorkflowRole(
        basePath,
        workflowId,
        email.trim(),
        role,
      );
      if (result.kind === "ok") {
        setFailure(null);
        setDelivery(result.value.invitationDelivery ?? null);
        form.resetFields(["email"]);
        onChanged();
      } else setFailure(result);
    } finally {
      setBusy(false);
    }
  };
  const resend = async (binding: WorkflowBinding) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resendInvitation(
        basePath,
        binding.id,
        binding.revision,
      );
      if (result.kind === "ok") {
        setFailure(null);
        setDelivery(result.invitationDelivery ?? null);
      } else setFailure({ kind: "failed", message: "" });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (binding: WorkflowBinding) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await removeWorkflowRole(basePath, binding);
      if (result.kind === "ok") onChanged();
      else setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<WorkflowTeamMember> = [
    {
      title: t("admin.members.name"),
      dataIndex: "displayName",
      key: "name",
    },
    {
      title: t("admin.members.email"),
      dataIndex: "email",
      key: "email",
    },
    {
      title: t("admin.members.roles"),
      key: "roles",
      render: (_, member) => (
        <Space size={[4, 4]} wrap>
          {member.bindings.map((binding) => (
            <Tag key={binding.id}>
              {t(ROLE_MESSAGES[binding.role])}
              {binding.pending && ` · ${t("workflow.invited")}`}
            </Tag>
          ))}
        </Space>
      ),
    },
    ...(mayManage
      ? [
          {
            title: "",
            key: "actions",
            render: (_: unknown, member: WorkflowTeamMember) => (
              <Space size={[4, 4]} wrap>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => void resend(member.bindings[0]!)}
                >
                  {t("admin.invite.resend")}
                </Button>
                {member.bindings.map((binding) => (
                  <Popconfirm
                    key={binding.id}
                    title={t("workflow.removeConfirm")}
                    onConfirm={() => remove(binding)}
                    okText={t("workflow.remove")}
                    cancelText={t("workflow.cancel")}
                  >
                    <Button
                      size="small"
                      danger
                      disabled={busy}
                      aria-label={`${t("workflow.remove")} · ${t(ROLE_MESSAGES[binding.role])} · ${member.email}`}
                    >
                      {t("workflow.remove")} · {t(ROLE_MESSAGES[binding.role])}
                    </Button>
                  </Popconfirm>
                ))}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <section className="workflow-panel" aria-labelledby="workflow-team-title">
      <h2 id="workflow-team-title">{t("workflow.team")}</h2>
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onChanged} />
      )}
      {delivery !== null && (
        <Alert
          showIcon
          type={delivery.status === "sent" ? "success" : "warning"}
          message={t(`admin.invite.delivery.${delivery.status}`)}
        />
      )}
      <Table<WorkflowTeamMember>
        className="workflow-team-table"
        rowKey="key"
        dataSource={members}
        columns={columns}
        pagination={false}
        size="small"
        tableLayout="fixed"
        scroll={{ x: 720 }}
      />
      {mayManage && (
        <Form
          form={form}
          layout="vertical"
          className="workflow-role-form"
          initialValues={{ role: "Engineer" }}
          disabled={busy}
          onFinish={(values) => void assign(values)}
        >
          <Form.Item
            name="email"
            label={t("workflow.email")}
            extra={t("workflow.emailHelp")}
            validateTrigger="onBlur"
            rules={[
              {
                required: true,
                type: "email",
                message: t("workflow.emailRequired"),
              },
            ]}
          >
            <AutoComplete
              disabled={busy}
              defaultActiveFirstOption={false}
              options={groupMembers.map((member) => ({
                value: member.email,
                label: `${member.displayName} · ${member.email}`,
              }))}
              filterOption={(input, option) =>
                (option?.label ?? "")
                  .toLowerCase()
                  .includes(input.trim().toLowerCase())
              }
            >
              <Input type="email" autoComplete="email" />
            </AutoComplete>
          </Form.Item>
          <Form.Item
            name="role"
            label={t("workflow.role")}
            rules={[{ required: true }]}
          >
            <Select
              options={WORKFLOW_ROLES.map((role) => ({
                value: role,
                label: t(ROLE_MESSAGES[role]),
              }))}
            />
          </Form.Item>
          <Form.Item>
            <Button htmlType="submit" loading={busy}>
              {t("workflow.assign")}
            </Button>
          </Form.Item>
        </Form>
      )}
    </section>
  );
}
