import { Tag } from "antd";
import { approvalHistory, type GateConfirmation } from "../api/workflows.js";
import { useI18n } from "../i18n/I18nContext.js";

/** Every approval of a gate, or of one artifact, with superseded ones marked. */
export function ConfirmationHistory({
  confirmations,
  bound,
}: {
  confirmations?: readonly GateConfirmation[];
  bound?: { name: string; hash: string };
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {approvalHistory(confirmations, bound).map((entry) => (
        <p key={entry.id}>
          <Tag>
            {t(
              entry.superseded
                ? "versions.approvalSuperseded"
                : "versions.approvalRecorded",
            )}
          </Tag>{" "}
          {entry.actorId} · {new Date(entry.confirmedAt).toLocaleString(locale)}
          {entry.invalidationReason && ` · ${entry.invalidationReason}`}
        </p>
      ))}
    </>
  );
}
