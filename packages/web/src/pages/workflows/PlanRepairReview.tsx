import type { FactoryPlan, PlanRepairResolution } from "@realityjunky/badger";
import type { PlanDraftingJob } from "../../api/drafting-jobs.js";
import { useI18n } from "../../i18n/I18nContext.js";

function changes(
  before: unknown,
  after: unknown,
  path = "",
): { path: string; before: unknown; after: unknown }[] {
  if (before === after) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>,
      right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(
      (key) =>
        changes(
          left[key],
          right[key],
          path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
        ),
    );
  }
  return [{ path, before, after }];
}
export function PlanRepairReview({
  repair,
  resolutions,
  before,
  after,
}: {
  repair: NonNullable<PlanDraftingJob["planRepair"]>;
  resolutions: Record<string, PlanRepairResolution>;
  before: FactoryPlan;
  after: FactoryPlan;
}) {
  const { t } = useI18n();
  const diff = changes(before, after);
  const display = (value: unknown) =>
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? t("plan.absent"));
  return (
    <>
      <h4>{t("plan.findingResults")}</h4>
      <ul>
        {repair.items.map((item) => (
          <li key={item.id}>
            <strong>{item.source}</strong> · {item.description}
            <p>
              {t(`plan.resolution.${resolutions[item.id]!.status}`)} ·{" "}
              {resolutions[item.id]!.explanation}
            </p>
          </li>
        ))}
      </ul>
      <h4>{t("plan.proposedChanges")}</h4>
      {diff.length ? (
        diff.map((change) => (
          <details key={change.path} className="plan-conflict">
            <summary>
              <code>{change.path}</code>
            </summary>
            <strong>{t("plan.before")}</strong>
            <pre>{display(change.before)}</pre>
            <strong>{t("plan.after")}</strong>
            <pre>{display(change.after)}</pre>
          </details>
        ))
      ) : (
        <p>{t("plan.noChanges")}</p>
      )}
    </>
  );
}
