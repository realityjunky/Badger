import { ConfigProvider, theme as antdTokens } from "antd";
import { useEffect, useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "../i18n/I18nContext.js";
import {
  PreferencesProvider,
  usePreferences,
} from "../preferences/PreferencesContext.js";
import { AppShell } from "../shell/AppShell.js";
import { ActivityPage } from "../pages/ActivityPage.js";
import { AdminPage } from "../pages/AdminPage.js";
import { MyWorkPage } from "../pages/MyWorkPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { RunsPage } from "../pages/RunsPage.js";
import { QuestionnairePage } from "../pages/QuestionnairePage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { SkillsPage } from "../pages/SkillsPage.js";
import { EvaluationsPage } from "../pages/EvaluationsPage.js";
import { WorkflowsPage } from "../pages/WorkflowsPage.js";
import { applyTheme } from "../theme/applyTheme.js";
import { antdTheme, fontScaleFactor, resolveTheme } from "../theme/tokens.js";
import { useSystemTheme } from "../theme/useSystemTheme.js";
import { normalizeBasePath } from "./paths.js";
import { InboxProvider } from "../inbox/InboxContext.js";
import { LiveUpdatesProvider } from "../live/LiveUpdatesContext.js";

export function App({ basePath }: { basePath: string }) {
  return (
    <PreferencesProvider basePath={basePath}>
      <ThemedApp basePath={basePath} />
    </PreferencesProvider>
  );
}

function ThemedApp({ basePath }: { basePath: string }) {
  const { preferences } = usePreferences();
  const system = useSystemTheme();
  const resolved = resolveTheme(preferences.theme, system);
  const scale = fontScaleFactor(preferences.fontScale);

  useEffect(() => {
    applyTheme(resolved, scale);
  }, [resolved, scale]);

  useEffect(() => {
    document.documentElement.lang =
      preferences.language === "zh" ? "zh-CN" : "en";
  }, [preferences.language]);

  const theme = useMemo(
    () => ({
      ...antdTheme(resolved, scale),
      // The tokens set the palette; the algorithm derives the states Ant
      // Design computes on its own (hover, pressed, disabled).
      algorithm:
        resolved === "dark"
          ? antdTokens.darkAlgorithm
          : antdTokens.defaultAlgorithm,
    }),
    [resolved, scale],
  );

  return (
    <ConfigProvider theme={theme}>
      <I18nProvider locale={preferences.language}>
        <BrowserRouter basename={normalizeBasePath(basePath)}>
          <LiveUpdatesProvider basePath={basePath}>
            <InboxProvider basePath={basePath}>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<Navigate to="/my-work" replace />} />
                  <Route path="my-work" element={<MyWorkPage />} />
                  <Route path="workflows" element={<WorkflowsPage />} />
                  <Route
                    path="workflows/:workflowId"
                    element={<WorkflowsPage />}
                  />
                  <Route
                    path="workflows/:workflowId/versions/:versionId"
                    element={<WorkflowsPage />}
                  />
                  <Route path="questionnaire" element={<QuestionnairePage />} />
                  <Route
                    path="questionnaire/questions/:questionId"
                    element={<QuestionnairePage />}
                  />
                  <Route
                    path="questionnaire/concerns/:concernId"
                    element={<QuestionnairePage />}
                  />
                  <Route path="skills" element={<SkillsPage />} />
                  <Route path="skills/:skillId" element={<SkillsPage />} />
                  <Route
                    path="skills/:skillId/versions/:versionId"
                    element={<SkillsPage />}
                  />
                  <Route path="runs" element={<RunsPage />} />
                  <Route path="runs/:runId" element={<RunsPage />} />
                  <Route path="evaluations/*" element={<EvaluationsPage />} />
                  <Route path="activity" element={<ActivityPage />} />
                  <Route path="admin/*" element={<AdminPage />} />
                  <Route path="settings/*" element={<SettingsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </InboxProvider>
          </LiveUpdatesProvider>
        </BrowserRouter>
      </I18nProvider>
    </ConfigProvider>
  );
}
