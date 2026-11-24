import { RightOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nContext.js";

export function SourceEvidenceDisclosure({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <details className="source-evidence-disclosure">
      <summary>
        <RightOutlined aria-hidden="true" />
        {t("study.sourceEvidence")}
      </summary>
      {children}
    </details>
  );
}
