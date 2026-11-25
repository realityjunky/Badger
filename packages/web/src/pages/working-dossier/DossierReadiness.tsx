import { Alert, Collapse, Space, Tag } from "antd";
import type { WorkingDossierView } from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";

export function DossierReadiness({ dossier }: { dossier: WorkingDossierView }) {
  const { t, format } = useI18n();
  const blockedCount = dossier.readiness.filter(
    ({ blockers }) => blockers.length > 0,
  ).length;
  return (
    <Collapse
      className="working-dossier-readiness"
      items={[
        {
          key: "readiness",
          label: (
            <Space wrap>
              <strong>{t("ledger.readiness")}</strong>
              <Tag color={blockedCount ? "warning" : "success"}>
                {blockedCount
                  ? format("workingDossier.topicsBlocked", {
                      count: blockedCount,
                    })
                  : t("ledger.ready")}
              </Tag>
            </Space>
          ),
          children: (
            <ul className="dossier-topic-readiness" role="list">
              {dossier.readiness.map(({ topic, blockers }) => (
                <li key={topic}>
                  <div className="ledger-topic-heading">
                    <strong>{t(`questionnaire.topic.${topic}`)}</strong>
                    <Tag color={blockers.length ? "warning" : "success"}>
                      {blockers.length
                        ? format("workingDossier.itemsOpen", {
                            count: blockers.length,
                          })
                        : t("ledger.ready")}
                    </Tag>
                  </div>
                  {blockers.length > 0 && (
                    <ul className="working-dossier-readiness-blockers">
                      {blockers.map(({ id, message }, index) => (
                        <li key={`${id}/${index}`}>{message}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ),
        },
      ]}
    />
  );
}

export function RemovedDossierFields({
  dossier,
}: {
  dossier: WorkingDossierView;
}) {
  const { t } = useI18n();
  if (!dossier.projection.removedFields.length) return null;
  return (
    <Alert
      type="warning"
      showIcon
      title={t("workingDossier.removedFields")}
      description={
        <ul>
          {dossier.projection.removedFields.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      }
    />
  );
}
