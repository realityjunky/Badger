import { Tabs } from "antd";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../../i18n/I18nContext.js";

export type QuestionnaireTab = "questions" | "suggestions" | "ledger";

export function QuestionnaireTabs({
  activeTab,
  onChange,
  suggestions,
  ledger,
  children,
}: {
  activeTab: QuestionnaireTab;
  onChange(tab: QuestionnaireTab): void;
  suggestions?: ReactNode;
  ledger: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const scrollPositions = useRef(new Map<string, number>());
  const previousTab = useRef(activeTab);
  const [topOffset, setTopOffset] = useState<number>();

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
      top: scrollPositions.current.get(activeTab) ?? 0,
      behavior: "instant",
    });
  }, [activeTab]);

  useEffect(() => {
    const remember = () => {
      scrollPositions.current.set(activeTab, window.scrollY);
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [activeTab]);

  return (
    <Tabs
      className="questionnaire-tabs underline-tabs"
      activeKey={activeTab}
      onChange={(key) => onChange(key as QuestionnaireTab)}
      animated={false}
      destroyOnHidden={false}
      tabBarStyle={{ top: topOffset }}
      items={[
        {
          key: "questions",
          label: t("questionnaire.explorer"),
          children,
        },
        ...(suggestions
          ? [
              {
                key: "suggestions",
                label: t("drafting.title"),
                children: <div className="pane">{suggestions}</div>,
              },
            ]
          : []),
        {
          key: "ledger",
          label: t("ledger.title"),
          disabled: !ledger,
          children: <div className="pane">{ledger}</div>,
        },
      ]}
    />
  );
}
