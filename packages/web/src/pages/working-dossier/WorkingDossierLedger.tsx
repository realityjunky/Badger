import { Alert, Button, Collapse, Select, Space, Tag } from "antd";
import { useId, useState } from "react";
import type { WorkingDossierView } from "@realityjunky/badger";
import type { WorkingDossierField } from "../../api/working-dossier.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { DossierEditor, type DossierEditTarget } from "./DossierEditor.js";
import {
  DossierEvidenceLinks,
  type EvidenceContext,
} from "./DossierEvidence.js";
import {
  DossierFieldValue,
  handoffLabel,
  routeLabel,
} from "./DossierFields.js";
import {
  DossierRemovalDialog,
  type DossierRemovalTarget,
} from "./DossierRemovalDialog.js";

export function WorkingDossierLedger({
  dossier,
  context,
  linkedField,
  onAsk,
  onSaved,
  onReload,
}: {
  dossier: WorkingDossierView;
  context: EvidenceContext;
  linkedField: string | null;
  onAsk(field: WorkingDossierField, handoffId?: string): void;
  onSaved(view: WorkingDossierView): void;
  onReload(): Promise<void>;
}) {
  const { t, format } = useI18n();
  const [selected, setSelected] = useState<string>();
  const [edit, setEdit] = useState<DossierEditTarget>();
  const [removal, setRemoval] = useState<DossierRemovalTarget>();
  const [openTopics, setOpenTopics] = useState<string[]>();
  const selectorId = useId();
  const fields = dossier.projection.fields;
  const field = fields.find(({ id }) => id === (selected ?? linkedField));
  const canEdit = dossier.editable && dossier.available;
  const fieldsByTopic = new Map<string, WorkingDossierField[]>();
  for (const field of fields) {
    const entries = fieldsByTopic.get(field.topic) ?? [];
    entries.push(field);
    fieldsByTopic.set(field.topic, entries);
  }
  const defaultTopic =
    dossier.readiness.find(({ blockers }) => blockers.length)?.topic ?? "scope";
  const nodes = Object.entries(dossier.content.nodes);
  const interfaces = Object.entries(dossier.content.interfaces);
  const routes = Object.entries(dossier.content.routes ?? {});
  const removedFields = dossier.projection.removedFields;
  const staleFindings = dossier.projection.staleFindings;

  function removeButton(
    kind: DossierRemovalTarget["kind"],
    id: string,
    label: string,
  ) {
    return (
      <Button danger onClick={() => setRemoval({ kind, id })}>
        {label}
      </Button>
    );
  }

  function renderField(field: WorkingDossierField) {
    return (
      <article
        key={field.id}
        className="working-dossier-field"
        aria-label={`${field.ownerLabel} · ${field.label}`}
      >
        <div className="working-dossier-toolbar">
          <h4>
            {field.ownerLabel} · {field.label}
          </h4>
          {canEdit && (
            <Space wrap>
              <Button onClick={() => setEdit({ kind: "field", field })}>
                {t("workingDossier.editField")}
              </Button>
              <Button onClick={() => onAsk(field)}>
                {t("workingDossier.ask")}
              </Button>
            </Space>
          )}
        </div>
        <DossierFieldValue
          field={field}
          context={context}
          questions={dossier.questions?.filter(({ fields }) =>
            fields.includes(field.id),
          )}
        />
      </article>
    );
  }

  return (
    <section
      className="working-dossier-ledger"
      aria-label={t("workingDossier.title")}
    >
      <div className="working-dossier-toolbar">
        <div>
          <h2>{t("workingDossier.title")}</h2>
          <span className="muted" role="status">
            {format("workingDossier.revision", { revision: dossier.revision })}
          </span>
        </div>
        {canEdit && (
          <Space wrap>
            <Button
              onClick={() => setEdit({ kind: "node", id: crypto.randomUUID() })}
            >
              {t("workingDossier.addOccurrence")}
            </Button>
            <Button
              disabled={!nodes.length}
              onClick={() =>
                setEdit({ kind: "interface", id: crypto.randomUUID() })
              }
            >
              {t("workingDossier.addHandoff")}
            </Button>
            <Button
              disabled={!nodes.some(([, node]) => node.kind === "node")}
              onClick={() =>
                setEdit({ kind: "route", id: crypto.randomUUID() })
              }
            >
              {t("workingDossier.addRoute")}
            </Button>
          </Space>
        )}
      </div>
      {!dossier.available && (
        <Alert type="info" showIcon title={t("workingDossier.waitForCheck")} />
      )}
      {removedFields.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title={t("workingDossier.removedFields")}
          description={
            <ul className="working-dossier-links">
              {removedFields.map((id) => (
                <li key={id}>
                  <div className="working-dossier-toolbar">
                    <code>{id}</code>
                    {canEdit &&
                      removeButton(
                        "field",
                        id,
                        t("workingDossier.removeField"),
                      )}
                  </div>
                  {dossier.content.fields[id]?.value && (
                    <p className="questionnaire-text">
                      {dossier.content.fields[id].value}
                    </p>
                  )}
                  {dossier.content.fields[id]?.reason && (
                    <p className="questionnaire-text">
                      {dossier.content.fields[id].reason}
                    </p>
                  )}
                  <DossierEvidenceLinks
                    evidence={dossier.content.fields[id]?.evidence ?? []}
                    context={context}
                  />
                </li>
              ))}
            </ul>
          }
        />
      )}
      {staleFindings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title={t("workingDossier.staleFindings")}
          description={
            <ul className="working-dossier-links">
              {staleFindings.map((id) => (
                <li key={id}>
                  <div className="working-dossier-toolbar">
                    <span>
                      {dossier.content.findings[id]?.consequence ?? id}
                    </span>
                    {canEdit &&
                      removeButton(
                        "finding",
                        id,
                        t("workingDossier.removeFinding"),
                      )}
                  </div>
                  <DossierEvidenceLinks
                    evidence={dossier.content.findings[id]?.evidence ?? []}
                    context={context}
                  />
                </li>
              ))}
            </ul>
          }
        />
      )}
      <div className="working-dossier-field-picker">
        <label className="field-label" htmlFor={selectorId}>
          {t("workingDossier.field")}
        </label>
        <Select
          id={selectorId}
          allowClear
          showSearch
          optionFilterProp="label"
          value={field?.id}
          options={fields.map((field) => ({
            value: field.id,
            label: `${field.ownerLabel} · ${field.label}`,
          }))}
          onChange={(id) => setSelected(id ?? "")}
        />
      </div>
      {field && renderField(field)}
      <section aria-label={t("ledger.readiness")}>
        <h3>{t("ledger.readiness")}</h3>
        <Collapse
          activeKey={openTopics ?? [field?.topic ?? defaultTopic]}
          onChange={setOpenTopics}
          items={dossier.readiness.map(({ topic, blockers }) => ({
            key: topic,
            label: (
              <Space wrap>
                <strong>{t(`questionnaire.topic.${topic}`)}</strong>
                <Tag color={blockers.length ? "warning" : "success"}>
                  {blockers.length
                    ? format("workingDossier.itemsOpen", {
                        count: blockers.length,
                      })
                    : t("ledger.ready")}
                </Tag>
              </Space>
            ),
            children: (
              <div className="working-dossier-field-list">
                {!!blockers.length && (
                  <ul className="working-dossier-blocker">
                    {blockers.map(({ id, message }, index) => (
                      <li key={`${id}/${index}`}>
                        {fields.some((field) => field.id === id) ? (
                          <Button type="link" onClick={() => setSelected(id)}>
                            {message}
                          </Button>
                        ) : (
                          message
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {fieldsByTopic
                  .get(topic)
                  ?.filter(({ id }) => id !== field?.id)
                  .map(renderField)}
              </div>
            ),
          }))}
        />
      </section>
      {canEdit &&
        (nodes.length > 0 || interfaces.length > 0 || routes.length > 0) && (
          <Collapse
            items={[
              {
                key: "structure",
                label: t("workingDossier.structure"),
                children: (
                  <div className="working-dossier-field-list">
                    {nodes.map(([id, node]) => (
                      <div
                        className="working-dossier-toolbar"
                        key={`node/${id}`}
                      >
                        <span>{node.label}</span>
                        <Space wrap>
                          <Button
                            onClick={() => setEdit({ kind: "node", id, node })}
                          >
                            {t("workingDossier.editOccurrence")}
                          </Button>
                          {removeButton(
                            "node",
                            id,
                            t("workingDossier.removeOccurrence"),
                          )}
                        </Space>
                      </div>
                    ))}
                    {interfaces.map(([id, edge]) => {
                      const field = fields.find(
                        (field) =>
                          field.scope === "interface" && field.owner === id,
                      );
                      return (
                        <div
                          className="working-dossier-toolbar"
                          key={`interface/${id}`}
                        >
                          <span>
                            {handoffLabel(
                              dossier.content,
                              edge.producer,
                              edge.consumer,
                            )}
                          </span>
                          <Space wrap>
                            <Button
                              onClick={() =>
                                setEdit({ kind: "interface", id, edge })
                              }
                            >
                              {t("workingDossier.editHandoff")}
                            </Button>
                            {field && (
                              <Button onClick={() => onAsk(field, id)}>
                                {t("workingDossier.ask")}
                              </Button>
                            )}
                            {removeButton(
                              "interface",
                              id,
                              t("workingDossier.removeHandoff"),
                            )}
                          </Space>
                        </div>
                      );
                    })}
                    {routes.map(([id, route]) => (
                      <div
                        className="working-dossier-toolbar"
                        key={`route/${id}`}
                      >
                        <span>
                          {routeLabel(dossier.content, route, t, format)}
                        </span>
                        <Space wrap>
                          <Button
                            onClick={() =>
                              setEdit({ kind: "route", id, route })
                            }
                          >
                            {t("workingDossier.editRoute")}
                          </Button>
                          {removeButton(
                            "route",
                            id,
                            t("workingDossier.removeRoute"),
                          )}
                        </Space>
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}
      {edit && (
        <DossierEditor
          dossier={dossier}
          target={edit}
          context={context}
          onSaved={(dossier) => {
            setEdit(undefined);
            onSaved(dossier);
          }}
          onReload={onReload}
          onCancel={() => setEdit(undefined)}
        />
      )}
      {removal && (
        <DossierRemovalDialog
          dossier={dossier}
          target={removal}
          context={context}
          onSaved={(view) => {
            setRemoval(undefined);
            onSaved(view);
          }}
          onReload={onReload}
          onCancel={() => setRemoval(undefined)}
        />
      )}
    </section>
  );
}
