import { Tabs } from "antd";
import type { ReactNode } from "react";
import { SnapshotJson } from "../../components/SnapshotJson.js";
import type { PlanVersion } from "../../api/plans.js";
import { useI18n } from "../../i18n/I18nContext.js";

type PlanDocument = Pick<PlanVersion, "hash" | "snapshot" | "canonicalJson">;

function PlanHashes({ version }: { version: PlanDocument }) {
  const { t } = useI18n();
  return (
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
  );
}

function PlanNodes({ plan }: { plan: PlanDocument["snapshot"]["plan"] }) {
  return (
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
  );
}

export function PlanTabs({
  version,
  tab,
  onTab,
  children,
}: {
  version?: PlanVersion;
  tab: string | null;
  onTab(key: string): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const missing = <p className="empty-state">{t("plan.empty")}</p>;
  const plan = version?.snapshot.plan;
  const items = [
    { key: "jobs", label: t("plan.suggestions"), children },
    {
      key: "json",
      label: t("plan.canonical"),
      children:
        version?.canonicalJson != null ? (
          <SnapshotJson key={version.id} canonical={version.canonicalJson} />
        ) : version ? (
          <p className="empty-state">{t("plan.noCanonical")}</p>
        ) : (
          missing
        ),
    },
    {
      key: "nodes",
      label: t("dossier.nodes"),
      children: plan ? (
        <div className="dossier-content">
          <p>
            <strong>{plan.workflow.name}</strong> · {plan.goal}
          </p>
          <PlanNodes plan={plan} />
        </div>
      ) : (
        missing
      ),
    },
    {
      key: "hashes",
      label: t("plan.hashes"),
      children: version ? <PlanHashes version={version} /> : missing,
    },
  ];
  return (
    <Tabs
      activeKey={items.find((item) => item.key === tab)?.key ?? "jobs"}
      onChange={onTab}
      more={{ trigger: "click" }}
      items={items}
    />
  );
}

export function PlanContent({ version }: { version: PlanDocument }) {
  const { t } = useI18n();
  const plan = version.snapshot.plan;
  return (
    <div className="dossier-content">
      <p>
        <strong>{plan.workflow.name}</strong> · {plan.goal}
      </p>
      <PlanHashes version={version} />
      <h3>{t("dossier.nodes")}</h3>
      <PlanNodes plan={plan} />
      {version.canonicalJson !== null && (
        <details>
          <summary>{t("plan.canonical")}</summary>
          <SnapshotJson canonical={version.canonicalJson} />
        </details>
      )}
    </div>
  );
}
