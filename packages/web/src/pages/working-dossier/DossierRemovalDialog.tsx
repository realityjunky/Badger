import { Alert, Button, Modal } from "antd";
import type { WorkingDossierView } from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";
import type { EvidenceContext } from "./DossierEvidence.js";
import { handoffLabel, routeLabel } from "./DossierFields.js";
import { useDossierEdit, type DossierChanges } from "./useDossierEdit.js";

export interface DossierRemovalTarget {
  kind: "node" | "interface" | "route" | "field" | "finding";
  id: string;
}

export function DossierRemovalDialog({
  dossier,
  context,
  target,
  onSaved,
  onReload,
  onCancel,
}: {
  dossier: WorkingDossierView;
  context: EvidenceContext;
  target: DossierRemovalTarget;
  onSaved(view: WorkingDossierView): void;
  onReload(): Promise<void>;
  onCancel(): void;
}) {
  const { t, format } = useI18n();
  const { busy, changed, editable, failure, save, rebase } = useDossierEdit(
    dossier,
    context,
    onSaved,
    onReload,
  );
  const { fields, nodes, interfaces, findings, routes = {} } = dossier.content;
  const { kind, id } = target;
  const collection = {
    field: fields,
    node: nodes,
    interface: interfaces,
    route: routes,
    finding: findings,
  };
  const exists = Object.hasOwn(collection[kind], id);

  const removedNodes = new Set(kind === "node" ? [id] : []);
  for (const [childId, child] of Object.entries(nodes)) {
    if (child.parent === id && kind === "node") removedNodes.add(childId);
  }
  const removedHandoffs = new Set(kind === "interface" ? [id] : []);
  for (const [edgeId, edge] of Object.entries(interfaces)) {
    if (removedNodes.has(edge.producer) || removedNodes.has(edge.consumer))
      removedHandoffs.add(edgeId);
  }
  const removedRoutes = new Set(kind === "route" ? [id] : []);
  for (const [routeId, route] of Object.entries(routes)) {
    if (removedNodes.has(route.from) || removedNodes.has(route.to))
      removedRoutes.add(routeId);
  }
  function removesField(fieldId: string) {
    const [scope, owner] = fieldId.split("/");
    return (
      (kind === "field" && id === fieldId) ||
      (scope === "node" && removedNodes.has(owner)) ||
      (scope === "interface" && removedHandoffs.has(owner))
    );
  }
  const removedFields = Object.keys(fields).filter(removesField);
  const removedFindings = Object.entries(findings)
    .filter(
      ([findingId, finding]) =>
        (kind === "finding" && findingId === id) ||
        finding.fields.some(removesField),
    )
    .map(([findingId]) => findingId);
  const changes: DossierChanges = {
    ...(removedNodes.size
      ? { nodes: Object.fromEntries([...removedNodes].map((id) => [id, null])) }
      : {}),
    ...(removedHandoffs.size
      ? {
          interfaces: Object.fromEntries(
            [...removedHandoffs].map((id) => [id, null]),
          ),
        }
      : {}),
    ...(removedRoutes.size
      ? {
          routes: Object.fromEntries(
            [...removedRoutes].map((id) => [id, null]),
          ),
        }
      : {}),
    ...(removedFields.length
      ? { fields: Object.fromEntries(removedFields.map((id) => [id, null])) }
      : {}),
    ...(removedFindings.length
      ? {
          findings: Object.fromEntries(removedFindings.map((id) => [id, null])),
        }
      : {}),
  };
  const fieldLabels = new Map(
    dossier.projection.fields.map((field) => [
      field.id,
      `${field.ownerLabel} · ${field.label}`,
    ]),
  );
  const groups = [
    {
      label: t("workingDossier.occurrences"),
      records: [...removedNodes].map((id) => nodes[id]?.label ?? id),
    },
    {
      label: t("workingDossier.handoffs"),
      records: [...removedHandoffs].map((id) => {
        const edge = interfaces[id];
        return edge
          ? handoffLabel(dossier.content, edge.producer, edge.consumer)
          : id;
      }),
    },
    {
      label: t("questionnaire.topic.routes"),
      records: [...removedRoutes].map((id) =>
        routes[id] ? routeLabel(dossier.content, routes[id], t, format) : id,
      ),
    },
    {
      label: t("workingDossier.fields"),
      records: removedFields.map((id) => fieldLabels.get(id) ?? id),
    },
    {
      label: t("workingDossier.findings"),
      records: removedFindings.map((id) => findings[id].consequence),
    },
  ];

  return (
    <Modal
      open
      title={t("workingDossier.confirmRemoval")}
      okText={t("workingDossier.removeFromDossier")}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      okButtonProps={{
        danger: true,
        disabled: changed || !editable || !exists,
      }}
      cancelButtonProps={{ disabled: busy }}
      maskClosable={false}
      closable={!busy}
      keyboard={!busy}
      onCancel={onCancel}
      onOk={() => {
        if (exists) void save(changes);
      }}
    >
      <div className="working-dossier-editor">
        {failure && <Alert type="error" showIcon title={failure} />}
        {!exists ? (
          <Alert
            type="warning"
            showIcon
            title={t("workingDossier.alreadyRemoved")}
          />
        ) : (
          changed && (
            <Alert
              type="warning"
              showIcon
              title={t("workingDossier.conflict")}
              action={
                editable && (
                  <Button onClick={rebase}>
                    {t("workingDossier.reviewRemoval")}
                  </Button>
                )
              }
            />
          )
        )}
        {exists && (
          <div className="working-dossier-removal-list">
            <p>
              {format("workingDossier.removalDetail", {
                revision: dossier.revision,
              })}
            </p>
            {groups
              .filter(({ records }) => records.length)
              .map(({ label, records }) => (
                <section key={label}>
                  <h3>{label}</h3>
                  <ul>
                    {records.map((record, index) => (
                      <li key={index}>{record}</li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
