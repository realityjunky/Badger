import { DownOutlined, RightOutlined } from "@ant-design/icons";
import { Button } from "antd";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../i18n/I18nContext.js";

export function WorkflowPanel({
  title,
  actions,
  children,
  className,
  id,
  ...props
}: ComponentProps<"section"> & {
  title: string;
  actions?: ReactNode;
}) {
  const { t, format } = useI18n();
  const location = useLocation();
  const contentId = useId();
  const content = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const headingId = props["aria-labelledby"] ?? `${contentId}-title`;
  const label = format(
    collapsed ? "workflow.expandPanelLabel" : "workflow.collapsePanelLabel",
    { name: title },
  );

  useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (
      location.hash === `#${id}` ||
      (target !== null && content.current?.contains(target))
    ) {
      setCollapsed(false);
    }
  }, [location.key, location.hash, id]);

  return (
    <section
      {...props}
      id={id}
      className={`workflow-panel ${className ?? ""}`.trim()}
      aria-labelledby={headingId}
      data-collapsed={collapsed}
    >
      <div className="workflow-card-heading workflow-panel-heading">
        <div className="workflow-panel-title">
          <h2 id={headingId}>{title}</h2>
          <Button
            type="text"
            aria-label={label}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            title={label}
            icon={
              collapsed ? (
                <RightOutlined aria-hidden />
              ) : (
                <DownOutlined aria-hidden />
              )
            }
            onClick={() => setCollapsed((value) => !value)}
          >
            {t(collapsed ? "workflow.expandPanel" : "workflow.collapsePanel")}
          </Button>
        </div>
        {actions}
      </div>
      <div ref={content} id={contentId} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
