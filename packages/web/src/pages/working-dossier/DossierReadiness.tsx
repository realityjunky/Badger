import { Alert, Collapse, Space, Tag } from "antd";
import type { WorkingDossierView } from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";

export function DossierReadiness({ dossier }: { dossier: WorkingDossierView }) {
  const { t, format } = useI18n();
  const blocked = dossier.readiness.filter(({ blockers }) => blockers.length);
  return (
    <Collapse
      className="working-dossier-readiness"
      items={[
        {
          key: "readiness",
          label: (
            <Space wrap>
              <strong>{t("ledger.readiness")}</strong>
              <Tag color={blocked.length ? "warning" : "success"}>
                {blocked.length
                  ? format("workingDossier.topicsBlocked", {
                      count: blocked.length,
                    })
                  : t("ledger.ready")}
              </Tag>
            </Space>
          ),
          children: blocked.map(({ topic, blockers }) => (
            <section key={topic}>
              <h4>{t(`questionnaire.topic.${topic}`)}</h4>
              <ul>
                {blockers.map(({ id, message }, index) => (
                  <li key={`${id}/${index}`}>{message}</li>
                ))}
              </ul>
            </section>
          )),
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
