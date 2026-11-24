import { useId, type ComponentProps, type ReactNode } from "react";
import { StageReviewGuidance } from "../../components/StageReviewGuidance.js";

export function WorkflowPanel({
  title,
  hideHeading = false,
  actions,
  children,
  className,
  id,
  ...props
}: ComponentProps<"section"> & {
  title: string;
  hideHeading?: boolean;
  actions?: ReactNode;
}) {
  const contentId = useId();
  const headingId = props["aria-labelledby"] ?? `${contentId}-title`;
  const heading = (
    <h2 id={headingId} className={hideHeading ? "sr-only" : undefined}>
      {title}
    </h2>
  );

  return (
    <section
      {...props}
      id={id}
      className={`workflow-panel ${className ?? ""}`.trim()}
      aria-labelledby={headingId}
    >
      {hideHeading && !actions ? (
        heading
      ) : (
        <div className="workflow-card-heading workflow-panel-heading">
          <div className="workflow-panel-title">{heading}</div>
          {actions}
        </div>
      )}
      {id && (
        <StageReviewGuidance
          stage={id === "plan" || id === "proposal" ? "plan-proposal" : id}
        />
      )}
      {children}
    </section>
  );
}
