import { Collapse, Tag } from "antd";
import type { ReactNode } from "react";
import type {
  ApprovedWorkingDossier,
  DossierFieldValue as SavedField,
  WorkingDossierView,
} from "@realityjunky/badger";
import { approvedDossierFields } from "../../api/working-dossier.js";
import { useI18n, type I18n } from "../../i18n/I18nContext.js";
import {
  DossierEvidenceLinks,
  type EvidenceContext,
} from "../working-dossier/DossierEvidence.js";
import {
  DossierFieldValue,
  handoffLabel,
  routeLabel,
} from "../working-dossier/DossierFields.js";

type Side = "before" | "after";
type Change<T> = { id: string; before?: T; after?: T };

function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

function changedRecords<T>(
  previous: Record<string, T> = {},
  proposed: Record<string, T> = {},
): Change<T>[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(proposed)])]
    .sort()
    .flatMap((id) => {
      const before = Object.hasOwn(previous, id) ? previous[id] : undefined;
      const after = Object.hasOwn(proposed, id) ? proposed[id] : undefined;
      return stableJson(before) === stableJson(after)
        ? []
        : [{ id, before, after }];
    });
}

function recordPins(pins: WorkingDossierView["pins"] = []) {
  return Object.fromEntries(pins.map((pin) => [pin.skillId, pin]));
}

