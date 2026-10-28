import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="page" data-testid="page-not-found">
      <PageHeader
        title={t("page.notFound.title")}
        description={t("notFound.description")}
      />
      <Link to="/my-work" className="primary-link">
        {t("common.notFoundLink")}
      </Link>
    </div>
  );
}
