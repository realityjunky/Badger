import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nContext.js";

export function OpenPackageFindings({
  items,
  workflowPath,
}: {
  items?: { id: string; problem: string }[];
  workflowPath: string;
}) {
  const { t } = useI18n();
  if (!items?.length) return null;
  return (
    <details>
      <summary>
        {t("finding.title")} ({items.length})
      </summary>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={{
                pathname: workflowPath,
                search:
                  "?packageTab=findings&finding=" + encodeURIComponent(item.id),
                hash: "#package",
              }}
            >
              {item.problem}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
