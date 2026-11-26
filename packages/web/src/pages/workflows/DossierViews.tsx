import { Collapse, Tabs, type TabsProps } from "antd";
import { type ReactNode } from "react";
import type { WorkingDossierRevision } from "@realityjunky/badger";
import type { WorkingDossierField } from "../../api/working-dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { WorkingDossierStudy } from "../working-dossier/WorkingDossierStudy.js";
import { DossierFieldList } from "../working-dossier/DossierFields.js";
import type { EvidenceContext } from "../working-dossier/DossierEvidence.js";

export function SnapshotTopics({
  fields,
  context,
}: {
  fields: WorkingDossierField[];
  context: EvidenceContext;
}) {
  const { t } = useI18n();
  const topics = [...new Set(fields.map((field) => field.topic))];
  return (
    <Collapse
      items={topics.map((topic) => ({
        key: topic,
        label: t(`questionnaire.topic.${topic}`),
        children: (
          <DossierFieldList
            showOwner
            fields={fields.filter((field) => field.topic === topic)}
            context={context}
          />
        ),
      }))}
    />
  );
}

export function DossierViews({
  basis,
  fields,
  context,
  topics,
  isDraft,
  revisionDetails,
  json,
  tab,
  onTab,
  legacyDetails,
}: {
  basis?: WorkingDossierRevision;
  fields: WorkingDossierField[];
  context: EvidenceContext;
  topics?: ReactNode;
  isDraft: boolean;
  revisionDetails: ReactNode;
  json?: ReactNode;
  tab: string | null;
  onTab(tab: string): void;
  legacyDetails?: ReactNode;
}) {
  const { t } = useI18n();
  const items: NonNullable<TabsProps["items"]> = [];
  if (topics)
    items.push({
      key: "topics",
      label: t(isDraft ? "ledger.readiness" : "dossier.topics"),
      children: topics,
    });
  items.push({
    key: "details",
    label: t("workingDossier.workflowDetails"),
    children: legacyDetails ?? (
      <DossierFieldList
        fields={fields.filter((field) => field.scope === "workflow")}
        context={context}
      />
    ),
  });
  if (basis)
    items.push({
      key: "diagram",
      label: t("workingDossier.diagram"),
      children: (
        <WorkingDossierStudy
          standalone={false}
          showPinnedHashes={!isDraft}
          dossier={{
            ...basis,
            projection: { fields, removedFields: [], staleFindings: [] },
          }}
          context={context}
        />
      ),
    });
  items.push({
    key: "revision",
    label: t("dossier.revisionDetails"),
    children: revisionDetails,
  });
  if (json)
    items.push({
      key: "json",
      label: t(isDraft ? "dossier.workingJson" : "dossier.canonical"),
      children: json,
    });
  return (
    <Tabs
      className="dossier-views"
      more={{ trigger: "click" }}
      activeKey={items.find((item) => item.key === tab)?.key ?? items[0]!.key}
      onChange={onTab}
      items={items}
    />
  );
}
