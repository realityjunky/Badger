import { useParams } from "react-router-dom";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import { PageHeader } from "../components/PageHeader.js";
import { ScriptEffectsPanel } from "./workflows/ScriptEffectsPanel.js";

export function SourceReviewPage() {
  const { skillId, hash } = useParams();
  const { t } = useI18n();
  return (
    <div className="page">
      <PageHeader
        title={t("page.sourceReview.title")}
        description={t("effects.help")}
      />
      <section id="source-study" className="workflow-panel">
        {skillId && hash && (
          <ScriptEffectsPanel
            basePath={readBasePath(document)}
            skillId={skillId}
            hash={hash}
          />
        )}
      </section>
    </div>
  );
}
