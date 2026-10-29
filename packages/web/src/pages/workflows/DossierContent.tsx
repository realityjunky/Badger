import { Collapse, Tag } from "antd";
import { Link } from "react-router-dom";
import type { DossierSnapshot } from "../../api/dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";

/** Show the immutable document and the record revisions the owner is approving. */
export function DossierContent({
  snapshot,
  hash,
  canonicalJson,
  workflowId,
}: {
  snapshot: DossierSnapshot;
  hash: string;
  canonicalJson: string;
  workflowId: string;
}) {
  const { t, format } = useI18n();
  const dossier = snapshot.dossier;
  const facts = [
    ...dossier.confirmedUserFacts,
    ...dossier.sourceDerivedFacts,
    ...dossier.agentInferences,
  ];
  const base = `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(snapshot.workflowVersionId)}`;
  return (
    <div className="dossier-content">
      <p>{dossier.workflow.goal}</p>
      <p className="field-label">{t("dossier.hash")}</p>
      <code className="dossier-hash">{hash}</code>
      <h3>{t("dossier.facts")}</h3>
      <ul className="dossier-facts">
        {facts.map((fact) => {
          const item = snapshot.ledger.items.find(
            (r) => r.record.id === fact.id,
          );
          const question = item?.relatedRecords.find(
            (r) => r.type === "question",
          );
          return (
            <li key={fact.id}>
              <p>{fact.statement}</p>
              {question ? (
                <Link
                  to={`/questionnaire/questions/${encodeURIComponent(question.id)}`}
                >
                  {format("dossier.recordRevision", {
                    revision: item!.record.revision,
                  })}
                </Link>
              ) : (
                <Link
                  to={`${base}?studyRecord=${encodeURIComponent(fact.id)}&studyRevision=${item?.record.revision ?? 1}#source-study`}
                >
                  {format("dossier.recordRevision", {
                    revision: item?.record.revision ?? 1,
                  })}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <h3>{t("dossier.nodes")}</h3>
      <ol className="dossier-facts">
        {dossier.nodes.map((node) => (
          <li key={node.id}>
            <strong>{node.id}</strong>
            <p>{node.responsibility.summary}</p>
            {node.responsibility.factIds.map((id) => (
              <Tag key={id}>{id}</Tag>
            ))}
          </li>
        ))}
      </ol>
      <Collapse
        items={snapshot.ledger.readiness.flatMap(({ topic }) => {
          if (topic === "scope") return [];
          return [
            {
              key: topic,
              label: t(`questionnaire.topic.${topic}`),
              children: (
                <>
                  <p>{dossier.topics[topic].summary}</p>
                  {dossier.topics[topic].factIds.map((id) => (
                    <Tag key={id}>{id}</Tag>
                  ))}
                </>
              ),
            },
          ];
        })}
      />
      {dossier.deferredQuestions.length > 0 && (
        <>
          <h3>{t("ledger.deferred")}</h3>
          <ul>
            {dossier.deferredQuestions.map((q) => (
              <li key={q.id}>
                {q.question}
                <p>{q.resolution.reason}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>{t("dossier.canonical")}</summary>
        <pre className="dossier-json">{canonicalJson}</pre>
      </details>
    </div>
  );
}
