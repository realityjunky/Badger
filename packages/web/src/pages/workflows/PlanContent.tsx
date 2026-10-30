import type { PlanVersion } from "../../api/plans.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function PlanContent({
  version,
}: {
  version: Pick<PlanVersion, "hash" | "snapshot" | "canonicalJson">;
}) {
  const { t } = useI18n();
  const plan = version.snapshot.plan;
  return (
    <div className="dossier-content">
      <p>
        <strong>{plan.workflow.name}</strong> · {plan.goal}
      </p>
      <dl>
        <dt>{t("plan.hash")}</dt>
        <dd>
          <code className="dossier-hash">{version.hash}</code>
        </dd>
        <dt>{t("dossier.hash")}</dt>
        <dd>
          <code className="dossier-hash">{version.snapshot.dossierHash}</code>
        </dd>
      </dl>
      <h3>{t("dossier.nodes")}</h3>
      <ol className="dossier-facts">
        {plan.workflow.customNodes.map((node) => (
          <li key={node.id}>
            <strong>
              {node.id}: {node.label}
            </strong>
            <p>{node.responsibility}</p>
            <p>{node.implementation.skill}</p>
          </li>
        ))}
      </ol>
      {version.canonicalJson !== null && (
        <details>
          <summary>{t("plan.canonical")}</summary>
          <pre className="dossier-json">{version.canonicalJson}</pre>
        </details>
      )}
    </div>
  );
}
