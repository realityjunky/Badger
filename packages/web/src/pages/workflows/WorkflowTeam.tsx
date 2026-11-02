import { Alert, Button, Form, Input, Popconfirm, Select, Tag } from "antd";
import { useState } from "react";
import {
  assignWorkflowRole,
  removeWorkflowRole,
  WORKFLOW_ROLES,
  type WorkflowBinding,
  type WorkflowRole,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { MessageId } from "../../i18n/catalog.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";
import {
  resendInvitation,
  type InvitationDelivery,
} from "../../api/organization.js";

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
  mayManage,
  onChanged,
}: {
  basePath: string;
  workflowId: string;
  bindings: WorkflowBinding[];
  mayManage: boolean;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ email: string; role: WorkflowRole }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [delivery, setDelivery] = useState<InvitationDelivery | null>(null);

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
      <ul className="workflow-roles">
        {bindings.map((binding) => (
          <li key={binding.id}>
            <div className="workflow-role-person">
              {binding.displayName !== null && (
                <strong>{binding.displayName}</strong>
              )}
              <span>{binding.email}</span>
            </div>
            <Tag>{t(ROLE_MESSAGES[binding.role])}</Tag>
            {binding.pending && <Tag>{t("workflow.invited")}</Tag>}
            {mayManage && (
              <Button disabled={busy} onClick={() => void resend(binding)}>
                {t("admin.invite.resend")}
              </Button>
            )}
            {mayManage && (
              <Popconfirm
                title={t("workflow.removeConfirm")}
                onConfirm={() => remove(binding)}
                okText={t("workflow.remove")}
                cancelText={t("workflow.cancel")}
              >
                <Button
                  danger
                  disabled={busy}
                  aria-label={`${t("workflow.remove")} ${t(ROLE_MESSAGES[binding.role])} · ${binding.email}`}
                >
                  {t("workflow.remove")}
                </Button>
              </Popconfirm>
            )}
          </li>
        ))}
      </ul>
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
            rules={[
              {
                required: true,
                type: "email",
                message: t("workflow.emailRequired"),
              },
            ]}
          >
            <Input type="email" autoComplete="email" />
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