function changeList<T extends object>(
  changes: Change<T>[],
  t: I18n["t"],
  label: (record: T, side: Side, id: string) => string,
  render: (record: T, side: Side, id: string) => ReactNode,
) {
  return (
    <div className="dossier-review-records">
      {changes.map(({ id, before, after }) => {
        const change = before ? (after ? "modified" : "removed") : "added";
        return (
          <section className="working-dossier-field" key={id}>
            <div className="dossier-review-record-heading">
              <h4>
                {after
                  ? label(after, "after", id)
                  : label(before!, "before", id)}
              </h4>
              <Tag>{t(`dossier.change.${change}`)}</Tag>
            </div>
            <div className="dossier-review-values">
              {before && (
                <div>
                  <p className="field-label">{t("dossier.change.before")}</p>
                  {render(before, "before", id)}
                </div>
              )}
              {after && (
                <div>
                  <p className="field-label">{t("dossier.change.after")}</p>
                  {render(after, "after", id)}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function WorkingDossierApproval({
  dossier,
  previous,
  basePath,
  path,
}: {
  dossier: WorkingDossierView;
  previous: ApprovedWorkingDossier | undefined;
  basePath: string;
  path: string;
}) {
  const { t, format } = useI18n();
  const snapshots = { before: previous ?? dossier, after: dossier };
  const context = (side: Side): EvidenceContext => ({
    basePath,
    path,
    revision: snapshots[side].revision,
    pins: snapshots[side].pins,
  });
  const fields = {
    before: new Map(
      (previous ? approvedDossierFields(previous) : []).map((field) => [
        field.id,
        field,
      ]),
    ),
    after: new Map(dossier.projection.fields.map((field) => [field.id, field])),
  };
  const fieldLabel = (side: Side, id: string) => {
    const field = fields[side].get(id);
    if (!field) return id;
    return field.scope === "workflow"
      ? field.label
      : [field.ownerLabel, field.label].join(" · ");
  };
  const fieldList = (changes: Change<SavedField>[]) =>
    changeList(
      changes,
      t,
      (_record, side, id) => fieldLabel(side, id),
      (record, side, id) => (
        <DossierFieldValue
          field={{
            content: record,
            blocker: null,
            evidenceChanges: [],
            required: fields[side].get(id)?.required ?? false,
          }}
          context={context(side)}
          collapseEvidence
        />
      ),
    );
  const fieldChanges = changedRecords(
    previous?.content.fields,
    dossier.content.fields,
  );
  const workflowFields = fieldChanges.filter(({ id }) =>
    id.startsWith("workflow/"),
  );
  const otherFields = fieldChanges.filter(
    ({ id }) => !id.startsWith("workflow/"),
  );
  const group = <T extends object>(
    key: string,
    label: string,
    changes: Change<T>[],
    labelRecord: (record: T, side: Side, id: string) => string,
    renderRecord: (record: T, side: Side, id: string) => ReactNode,
  ) =>
    changes.length > 0
      ? [
          {
            key,
            label: format("dossier.change.group", {
              label,
              count: changes.length,
            }),
            children: changeList(changes, t, labelRecord, renderRecord),
          },
        ]
      : [];
  const groups = [
    ...group(
      "nodes",
      t("workingDossier.occurrences"),
      changedRecords(previous?.content.nodes, dossier.content.nodes),
      (node) => node.label,
      (node, side) => (
        <>
          <p>{node.label}</p>
          <p>
            {t(
              node.kind === "node"
                ? "workingDossier.kind.node"
                : "workingDossier.kind.required-skill-call",
            )}{" "}
            · {t("workingDossier.occurrenceOrder")} {node.order}
          </p>
          {node.parent && (
            <p>
              {t("workingDossier.parentNode")} ·{" "}
              {snapshots[side].content.nodes[node.parent]?.label ?? node.parent}
            </p>
          )}
          <p>
            {snapshots[side].pins.find(
              ({ skillId }) => skillId === node.skillId,
            )?.name ?? node.skillId}
          </p>
          <code>{node.hash}</code>
        </>
      ),
    ),
    ...group(
      "routes",
      t("questionnaire.topic.routes"),
      changedRecords(previous?.content.routes, dossier.content.routes),
      (route, side) => routeLabel(snapshots[side].content, route, t, format),
      (route, side) => (
        <>
          <p>{routeLabel(snapshots[side].content, route, t, format)}</p>
          {route.condition && <p>{route.condition}</p>}
          {route.maxVisits !== undefined && (
            <p>
              {format("workingDossier.visitLimit", { count: route.maxVisits })}
            </p>
          )}
        </>
      ),
    ),
    ...group(
      "interfaces",
      t("workingDossier.handoffs"),
      changedRecords(previous?.content.interfaces, dossier.content.interfaces),
      (edge, side) =>
        handoffLabel(snapshots[side].content, edge.producer, edge.consumer),
      (edge, side) => (
        <>
          <p>
            {handoffLabel(
              snapshots[side].content,
              edge.producer,
              edge.consumer,
            )}
          </p>
          <p>
            {t(
              edge.status === "documented"
                ? "workingDossier.interface.documented"
                : "workingDossier.interface.proposed",
            )}
          </p>
          {edge.producerEvidence.length > 0 && (
            <div>
              <p className="field-label">{t("workingDossier.producer")}</p>
              <DossierEvidenceLinks
                evidence={edge.producerEvidence}
                context={context(side)}
                collapsible
              />
            </div>
          )}
          {edge.consumerEvidence.length > 0 && (
            <div>
              <p className="field-label">{t("workingDossier.consumer")}</p>
              <DossierEvidenceLinks
                evidence={edge.consumerEvidence}
                context={context(side)}
                collapsible
              />
            </div>
          )}
        </>
      ),
    ),
    ...(otherFields.length > 0
      ? [
          {
            key: "fields",
            label: format("dossier.change.group", {
              label: t("workingDossier.fields"),
              count: otherFields.length,
            }),
            children: fieldList(otherFields),
          },
        ]
      : []),
    ...group(
      "findings",
      t("workingDossier.findings"),
      changedRecords(previous?.content.findings, dossier.content.findings),
      (_finding, _side, id) => id,
      (finding, side) => (
        <>
          <p>{finding.consequence}</p>
          <ul>
            {finding.fields.map((id) => (
              <li key={id}>{fieldLabel(side, id)}</li>
            ))}
          </ul>
          <DossierEvidenceLinks
            evidence={finding.evidence}
            context={context(side)}
            collapsible
          />
        </>
      ),
    ),
    ...group(
      "pins",
      t("workingDossier.pins"),
      changedRecords(recordPins(previous?.pins), recordPins(dossier.pins)),
      (pin) => pin.name,
      (pin) => (
        <>
          <p>{pin.name}</p>
          <code>{pin.hash}</code>
        </>
      ),
    ),
  ];

  return (
    <>
      <h3>
        {previous
          ? format("dossier.change.sinceApproval", {
              revision: previous.revision,
            })
          : t("dossier.change.firstApproval")}
      </h3>
      {workflowFields.length > 0 && fieldList(workflowFields)}
      {groups.length > 0 && <Collapse items={groups} />}
      {workflowFields.length === 0 && groups.length === 0 && (
        <p>{t("dossier.change.empty")}</p>
      )}
    </>
  );
}
