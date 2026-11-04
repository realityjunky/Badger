import {
  BellOutlined,
  GlobalOutlined,
  MenuOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Badge,
  Button,
  Dropdown,
  Popover,
  Typography,
  type MenuProps,
} from "antd";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import { usePreferences } from "../preferences/PreferencesContext.js";
import { useInbox } from "../inbox/InboxContext.js";
import { useDemoMode } from "../app/DemoContext.js";
import { ScopeSelector } from "./ScopeSelector.js";
import { GlobalSearch } from "./GlobalSearch.js";
import { scopeSelection, type ScopeSelection } from "./scope.js";

export interface TopBarProps {
  drawerMode: boolean;
  onOpenRail(): void;
}

/** The sticky bar: scope, search, inbox, language, and account. */
export function TopBar({ drawerMode, onOpenRail }: TopBarProps) {
  const demoMode = useDemoMode();
  const { t, format } = useI18n();
  const { preferences, person, update } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const administration =
    location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  const contextual =
    !administration &&
    !location.pathname.startsWith("/settings") &&
    location.pathname !== "/activity";
  const [resolvedScope, setResolvedScope] = useState<
    (ScopeSelection & { location: string }) | null
  >(null);
  const scope =
    resolvedScope?.location === `${location.pathname}${location.search}`
      ? resolvedScope
      : scopeSelection(location.pathname, location.search);
  const inbox = useInbox();
  const [signOutFailed, setSignOutFailed] = useState(false);

  // Ends the session Badger issued, then loads the signed-out page. A fetch
  // carries the page's Origin, which a form would send as null under the
  // dashboard's no-referrer policy.
  async function signOut() {
    const base = readBasePath(document);
    const prefix = base === "/" ? "" : base;
    setSignOutFailed(false);
    try {
      const response = await fetch(`${prefix}/auth/logout`, {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response.type !== "opaqueredirect" && !response.ok)
        throw new Error(`Sign-out answered ${response.status}`);
      window.location.assign(`${prefix}/`);
    } catch {
      setSignOutFailed(true);
    }
  }

  const languageItems: MenuProps["items"] = [
    {
      key: "en",
      label: t("language.en"),
      onClick: () => update({ language: "en" }),
    },
    {
      key: "zh",
      label: t("language.zh"),
      onClick: () => update({ language: "zh" }),
    },
  ];

  const userItems: MenuProps["items"] = [
    {
      key: "person",
      disabled: true,
      label:
        person === null
          ? t("topBar.userMenu")
          : format("user.signedInAs", { name: person.displayName }),
    },
    { type: "divider" },
    {
      key: "settings",
      label: t("nav.settings"),
      onClick: () => navigate("/settings"),
    },
    ...(!demoMode
      ? [
          {
            key: "demo",
            label: (
              <a
                href={`${readBasePath(document) === "/" ? "" : readBasePath(document)}/demo/`}
              >
                {t("demo.open")}
              </a>
            ),
          },
        ]
      : []),
    ...(person?.signOut
      ? [
          {
            key: "sign-out",
            label: t("user.signOut"),
            onClick: () => void signOut(),
          },
        ]
      : []),
  ];

  return (
    <header className="top-bar" data-testid="top-bar">
      {drawerMode && (
        <Button
          type="text"
          icon={<MenuOutlined />}
          aria-label={t("rail.open")}
          onClick={onOpenRail}
          data-testid="rail-open"
        />
      )}

      {administration ? (
        <Typography.Text>{t("admin.context")}</Typography.Text>
      ) : (
        <>
          {contextual && <ScopeSelector onResolve={setResolvedScope} />}
          <GlobalSearch scope={contextual ? scope : {}} />
        </>
      )}

      <div className="top-bar-actions">
        <Popover
          title={t("inbox.title")}
          trigger="click"
          placement="bottomRight"
          content={
            inbox.failed ? (
              <p role="alert">{t("inbox.failed")}</p>
            ) : inbox.hasFilters ||
              inbox.page.items.length > 0 ||
              inbox.page.unreadCount > 0 ||
              inbox.hasOlderPage ? (
              <Link to="/my-work#inbox" onClick={inbox.newest}>
                {t("inbox.view")}
              </Link>
            ) : (
              <p className="muted inbox-empty" data-testid="inbox-empty">
                {t("inbox.empty")}
              </p>
            )
          }
        >
          <Button
            type="text"
            aria-label={
              inbox.page.unreadCount > 0
                ? format("inbox.unreadCount", { count: inbox.page.unreadCount })
                : t("inbox.open")
            }
            data-testid="inbox-button"
            icon={
              <Badge
                dot={false}
                count={inbox.page.unreadCount}
                showZero={false}
              >
                <BellOutlined />
              </Badge>
            }
          />
        </Popover>
        <span className="sr-only" role="status" aria-atomic="true">
          {format("inbox.unreadCount", { count: inbox.page.unreadCount })}
        </span>

        <Dropdown menu={{ items: languageItems }} trigger={["click"]}>
          <Button
            type="text"
            icon={<GlobalOutlined />}
            aria-label={t("topBar.language")}
            data-testid="language-switch"
          >
            {t(preferences.language === "zh" ? "language.zh" : "language.en")}
          </Button>
        </Dropdown>

        {signOutFailed && (
          <Typography.Text type="danger" role="alert">
            {t("user.signOutFailed")}
          </Typography.Text>
        )}
        <Dropdown menu={{ items: userItems }} trigger={["click"]}>
          <Button
            type="text"
            icon={<UserOutlined />}
            aria-label={t("topBar.userMenu")}
            data-testid="user-menu"
          >
            <span className="user-name">
              {person?.displayName ?? t("topBar.userMenu")}
            </span>
          </Button>
        </Dropdown>
      </div>
    </header>
  );
}
