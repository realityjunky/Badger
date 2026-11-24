import { Button, Table } from "antd";
import type { VersionDiff } from "../../api/skills.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function VersionChanges({
  diff,
  loading = false,
  onSelectFile,
}: {
  diff: VersionDiff | null;
  loading?: boolean;
  onSelectFile?(path: string): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Table
        size="small"
        rowKey="path"
        loading={loading}
        dataSource={diff?.files ?? []}
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: t("skills.noDifferences") }}
        columns={[
          {
            title: t("skills.path"),
            dataIndex: "path",
            render: (relative: string) =>
              onSelectFile ? (
                <Button
                  type="link"
                  className="skills-path-button"
                  onClick={() => onSelectFile(relative)}
                >
                  {relative}
                </Button>
              ) : (
                <code className="skills-hash">{relative}</code>
              ),
          },
          {
            title: t("skills.change"),
            dataIndex: "status",
            render: (status: "added" | "removed" | "modified") =>
              t(`skills.${status}`),
          },
        ]}
      />
      {!!diff?.scripts.length && (
        <section>
          <h3>{t("skills.effects")}</h3>
          {diff.scripts.map((script) => (
            <p key={script.path}>
              <code>{script.path}</code>:{" "}
              {script.before === null
                ? "—"
                : script.before === "undeclared"
                  ? t("skills.undeclared")
                  : script.before
                      .map((effect) => t(`skills.effect.${effect}`))
                      .join(", ")}{" "}
              →{" "}
              {script.after === null
                ? "—"
                : script.after === "undeclared"
                  ? t("skills.undeclared")
                  : script.after
                      .map((effect) => t(`skills.effect.${effect}`))
                      .join(", ")}
            </p>
          ))}
        </section>
      )}
    </>
  );
}
