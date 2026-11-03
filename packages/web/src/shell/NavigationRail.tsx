import {
  ApartmentOutlined,
  AppstoreOutlined,
  BookOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { navigationSections, type NavigationItem } from "../app/navigation.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useDemoMode } from "../app/DemoContext.js";
import {
  currentDocumentationSection,
  documentationSearch,
} from "../documentation/sections.js";

const ICONS: Record<NavigationItem["icon"], ReactNode> = {
  work: <InboxOutlined />,
  workflows: <ApartmentOutlined />,
  questionnaire: <QuestionCircleOutlined />,
  skills: <AppstoreOutlined />,
  runs: <PlayCircleOutlined />,
  evaluations: <ExperimentOutlined />,
  activity: <HistoryOutlined />,
  admin: <TeamOutlined />,
  settings: <SettingOutlined />,
};

export interface NavigationRailProps {
  collapsed: boolean;
  drawer: boolean;
  drawerOpen: boolean;
  onToggleCollapsed(): void;
  onNavigate(): void;
}

/** The 228px rail, 64px collapsed, and a drawer below 1024px. */
export function NavigationRail({
  collapsed,
  drawer,
  drawerOpen,
  onToggleCollapsed,
  onNavigate,
}: NavigationRailProps) {
  const { t } = useI18n();
  const demoMode = useDemoMode();
  const location = useLocation();
  const navigate = useNavigate();
  const effectiveCollapsed = collapsed && !drawer;

  return (
    <aside
      className="rail"
      data-testid="navigation-rail"
      data-collapsed={effectiveCollapsed}
      data-drawer={drawer}
      data-drawer-open={drawerOpen}
      inert={drawer && !drawerOpen ? true : undefined}
    >
      <div className="rail-brand">
        <span className="rail-mark" aria-hidden="true">
          <FolderOpenOutlined />
        </span>
        <span className="rail-label rail-name">{t("app.name")}</span>
      </div>

      <nav className="rail-nav" aria-label={t("a11y.primaryNavigation")}>
        {navigationSections
          .filter(
            (section) =>
              !demoMode || section.title !== "nav.section.administration",
          )
          .map((section) => (
            <div className="rail-section" key={section.title}>
              <p className="rail-section-title">{t(section.title)}</p>
              <ul>
                {section.items.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) =>
                        isActive ? "rail-link rail-link-active" : "rail-link"
                      }
                      aria-label={t(item.title)}
                      onClick={onNavigate}
                    >
                      <span className="rail-icon" aria-hidden="true">
                        {ICONS[item.icon]}
                      </span>
                      <span className="rail-label">{t(item.title)}</span>
                    </NavLink>
                  </li>
                ))}
                {section.title === "nav.section.system" && (
                  <li>
                    <Tooltip
                      title={t("documentation.tooltip")}
                      trigger={["hover", "focus"]}
                      placement="right"
                    >
                      <button
                        type="button"
                        className="rail-link"
                        aria-label={t("documentation.title")}
                        aria-haspopup="dialog"
                        onClick={() =>
                          void navigate(
                            {
                              ...location,
                              search: documentationSearch(
                                location.search,
                                currentDocumentationSection(location.pathname),
                              ),
                            },
                            { replace: true },
                          )
                        }
                      >
                        <span className="rail-icon" aria-hidden="true">
                          <BookOutlined />
                        </span>
                        <span className="rail-label">
                          {t("documentation.title")}
                        </span>
                      </button>
                    </Tooltip>
                  </li>
                )}
              </ul>
            </div>
          ))}
      </nav>

      {!drawer && (
        <div className="rail-footer">
          <Button
            type="text"
            block
            icon={
              effectiveCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
            }
            aria-label={
              effectiveCollapsed ? t("rail.expand") : t("rail.collapse")
            }
            aria-expanded={!effectiveCollapsed}
            onClick={onToggleCollapsed}
            data-testid="rail-collapse"
            className="rail-collapse"
          >
            {!effectiveCollapsed && (
              <span className="rail-label">{t("rail.collapse")}</span>
            )}
          </Button>
        </div>
      )}
    </aside>
  );
}
