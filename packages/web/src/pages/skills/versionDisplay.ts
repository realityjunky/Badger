import type { SkillVersion } from "../../api/skills.js";
import type { I18n } from "../../i18n/I18nContext.js";

export function skillVersionPath(skillId: string, hash: string) {
  return `/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(hash)}`;
}

export function skillVersionOption(
  version: Pick<SkillVersion, "hash" | "createdAt" | "label" | "retiredAt">,
  { locale, t }: Pick<I18n, "locale" | "t">,
) {
  const label = version.label ?? t("skills.unlabelled");
  const date = new Date(version.createdAt).toLocaleString(locale);
  const status = version.retiredAt ? ` · ${t("skills.retired")}` : "";
  return {
    value: version.hash,
    label: `${label} · ${date} · ${version.hash.slice(0, 12)}${status}`,
  };
}

export function latestSkillVersion(versions: SkillVersion[] | null) {
  return versions?.find((version) => !version.retiredAt) ?? versions?.[0];
}
