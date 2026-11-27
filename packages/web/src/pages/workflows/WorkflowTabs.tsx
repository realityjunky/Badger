import { Tabs, type TabsProps } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n/I18nContext.js";

export function WorkflowTabs({
  items,
  linkedPanel,
}: {
  items: NonNullable<TabsProps["items"]>;
  linkedPanel: NonNullable<TabsProps["items"]>[number];
}) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedTab = selectedWorkflowTab(location);
  const mapped = items.some((item) => item.key === "mapping");
  const parentTab =
    mapped && ["source-study", "dossier"].includes(requestedTab)
      ? "mapping"
      : mapped &&
          [
            "plan",
            "proposal",
            "package",
            "review-publication",
            "plan-proposal",
            "evaluation",
          ].includes(requestedTab)
        ? "release"
        : requestedTab === "proposal"
          ? "plan"
          : requestedTab;
  const panels = [...items, linkedPanel];
  const activeTab =
    panels.find((item) => item.key === parentTab)?.key ?? items[0]?.key;
  const [topOffset, setTopOffset] = useState<number>();
  const scrollPositions = useRef(new Map<string, number>());
  const previousTab = useRef(activeTab);

  useLayoutEffect(() => {
    const topBar = document.querySelector(".top-bar");
    if (!topBar) return;
    const measure = () => setTopOffset(topBar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(topBar);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (previousTab.current === activeTab) return;
    previousTab.current = activeTab;
    window.scrollTo({
      top: scrollPositions.current.get(activeTab ?? "") ?? 0,
      behavior: "instant",
    });
  }, [activeTab]);

  useEffect(() => {
    const remember = () =>
      scrollPositions.current.set(activeTab ?? "", window.scrollY);
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [activeTab]);

  const selectTab = (key: string) =>
    navigate({
      pathname: location.pathname,
      search: location.search,
      hash: key,
    });

  return (
    <>
      <div
        className="workflow-tabs-navigation-shell"
        style={{ top: topOffset }}
      >
        <Tabs
          className="workflow-tabs workflow-tabs-navigation underline-tabs"
          activeKey={activeTab === linkedPanel.key ? "__inactive__" : activeTab}
          onChange={selectTab}
          animated={false}
          more={{
            trigger: "click",
            icon: <EllipsisOutlined aria-label={t("workflow.moreTabs")} />,
          }}
          items={items.map((item) => ({ ...item, children: null }))}
        />
      </div>
      <Tabs
        className="workflow-tabs-content"
        activeKey={activeTab}
        onChange={selectTab}
        animated={false}
        destroyOnHidden={false}
        items={panels}
      />
    </>
  );
}

export function selectedWorkflowTab({
  hash,
  search,
}: {
  hash: string;
  search: string;
}) {
  const anchor =
    hash.slice(1) || new URLSearchParams(search).get("stage") || "";
  return anchor.startsWith("study-") ? "source-study" : anchor;
}
