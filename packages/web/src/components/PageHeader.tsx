import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions !== undefined && <div className="page-actions">{actions}</div>}
    </header>
  );
}
