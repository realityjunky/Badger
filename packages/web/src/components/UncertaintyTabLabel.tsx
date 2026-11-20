import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nContext.js";

export function UncertaintyTabLabel({
  children,
  pending,
}: {
  children: ReactNode;
  pending: boolean;
}) {
  const { t } = useI18n();
  if (!pending) return children;
  return (
    <span className="uncertainty-tab-label">
      {children}
      <sup
        className="uncertainty-tab-marker"
        aria-hidden="true"
        title={t("effects.unanswered")}
      >
        !
      </sup>
      <span className="sr-only">{t("effects.unanswered")}</span>
    </span>
  );
}
