import { Alert, Collapse, Tag } from "antd";
import type { EvidenceChange } from "../api/version-changes.js";
import { useI18n } from "../i18n/I18nContext.js";
import { VersionFile } from "../pages/skills/VersionFile.js";

/** File previews load only when a person expands the changed citation. */
export function EvidenceChanges({
  changes = [],
}: {
  changes?: EvidenceChange[];
}) {
  const { t } = useI18n();
  if (changes.length === 0) return null;
  return (
    <section
      className="evidence-changes"
      aria-label={t("versions.evidenceChanged")}
    >
      <Alert type="warning" showIcon title={t("versions.evidenceChanged")} />
      <Collapse
        items={changes.map((change) => ({
          key: `${change.skillId}:${change.fromVersionHash}:${change.path}`,
          label: (
            <>
              <span>{change.path}</span>{" "}
              <Tag>{t(`versions.${change.status}`)}</Tag>
            </>
          ),
          children: (
            <div className="skills-compare-files">
              <div>
                <h4>
                  {t("skills.before")} · {change.fromVersionHash.slice(0, 12)}
                </h4>
                <VersionFile
                  skillId={change.skillId}
                  hash={change.beforeHash ? change.fromVersionHash : null}
                  path={change.path}
                />
              </div>
              <div>
                <h4>
                  {t("skills.after")}{" "}
                  {change.toVersionHash &&
                    `· ${change.toVersionHash.slice(0, 12)}`}
                </h4>
                <VersionFile
                  skillId={change.skillId}
                  hash={change.afterHash ? change.toVersionHash : null}
                  path={change.path}
                />
              </div>
            </div>
          ),
        }))}
      />
    </section>
  );
}
