import { PageHeader } from "../components/PageHeader.js";
import { StageTrack } from "../components/StageTrack.js";
import { useI18n } from "../i18n/I18nContext.js";

export function WorkflowsPage() {
  const { t } = useI18n();
  return (
    <div className="page" data-testid="page-workflows">
      <PageHeader
        title={t("page.workflows.title")}
        description={t("page.workflows.description")}
      />
      <StageTrack active={0} />
      <p className="empty-state">{t("page.placeholder")}</p>
    </div>
  );
}
