import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import type { MessageId } from "../i18n/catalog.js";

/** A page whose records arrive with a later step of the service. */
export function PlaceholderPage({
  title,
  description,
}: {
  title: MessageId;
  description: MessageId;
}) {
  const { t } = useI18n();
  return (
    <div className="page" data-testid="page-placeholder">
      <PageHeader title={t(title)} description={t(description)} />
      <p className="empty-state">{t("page.placeholder")}</p>
    </div>
  );
}
