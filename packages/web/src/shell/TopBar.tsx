import {
  BellOutlined,
  GlobalOutlined,
  MenuOutlined,
  SearchOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Badge,
  Button,
  Dropdown,
  Input,
  Popover,
  Select,
  type MenuProps,
} from "antd";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/I18nContext.js";
import { usePreferences } from "../preferences/PreferencesContext.js";
import { useInbox } from "../inbox/InboxContext.js";

export interface TopBarProps {
  drawerMode: boolean;
  onOpenRail(): void;
}

/** The sticky 68px bar: scope, search, inbox, language, and the user menu. */
export function TopBar({ drawerMode, onOpenRail }: TopBarProps) {
  const { t, format } = useI18n();
  const { preferences, person, update } = usePreferences();
  const navigate = useNavigate();
  const inbox = useInbox();

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

      <div
        className="scope-selector"
        data-testid="scope-selector"
        role="group"
        aria-label={t("topBar.scopeLabel")}
      >
        <Select
          className="scope-select"
          aria-label={t("scope.group")}
          placeholder={t("scope.selectGroup")}
          options={[]}
          popupMatchSelectWidth={false}
        />
        <span className="scope-arrow" aria-hidden="true">
          /
        </span>
        <Select
          className="scope-select scope-select-workflow"
          aria-label={t("scope.workflow")}
          placeholder={t("scope.selectWorkflow")}
          options={[]}
          popupMatchSelectWidth={false}
        />
        <span className="scope-arrow" aria-hidden="true">
          /
        </span>
        <Select
          className="scope-select scope-select-version"
          aria-label={t("scope.version")}
          placeholder={t("scope.selectVersion")}
          options={[]}
          popupMatchSelectWidth={false}
        />
      </div>

      <div className="top-bar-search">
        <Input
          allowClear
          prefix={<SearchOutlined aria-hidden="true" />}
          aria-label={t("topBar.search")}
          placeholder={t("topBar.searchPlaceholder")}
          data-testid="search-input"
        />
      </div>

      <div className="top-bar-actions">
        <Popover
          title={t("inbox.title")}
          trigger="click"
          placement="bottomRight"
          content={
            inbox.failed ? (
              <p role="alert">{t("inbox.failed")}</p>
            ) : inbox.page.items.length > 0 ||
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
