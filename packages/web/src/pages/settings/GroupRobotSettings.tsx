import { Alert, Select } from "antd";
import { useEffect, useState } from "react";
import { notificationRequest } from "../../api/notifications.js";
import { ledGroupIds, type Group } from "../../api/organization.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { usePreferences } from "../../preferences/PreferencesContext.js";
import { RobotChannelSettings } from "./RobotChannelSettings.js";

export function GroupRobotSettings() {
  const { person } = usePreferences();
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const administrator = person?.roles.includes("Administrator") ?? false;
  const groupLead =
    person?.groups.some((group) => group.role === "Group lead") ?? false;
  useEffect(() => {
    if (!administrator && !groupLead) return;
    const controller = new AbortController();
    void notificationRequest<{ groups: Group[] }>(
      basePath,
      "/groups",
      "GET",
      undefined,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setGroups(result.value.groups);
      else setFailed(true);
    });
    return () => controller.abort();
  }, [basePath, administrator, groupLead]);
  if (!administrator && !groupLead) return null;
  const led = ledGroupIds(person?.groups ?? [], groups);
  const manageable = groups.filter(
    (group) => administrator || led.has(group.id),
  );
  return (
    <section className="settings-panel">
      <h2>{t("notifications.groupDefaults")}</h2>
      <p className="muted">{t("notifications.groupDefaultsHelp")}</p>
      {failed && <Alert type="error" message={t("notifications.failed")} />}
      <label htmlFor="notification-group">{t("notifications.group")}</label>
      <Select
        id="notification-group"
        value={selected}
        onChange={setSelected}
        options={manageable.map((group) => ({
          value: group.id,
          label: group.name,
        }))}
      />
      {selected && (
        <RobotChannelSettings
          key={selected}
          basePath={basePath}
          scope="groups"
          scopeId={selected}
        />
      )}
    </section>
  );
}
