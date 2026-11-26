import { Button, Input, Modal, Space, Tabs, Tag } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";
import { useId, useState, type ReactNode } from "react";
import type {
  DossierPin,
  WorkingDossierContent,
  WorkingDossierView,
} from "@realityjunky/badger";
import type { WorkingDossierField } from "../../api/working-dossier.js";
import { normalizeBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import {
  DossierDiagram,
  type DossierHighlights,
  type DossierSelection,
} from "./DossierDiagram.js";
import {
  DossierEvidenceLinks,
  type EvidenceContext,
} from "./DossierEvidence.js";
import { DossierFieldList, handoffLabel, routeLabel } from "./DossierFields.js";

const views = [
  { id: "interface", label: "workingDossier.handoffs" },
  { id: "route", label: "questionnaire.topic.routes" },
  { id: "finding", label: "workingDossier.findings" },
  { id: "skill", label: "workingDossier.pins" },
] as const;
type StudyView = (typeof views)[number]["id"];

function diagramHighlights(
  content: WorkingDossierContent,
  pins: DossierPin[],
  selection: DossierSelection | undefined,
  linkedFields: WorkingDossierField[],
): DossierHighlights {
  const highlights: DossierHighlights = {
    node: new Set(),
    interface: new Set(),
    route: new Set(),
  };
  function highlightSkill(skillId: string) {
    const pin = pins.find((entry) => entry.skillId === skillId);
    for (const [id, node] of Object.entries(content.nodes)) {
      if (node.skillId === skillId && node.hash === pin?.hash)
        highlights.node.add(id);
    }
  }
  function highlightHandoff(id: string) {
    const handoff = content.interfaces[id];
    highlights.interface.add(id);
    highlights.node.add(handoff.producer);
    highlights.node.add(handoff.consumer);
  }
  function highlightRoute(id: string, from: string, to: string) {
    highlights.route.add(id);
    highlights.node.add(from);
    highlights.node.add(to);
  }

  if (selection?.kind === "skill") highlightSkill(selection.id);
  if (selection?.kind === "node") highlights.node.add(selection.id);
  if (selection?.kind === "interface") highlightHandoff(selection.id);
  if (selection?.kind === "route") {
    const route = content.routes![selection.id];
    highlightRoute(selection.id, route.from, route.to);
  }
  for (const { scope, owner, key } of linkedFields) {
    if (scope === "skill") highlightSkill(owner);
    if (scope === "node") highlights.node.add(owner);
    if (scope === "interface") highlightHandoff(owner);
    if (scope === "workflow" && (key === "routes" || key === "boundedCycles")) {
      for (const [id, route] of Object.entries(content.routes ?? {})) {
        if (key === "routes" || route.kind === "rework")
          highlightRoute(id, route.from, route.to);
      }
    }
  }
  return highlights;
}

function StudySelect({
  label,
  placeholder,
  value,
  onChange,
  inspectorId,
  children,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
  inspectorId: string;
  children: ReactNode;
}) {
  const pickerId = useId();
  return (
    <div className="working-dossier-study-picker">
      <label htmlFor={pickerId}>{label}</label>
      <select
        id={pickerId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-controls={inspectorId}
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
    </div>
  );
}

export function WorkingDossierStudy({
  dossier,
  context,
  showPinnedHashes = false,
  standalone = true,
}: {
  dossier: Pick<
    WorkingDossierView,
    "revision" | "content" | "pins" | "projection"
  > & { prompt?: string | null };
  context: EvidenceContext;
  showPinnedHashes?: boolean;
  standalone?: boolean;
}) {
  const { t, format } = useI18n();
  const inspectorId = useId();
  const [view, setView] = useState<StudyView>("interface");
  const [selections, setSelections] = useState<
    Partial<Record<StudyView, DossierSelection>>
  >({});
  const [prompt, setPrompt] = useState<{ text: string; copied: boolean }>();
  const { content, pins, projection } = dossier;
  const handoffs = Object.entries(content.interfaces);
  const routes = Object.entries(content.routes ?? {});
  const findings = Object.entries(content.findings);
  const selection = selections[view];
  const route =
    selection?.kind === "route"
      ? routes.find(([id]) => id === selection.id)?.[1]
      : undefined;
  const handoff =
    selection?.kind === "interface"
      ? handoffs.find(([id]) => id === selection.id)?.[1]
      : undefined;
  const finding =
    selection?.kind === "finding"
      ? findings.find(([id]) => id === selection.id)?.[1]
      : undefined;
  const occurrence =
    selection?.kind === "node" && Object.hasOwn(content.nodes, selection.id)
      ? content.nodes[selection.id]
      : undefined;
  const pin = pins.find(
    (pin) =>
      pin.skillId ===
      (occurrence?.skillId ??
        (selection?.kind === "skill" ? selection.id : undefined)),
  );
  const selected =
    route || handoff || occurrence || finding || pin ? selection : undefined;
  const fieldsById = new Map(
    projection.fields.map((field) => [field.id, field]),
  );
  const linkedFields = (finding?.fields ?? []).flatMap((id) => {
    const field = fieldsById.get(id);
    return field ? [field] : [];
  });
  const highlights = diagramHighlights(content, pins, selected, linkedFields);
  const fields = projection.fields.filter((field) =>
    route
      ? field.scope === "workflow" &&
        (field.key === "routes" ||
          (route.kind === "rework" && field.key === "boundedCycles"))
      : field.scope === selected?.kind && field.owner === selected.id,
  );

  function select(next: DossierSelection) {
    const tab = next.kind === "node" ? "skill" : next.kind;
    setSelections((current) => ({ ...current, [tab]: next }));
    setView(tab);
  }

  function choose(id: string) {
    if (id) select({ kind: view, id });
    else setSelections((current) => ({ ...current, [view]: undefined }));
  }

  async function copyPrompt(text: string) {
    const base = normalizeBasePath(context.basePath);
    const promptText = `Use the connected Badger MCP for deployment ${window.location.origin}${base === "/" ? "" : base}.\n\n${text}`;
    try {
      await navigator.clipboard.writeText(promptText);
      setPrompt({ text: promptText, copied: true });
    } catch {
      setPrompt({ text: promptText, copied: false });
    }
  }

  function endpoint(occurrenceId: string) {
    const node = content.nodes[occurrenceId];
    if (!node) return null;
    const name = pins.find((pin) => pin.skillId === node.skillId)?.name;
    return (
      <>
        <p>
          {name && name !== node.label ? `${node.label} · ${name}` : node.label}
        </p>
        {showPinnedHashes && <code className="study-hash">{node.hash}</code>}
      </>
    );
  }

  const pickerProps = {
    value: selected?.id ?? "",
    onChange: choose,
    inspectorId,
  };
  function selectionControl() {
    switch (view) {
      case "interface":
        return handoffs.length > 0 ? (
          <StudySelect
            {...pickerProps}
            label={t("workingDossier.handoff")}
            placeholder={t("workingDossier.selectHandoff")}
          >
            {(["documented", "proposed"] as const).map((status) => {
              const group = handoffs.filter(
                ([, edge]) => edge.status === status,
              );
              return (
                group.length > 0 && (
                  <optgroup
                    key={status}
                    label={t(`workingDossier.interface.${status}`)}
                  >
                    {group.map(([id, edge]) => {
                      const artifact =
                        content.fields[`interface/${id}/artifact`]?.value;
                      return (
                        <option key={id} value={id}>
                          {handoffLabel(content, edge.producer, edge.consumer)}
                          {artifact && ` · ${artifact}`}
                        </option>
                      );
                    })}
                  </optgroup>
                )
              );
            })}
          </StudySelect>
        ) : (
          <p className="muted">{t("workingDossier.noHandoffs")}</p>
        );
      case "route":
        return routes.length > 0 ? (
          <StudySelect
            {...pickerProps}
            label={t("workingDossier.route")}
            placeholder={t("workingDossier.selectRoute")}
          >
            {routes.map(([id, route]) => (
              <option key={id} value={id}>
                {routeLabel(content, route, t, format)}
                {route.condition && ` · ${route.condition}`}
              </option>
            ))}
          </StudySelect>
        ) : (
          <p className="muted">{t("workingDossier.noRoutes")}</p>
        );
      case "finding":
        return findings.length > 0 ? (
          <StudySelect
            {...pickerProps}
            label={t("workingDossier.finding")}
            placeholder={t("workingDossier.selectFinding")}
          >
            {findings.map(([id, finding]) => (
              <option key={id} value={id}>
                {finding.consequence}
              </option>
            ))}
          </StudySelect>
        ) : (
          <p className="muted">{t("workingDossier.noFindings")}</p>
        );
      case "skill":
        return (
          <section aria-label={t("workingDossier.pins")}>
            {pins.length > 0 ? (
              <Space wrap>
                {pins.map((pin) => (
                  <button
                    key={pin.skillId}
                    className="working-dossier-selection"
                    type="button"
                    aria-pressed={
                      selected?.kind === "skill" && selected.id === pin.skillId
                    }
                    aria-controls={inspectorId}
                    onClick={() =>
                      choose(
                        selected?.kind === "skill" &&
                          selected.id === pin.skillId
                          ? ""
                          : pin.skillId,
                      )
                    }
                  >
                    {pin.name}
                  </button>
                ))}
              </Space>
            ) : (
              <p className="muted">{t("workingDossier.noPins")}</p>
            )}
          </section>
        );
    }
  }

  const title = route
    ? routeLabel(content, route, t, format)
    : handoff
      ? handoffLabel(content, handoff.producer, handoff.consumer)
      : finding
        ? t("workingDossier.finding")
        : (occurrence?.label ?? pin?.name);

  return (
    <div className="working-dossier-study">
      {standalone && (
        <div className="working-dossier-toolbar">
          <span className="muted" role="status">
            {format("workingDossier.revision", { revision: dossier.revision })}
          </span>
          {dossier.prompt && (
            <Button
              type="primary"
              onClick={() => void copyPrompt(dossier.prompt!)}
            >
              {t("workingDossier.copyPrompt")}
            </Button>
          )}
        </div>
      )}
      <DossierDiagram
        content={content}
        selection={selected}
        highlights={highlights}
        edgeView={view === "interface" || view === "route" ? view : undefined}
        onSelect={select}
        inspectorId={inspectorId}
      />
      <Tabs
        className="working-dossier-study-tabs"
        activeKey={view}
        locale={{ dropdownAriaLabel: t("workingDossier.moreTabs") }}
        more={{
          trigger: "click",
          icon: (
            <>
              <EllipsisOutlined aria-hidden="true" />
              <span className="sr-only">{t("workingDossier.moreTabs")}</span>
            </>
          ),
        }}
        onChange={(key) => {
          const tab = views.find(({ id }) => id === key);
          if (tab) setView(tab.id);
        }}
        items={views.map(({ id, label }) => ({
          key: id,
          label: t(label),
          children: id === view && (
            <div className="working-dossier-study-tab">
              {selectionControl()}
              <div id={inspectorId} hidden={!selected}>
                {selected && (
                  <section
                    key={`${selected.kind}/${selected.id}`}
                    className="working-dossier-inspector"
                    aria-label={t("workingDossier.details")}
                  >
                    <h3>{title}</h3>
                    {occurrence && (
                      <p className="muted">
                        {pin &&
                          pin.name !== occurrence.label &&
                          `${pin.name} · `}
                        {t(`workingDossier.kind.${occurrence.kind}`)}
                      </p>
                    )}
                    {showPinnedHashes && (occurrence || pin) && (
                      <code className="study-hash">
                        {occurrence?.hash ?? pin?.hash}
                      </code>
                    )}
                    {occurrence?.parent && (
                      <p>
                        {t("workingDossier.parentNode")} ·{" "}
                        {content.nodes[occurrence.parent]?.label}
                      </p>
                    )}
                    {selected.kind === "skill" &&
                      highlights.node.size === 0 && (
                        <p className="muted">
                          {t("workingDossier.noSkillUses")}
                        </p>
                      )}
                    {handoff && (
                      <>
                        <Tag
                          color={
                            handoff.status === "documented"
                              ? "success"
                              : "warning"
                          }
                        >
                          {t(`workingDossier.interface.${handoff.status}`)}
                        </Tag>
                        <div className="working-dossier-endpoints">
                          <section>
                            <h4>{t("workingDossier.producer")}</h4>
                            {endpoint(handoff.producer)}
                            <DossierEvidenceLinks
                              evidence={handoff.producerEvidence}
                              context={context}
                              collapsible
                            />
                          </section>
                          <section>
                            <h4>{t("workingDossier.consumer")}</h4>
                            {endpoint(handoff.consumer)}
                            <DossierEvidenceLinks
                              evidence={handoff.consumerEvidence}
                              context={context}
                              collapsible
                            />
                          </section>
                        </div>
                      </>
                    )}
                    {route?.condition && (
                      <>
                        <h4>{t("workingDossier.routeCondition")}</h4>
                        <p className="questionnaire-text">{route.condition}</p>
                      </>
                    )}
                    {route?.maxVisits !== undefined && (
                      <p>
                        {format("workingDossier.visitLimit", {
                          count: route.maxVisits,
                        })}
                      </p>
                    )}
                    {finding && (
                      <>
                        <p className="questionnaire-text">
                          {finding.consequence}
                        </p>
                        {projection.staleFindings.includes(selected.id) && (
                          <Tag color="warning">{t("ledger.state.stale")}</Tag>
                        )}
                        {linkedFields.length > 0 && (
                          <ul className="working-dossier-links">
                            {linkedFields.map((field) => (
                              <li key={field.id}>
                                {field.ownerLabel} · {field.label}
                              </li>
                            ))}
                          </ul>
                        )}
                        <DossierEvidenceLinks
                          evidence={finding.evidence}
                          context={context}
                          collapsible
                        />
                      </>
                    )}
                    {fields.length > 0 && (
                      <DossierFieldList fields={fields} context={context} />
                    )}
                  </section>
                )}
              </div>
            </div>
          ),
        }))}
      />
      {standalone && (
        <details className="working-dossier-workflow-details">
          <summary>{t("workingDossier.workflowDetails")}</summary>
          <DossierFieldList
            fields={projection.fields.filter(
              (field) => field.scope === "workflow",
            )}
            context={context}
          />
        </details>
      )}
      {prompt && (
        <Modal
          open
          title={t("prompts.show")}
          width={840}
          footer={null}
          onCancel={() => setPrompt(undefined)}
        >
          <p role="status">
            {t(prompt.copied ? "prompts.copied" : "prompts.manualCopy")}
          </p>
          <Input.TextArea
            aria-label={t("prompts.show")}
            readOnly
            value={prompt.text}
            rows={12}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Modal>
      )}
    </div>
  );
}
