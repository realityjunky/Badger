import { Alert, Button, Select, Space, Table } from "antd";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  loadDiff,
  type SkillVersion,
  type VersionDiff,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { VersionFile } from "./VersionFile.js";

export function VersionComparison({
  skillId,
  versions,
  selected,
}: {
  skillId: string;
  versions: SkillVersion[];
  selected: SkillVersion;
}) {
  const { t } = useI18n();
  const [parameters, setParameters] = useSearchParams();
  const basePath = readBasePath(document);
  const from =
    parameters.get("from") ??
    versions.find((version) => version.hash !== selected.hash)?.hash ??
    selected.hash;
  const to = parameters.get("to") ?? selected.hash;
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [failed, setFailed] = useState(false);
  const path = parameters.get("diffPath");
  const entry = diff?.files.find((file) => file.path === path);
  const options = versions.map((version) => ({
    value: version.hash,
    label: `${version.hash.slice(0, 12)} · ${new Date(version.createdAt).toLocaleString()}`,
  }));
  function change(key: string, value: string) {
    setParameters((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    setDiff(null);
    setFailed(false);
    void loadDiff(basePath, skillId, from, to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDiff(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [basePath, skillId, from, to]);
  return (
    <Space orientation="vertical" size="middle" className="skills-full-width">
      <div className="skills-compare-selectors">
        <label className="field">
          {t("skills.before")}
          <Select
            aria-label={t("skills.before")}
            value={from}
            options={options}
            onChange={(value) => change("from", value)}
          />
        </label>
        <label className="field">
          {t("skills.after")}
          <Select
            aria-label={t("skills.after")}
            value={to}
            options={options}
            onChange={(value) => change("to", value)}
          />
        </label>
      </div>
      {failed && <Alert type="error" title={t("skills.failed")} />}
      <Table
        size="small"
        rowKey="path"
        loading={diff === null && !failed}
        dataSource={diff?.files ?? []}
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: t("skills.noDifferences") }}
        columns={[
          {
            title: t("skills.path"),
            dataIndex: "path",
            render: (relative: string) => (
              <Button
                type="link"
                className="skills-path-button"
                onClick={() => change("diffPath", relative)}
              >
                {relative}
              </Button>
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
      {(diff?.scripts.length ?? 0) > 0 && (
        <section>
          <h3>{t("skills.effects")}</h3>
          {diff?.scripts.map((script) => (
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
      {entry !== undefined && (
        <section>
          <h3 className="skills-hash">{entry.path}</h3>
          <div className="skills-compare-files">
            <div>
              <h4>{t("skills.before")}</h4>
              <VersionFile
                skillId={skillId}
                hash={entry.before === null ? null : from}
                path={entry.path}
              />
            </div>
            <div>
              <h4>{t("skills.after")}</h4>
              <VersionFile
                skillId={skillId}
                hash={entry.after === null ? null : to}
                path={entry.path}
              />
            </div>
          </div>
        </section>
      )}
    </Space>
  );
}
