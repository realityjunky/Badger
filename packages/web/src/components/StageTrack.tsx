import { useI18n } from "../i18n/I18nContext.js";
import type { MessageId } from "../i18n/catalog.js";
import { StatusPill } from "./StatusPill.js";

type StageState = "done" | "active" | "todo";

const PILL_TONE: Readonly<Record<StageState, "info" | "success" | "neutral">> =
  {
    done: "success",
    active: "info",
    todo: "neutral",
  };

const PILL_MESSAGE: Readonly<Record<StageState, MessageId>> = {
  done: "status.done",
  active: "status.inProgress",
  todo: "status.notStarted",
};

const STAGES: readonly MessageId[] = [
  "stage.sources",
  "stage.sourceStudy",
  "stage.questionnaire",
  "stage.dossier",
  "stage.planProposal",
  "stage.package",
  "stage.evaluation",
  "stage.reviewPublication",
];

/** The numbered stage track, with an animated marker on the active stage. */
export function StageTrack({ active = 0 }: { active?: number }) {
  const { t } = useI18n();
  return (
    <ol
      className="stage-track"
      aria-label={t("stage.trackLabel")}
      data-testid="stage-track"
    >
      {STAGES.map((stage, index) => {
        const state: StageState =
          index < active ? "done" : index === active ? "active" : "todo";
        return (
          <li className="stage" key={stage} data-state={state}>
            <span className="stage-number" aria-hidden="true">
              {index + 1}
            </span>
            <span className="stage-name">{t(stage)}</span>
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
