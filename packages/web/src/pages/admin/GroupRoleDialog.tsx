import { Alert, Button, Modal, Select } from "antd";
import { useState } from "react";
import type {
  Member,
  MemberBinding,
  WriteOutcome,
} from "../../api/organization.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function GroupRoleDialog({
  member,
  binding,
  groupName,
  onSave,
  onReload,
  onClose,
}: {
  member: Member;
  binding: MemberBinding;
  groupName: string;
  onSave(role: string): Promise<WriteOutcome>;
  onReload(): Promise<void>;
  onClose(): void;
}) {
  const { t, format } = useI18n();
  const [role, setRole] = useState(binding.role);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async () => {
    if (busy || role === binding.role || failure !== null) return;
    setBusy(true);
    try {
      const result = await onSave(role);
      if (result.kind === "ok") onClose();
      else
        setFailure(
          result.kind === "conflict"
            ? t("admin.role.conflict")
            : result.kind === "denied"
              ? t("admin.denied")
              : t("admin.writeFailed"),
        );
    } catch {
      setFailure(t("admin.writeFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t("admin.role.change")}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => void save()}
      confirmLoading={busy}
      okText={t("admin.role.confirm")}
      cancelText={t("common.cancel")}
      okButtonProps={{ disabled: role === binding.role || failure !== null }}
      cancelButtonProps={{ disabled: busy }}
    >
      <p>
        {format("admin.role.review", {
          name: member.person.displayName,
          group: groupName,
          role: binding.role,
        })}
      </p>
      <Select
        aria-label={t("admin.invite.role")}
        value={role}
        disabled={busy}
        style={{ width: "100%" }}
        options={["Member", "Group lead"].map((value) => ({
          value,
          label: value,
        }))}
        onChange={setRole}
      />
      <p className="muted">{t("admin.role.inheritance")}</p>
      {failure && (
        <Alert
          type="warning"
          showIcon
          title={failure}
          action={
            <Button onClick={() => void onReload().then(onClose)}>
              {t("admin.role.reload")}
            </Button>
          }
        />
      )}
    </Modal>
  );
}
