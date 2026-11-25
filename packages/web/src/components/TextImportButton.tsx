import { DownOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";

export function TextImportButton({
  label,
  sources,
  onImport,
  disabled,
}: {
  label: string;
  sources: { key: string; label: string }[];
  onImport(key: string): void;
  disabled?: boolean;
}) {
  if (!sources.length) return null;
  if (sources.length === 1)
    return (
      <Button
        size="small"
        disabled={disabled}
        onClick={() => onImport(sources[0]!.key)}
      >
        {label}
      </Button>
    );
  return (
    <Dropdown
      trigger={["click"]}
      disabled={disabled}
      menu={{
        items: sources.map(({ key, label }) => ({
          key,
          label: <span className="text-import-option">{label}</span>,
        })),
        onClick: ({ key }) => onImport(key),
      }}
    >
      <Button
        size="small"
        disabled={disabled}
        aria-haspopup="menu"
        icon={<DownOutlined aria-hidden="true" />}
        iconPlacement="end"
      >
        {label}
      </Button>
    </Dropdown>
  );
}
