import { useI18n } from "../i18n/I18nContext.js";
import type { MessageId } from "../i18n/catalog.js";
import { StatusPill } from "./StatusPill.js";
import type { StageId, StageState, WorkflowStage } from "../api/workflows.js";

const PILL_TONE: Readonly<
  Record<StageState, "info" | "success" | "neutral" | "warning" | "danger">
> = {
  done: "success",
  active: "info",
  todo: "neutral",
  blocked: "danger",
  invalidated: "warning",
};

const PILL_MESSAGE: Readonly<Record<StageState, MessageId>> = {
  done: "status.done",
  active: "status.inProgress",
  todo: "status.notStarted",
  blocked: "status.blocked",
  invalidated: "status.invalidated",
};

export const STAGE_LABELS: Readonly<Record<StageId, MessageId>> = {
  sources: "stage.sources",
  "source-study": "stage.sourceStudy",
  questionnaire: "stage.questionnaire",
  dossier: "stage.dossier",
  "plan-proposal": "stage.planProposal",
  package: "stage.package",
  evaluation: "stage.evaluation",
  "review-publication": "stage.reviewPublication",
};

/** The numbered stage track, with an animated marker on the active stage. */
export function StageTrack({ stages }: { stages: readonly WorkflowStage[] }) {
  const { t } = useI18n();
  return (
    <ol
      className="stage-track"
      aria-label={t("stage.trackLabel")}
      data-testid="stage-track"
    >
      {stages.map(({ id, state }, index) => {
        return (
          <li
            className="stage"
            key={id}
            data-state={state}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="stage-number" aria-hidden="true">
              {index + 1}
            </span>
            <span className="stage-name">{t(STAGE_LABELS[id])}</span>
            <StatusPill tone={PILL_TONE[state]}>
              {t(PILL_MESSAGE[state])}
            </StatusPill>
            {state === "active" && (
              <span className="stage-marker" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
