import { Button, Radio, Switch, Tabs } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import { usePreferences } from "../preferences/PreferencesContext.js";
import {
  clampFontScale,
  FONT_SCALE_STEP,
  type Language,
  type ThemeChoice,
} from "../preferences/model.js";

const TAB_KEYS = [
  "appearance",
  "language",
  "notifications",
  "tokens",
  "channels",
] as const;

type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | undefined): value is TabKey {
  return TAB_KEYS.includes(value as TabKey);
}

/** Appearance, language, and the other personal choices; each tab has a URL. */
export function SettingsPage() {
  const { t, format } = useI18n();
  const { preferences, update, saveState } = usePreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const segment = location.pathname.split("/")[2];
  const activeTab: TabKey = isTabKey(segment) ? segment : "appearance";

  const placeholder = <p className="muted">{t("common.placeholderHint")}</p>;

  return (
    <div className="page" data-testid="page-settings">
      <PageHeader
        title={t("page.settings.title")}
        description={t("page.settings.description")}
      />
      {saveState !== "idle" && (
        <p
          className={`save-state save-state-${saveState}`}
          role="status"
          data-testid="save-state"
        >
          {saveState === "saved"
            ? t("settings.saved")
            : saveState === "saving"
              ? t("settings.saving")
              : t("settings.failed")}
        </p>
      )}
      <Tabs
        className="underline-tabs"
        activeKey={activeTab}
        onChange={(key) => navigate(`/settings/${key}`)}
        items={[
          {
            key: "appearance",
            label: t("settings.appearance.title"),
            children: (
              <section className="settings-panel">
                <p className="muted">{t("settings.appearance.description")}</p>
                <div className="field">
                  <span className="field-label" id="theme-label">
                    {t("settings.theme.label")}
                  </span>
                  <Radio.Group
                    optionType="button"
                    buttonStyle="solid"
                    aria-labelledby="theme-label"
                    value={preferences.theme}
                    onChange={(event) =>
                      update({ theme: event.target.value as ThemeChoice })
                    }
                    options={[
                      { value: "system", label: t("settings.theme.system") },
                      { value: "light", label: t("settings.theme.light") },
                      { value: "dark", label: t("settings.theme.dark") },
                    ]}
                  />
                </div>
                <div className="field">
                  <span className="field-label" id="font-scale-label">
                    {t("settings.fontScale.label")}
                  </span>
                  <div
                    className="font-scale-control"
                    role="group"
                    aria-labelledby="font-scale-label"
                  >
                    <Button
                      aria-label={t("settings.fontScale.smaller")}
                      onClick={() =>
                        update({
                          fontScale: clampFontScale(
                            preferences.fontScale - FONT_SCALE_STEP,
                          ),
                        })
                      }
                    >
                      A−
                    </Button>
                    <span
                      className="font-scale-value"
                      data-testid="font-scale-value"
                    >
                      {format("settings.fontScale.value", {
                        percent: preferences.fontScale,
                      })}
                    </span>
                    <Button
                      aria-label={t("settings.fontScale.larger")}
                      onClick={() =>
                        update({
                          fontScale: clampFontScale(
                            preferences.fontScale + FONT_SCALE_STEP,
                          ),
                        })
                      }
                    >
                      A+
                    </Button>
                  </div>
                </div>
                <div className="field field-inline">
                  <Switch
                    id="rail-collapsed"
                    checked={preferences.railCollapsed}
                    onChange={(checked) => update({ railCollapsed: checked })}
                  />
                  <label htmlFor="rail-collapsed">
                    {t("settings.rail.collapsed")}
                  </label>
                </div>
              </section>
            ),
          },
          {
            key: "language",
            label: t("settings.language.title"),
            children: (
              <section className="settings-panel">
                <p className="muted">{t("settings.language.description")}</p>
                <Radio.Group
                  value={preferences.language}
                  onChange={(event) =>
                    update({ language: event.target.value as Language })
                  }
                  options={[
                    { value: "en", label: t("language.en") },
                    { value: "zh", label: t("language.zh") },
                  ]}
                />
              </section>
            ),
          },
          {
            key: "notifications",
            label: t("settings.notifications.title"),
            children: (
              <section className="settings-panel">
                <p className="muted">
                  {t("settings.notifications.description")}
                </p>
                {placeholder}
              </section>
            ),
          },
          {
            key: "tokens",
            label: t("settings.tokens.title"),
            children: (
              <section className="settings-panel">
                <p className="muted">{t("settings.tokens.description")}</p>
                {placeholder}
              </section>
            ),
          },
          {
            key: "channels",
            label: t("settings.channels.title"),
            children: (
              <section className="settings-panel">
                <p className="muted">{t("settings.channels.description")}</p>
                {placeholder}
              </section>
            ),
          },
        ]}
      />
    </div>
  );
}
