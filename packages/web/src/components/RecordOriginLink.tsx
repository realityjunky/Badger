import { Link } from "react-router-dom";
import type { RecordOrigin } from "../api/version-changes.js";
import { useI18n } from "../i18n/I18nContext.js";

export function RecordOriginLink({
  origin,
  workflowId,
  kind = "ledger",
}: {
  origin?: RecordOrigin | null;
  workflowId: string;
  kind?: "question" | "source-study" | "ledger";
}) {
  const { format } = useI18n();
  if (!origin) return null;
  const workflow = `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(origin.workflowVersionId)}`;
  const href =
    kind === "question"
      ? `/questionnaire/questions/${encodeURIComponent(origin.recordId)}`
      : kind === "source-study"
        ? `${workflow}?studyRecord=${encodeURIComponent(origin.recordId)}&studyRevision=${origin.revision}#source-study`
        : `/questionnaire?${new URLSearchParams({ workflow: workflowId, version: origin.workflowVersionId, panel: "ledger" })}`;
  return (
    <p className="muted">
      <Link to={href}>
        {format("versions.inheritedRecord", { revision: origin.revision })}
      </Link>
    </p>
  );
}
