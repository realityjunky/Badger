import type { ReactNode } from "react";

export type PillTone = "neutral" | "info" | "success" | "warning" | "danger";

/** A small status pill in one of the five tones. */
export function StatusPill({
  tone,
  children,
}: {
  tone: PillTone;
  children: ReactNode;
}) {
  return <span className={`status-pill status-pill-${tone}`}>{children}</span>;
}
