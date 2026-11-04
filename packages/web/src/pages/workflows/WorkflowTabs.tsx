import { Tabs, type TabsProps } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n/I18nContext.js";

export function WorkflowTabs({
  items,
}: {
  items: NonNullable<TabsProps["items"]>;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const anchor = location.hash.slice(1);
  const requestedTab = anchor.startsWith("study-") ? "source-study" : anchor;
  const activeTab =
    items.find((item) => item.key === requestedTab)?.key ?? items[0]?.key;
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

  return (
    <Tabs
      className="workflow-tabs underline-tabs"
      activeKey={activeTab}
      onChange={(key) =>
        navigate({
          pathname: location.pathname,
          search: location.search,
          hash: key,
        })
      }
      animated={false}
      destroyOnHidden={false}
      more={{
        trigger: "click",
        icon: <EllipsisOutlined aria-label={t("workflow.moreTabs")} />,
      }}
      tabBarStyle={{ top: topOffset }}
      items={items}
    />
  );
}
