import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { pageTitleKey } from "../app/navigation.js";
import { useI18n } from "../i18n/I18nContext.js";
import { usePreferences } from "../preferences/PreferencesContext.js";
import { layout } from "../theme/tokens.js";
import { useMediaQuery } from "../theme/useMediaQuery.js";
import { NavigationRail } from "./NavigationRail.js";
import { TopBar } from "./TopBar.js";

/**
 * The application frame: the rail, the top bar, and the page. Below 1024px
 * the rail becomes a drawer; the content keeps its own URL throughout.
 */
export function AppShell() {
  const { t } = useI18n();
  const { preferences, update } = usePreferences();
  const location = useLocation();
  const drawerMode = useMediaQuery(
    `(max-width: ${layout.railDrawerBreakpoint - 1}px)`,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const collapsed = preferences.railCollapsed && !drawerMode;

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.title = `${t(pageTitleKey(location.pathname))} · ${t("app.name")}`;
  }, [location.pathname, t]);

  return (
    <div
      className="app-shell"
      data-testid="app-shell"
      data-rail-collapsed={collapsed}
      data-drawer-open={drawerOpen}
    >
      <a className="skip-link" href="#main-content">
        {t("a11y.skipToContent")}
      </a>

      <NavigationRail
        collapsed={collapsed}
        drawer={drawerMode}
        drawerOpen={drawerOpen}
        onToggleCollapsed={() => update({ railCollapsed: !collapsed })}
        onNavigate={() => setDrawerOpen(false)}
      />
      {drawerMode && drawerOpen && (
        <button
          type="button"
          className="rail-scrim"
          aria-label={t("common.close")}
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div className="app-body">
        <TopBar
          drawerMode={drawerMode}
          onOpenRail={() => setDrawerOpen(true)}
        />
        <main id="main-content" className="app-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
