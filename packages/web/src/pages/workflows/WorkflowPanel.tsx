import { useId, type ComponentProps, type ReactNode } from "react";

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
  const contentId = useId();
  const headingId = props["aria-labelledby"] ?? `${contentId}-title`;

  return (
    <section
      {...props}
      id={id}
      className={`workflow-panel ${className ?? ""}`.trim()}
      aria-labelledby={headingId}
    >
      <div className="workflow-card-heading workflow-panel-heading">
        <div className="workflow-panel-title">
          <h2 id={headingId}>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
