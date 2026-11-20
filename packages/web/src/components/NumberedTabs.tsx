import { Button, Tabs } from "antd";
import { useId, type ReactNode } from "react";

export function NumberedTabs({
  label,
  items,
  activeKey,
  onChange,
}: {
  label: string;
  items: { key: string; label?: ReactNode; children: ReactNode }[];
  activeKey?: string;
  onChange?(key: string): void;
}) {
  const id = useId();
  const tabs = items.map((item, index) => ({
    ...item,
    label: item.label ?? String(index + 1),
  }));

  return (
    <Tabs
      id={id}
      className="numbered-tabs"
      activeKey={activeKey}
      onChange={onChange}
      items={tabs}
      renderTabBar={({ activeKey: selectedKey, onTabClick, rtl }) => (
        <div className="numbered-tabs-list" role="tablist" aria-label={label}>
          {tabs.map((tab, index) => {
            const selected = tab.key === selectedKey;
            return (
              <Button
                key={tab.key}
                id={`${id}-tab-${tab.key}`}
                type={selected ? "primary" : "default"}
                size="small"
                role="tab"
                aria-controls={`${id}-panel-${tab.key}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={(event) => onTabClick(tab.key, event)}
                onKeyDown={(event) => {
                  let nextIndex: number;
                  switch (event.key) {
                    case "ArrowLeft":
                    case "ArrowRight": {
                      const step =
                        (event.key === "ArrowRight") !== rtl ? 1 : -1;
                      nextIndex = (index + step + tabs.length) % tabs.length;
                      break;
                    }
                    case "Home":
                      nextIndex = 0;
                      break;
                    case "End":
                      nextIndex = tabs.length - 1;
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  const next = tabs[nextIndex]!;
                  document.getElementById(`${id}-tab-${next.key}`)?.focus();
                  onTabClick(next.key, event);
                }}
              >
                {tab.label}
              </Button>
            );
          })}
        </div>
      )}
    />
  );
}
