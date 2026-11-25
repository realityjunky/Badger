import { ReloadOutlined } from "@ant-design/icons";
import { Button, Tooltip, type ButtonProps } from "antd";
import { useI18n } from "../i18n/I18nContext.js";

export function ReloadRecordsButton({
  disabled,
  loading,
  onClick,
}: Pick<ButtonProps, "disabled" | "loading" | "onClick">) {
  const { t } = useI18n();
  const label = t("workflow.reload");
  return (
    <Tooltip title={label} trigger={["hover", "focus"]}>
      <Button
        type="text"
        aria-label={label}
        icon={<ReloadOutlined aria-hidden="true" />}
        disabled={disabled}
        loading={loading}
        onClick={onClick}
      />
    </Tooltip>
  );
}
