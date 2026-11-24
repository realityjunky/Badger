import { Alert, Select, Space } from "antd";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  loadDiff,
  type SkillVersion,
  type VersionDiff,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { VersionChanges } from "./VersionChanges.js";
import { VersionFile } from "./VersionFile.js";
import { skillVersionOption } from "./versionDisplay.js";

export function VersionComparison({
  skillId,
  versions,
  selected,
}: {
  skillId: string;
  versions: SkillVersion[];
  selected: SkillVersion;
}) {
  const i18n = useI18n();
  const { t } = i18n;
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
  const options = versions.map((version) => skillVersionOption(version, i18n));
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
      <VersionChanges
        diff={diff}
        loading={diff === null && !failed}
        onSelectFile={(relative) => change("diffPath", relative)}
      />
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
