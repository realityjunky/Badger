import { Button, Input, Modal, Space, Tag } from "antd";
import { useId, useState } from "react";
import type { WorkingDossierView } from "@realityjunky/badger";
import { normalizeBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { DossierDiagram, type DossierSelection } from "./DossierDiagram.js";
import {
  DossierEvidenceLinks,
  type EvidenceContext,
} from "./DossierEvidence.js";
import { DossierFieldList, handoffLabel, routeLabel } from "./DossierFields.js";

export function WorkingDossierStudy({
  dossier,
  context,
}: {
  dossier: Pick<
    WorkingDossierView,
    "revision" | "content" | "pins" | "projection"
  > & { prompt?: string | null };
  context: EvidenceContext;
}) {
  const { t, format } = useI18n();
  const inspectorId = useId();
  const [selection, setSelection] = useState<DossierSelection>();
  const [prompt, setPrompt] = useState<{ text: string; copied: boolean }>();
  const { content, pins, projection } = dossier;
  const route =
    selection?.kind === "route" ? content.routes?.[selection.id] : undefined;
  const selected =
    selection &&
    (route ||
      projection.fields.some(
        (field) =>
          field.scope === selection.kind && field.owner === selection.id,
      ))
      ? selection
      : { kind: "workflow" as const, id: "workflow" };
  const fields = projection.fields.filter((field) =>
    route
      ? field.scope === "workflow" &&
        (field.key === "routes" ||
          (route.kind === "rework" && field.key === "boundedCycles"))
      : field.scope === selected.kind && field.owner === selected.id,
  );
  const first = fields[0];
  const occurrence =
    selected.kind === "node" ? content.nodes[selected.id] : undefined;
  const handoff =
    selected.kind === "interface" ? content.interfaces[selected.id] : undefined;
  const pin = pins.find(
    (pin) => pin.skillId === (occurrence?.skillId ?? selected.id),
  );

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
    const occurrence = content.nodes[occurrenceId];
    if (!occurrence) return <p>{occurrenceId}</p>;
    const name =
      pins.find((pin) => pin.skillId === occurrence.skillId)?.name ??
      occurrence.skillId;
    return (
      <>
        <p>
          {occurrence.label} · {name}
        </p>
        <code className="study-hash">{occurrence.hash}</code>
      </>
    );
  }

  return (
    <div className="working-dossier-study">
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
      <section aria-label={t("workingDossier.pins")}>
        <h3>{t("workingDossier.pins")}</h3>
        <Space wrap>
          <button
            className="working-dossier-selection"
            type="button"
            aria-pressed={selected.kind === "workflow"}
            aria-controls={inspectorId}
            onClick={() => setSelection(undefined)}
          >
            {t("questionnaire.target.workflow")}
          </button>
          {pins.map((pin) => (
            <button
              key={pin.skillId}
              className="working-dossier-selection"
              type="button"
              aria-pressed={
                selected.kind === "skill" && selected.id === pin.skillId
              }
              aria-controls={inspectorId}
              onClick={() => setSelection({ kind: "skill", id: pin.skillId })}
            >
              {pin.name}
            </button>
          ))}
        </Space>
      </section>
      <div className="working-dossier-study-layout">
        <DossierDiagram
          content={content}
          selection={selected}
          onSelect={setSelection}
          inspectorId={inspectorId}
        />
        <section
          className="working-dossier-inspector"
          aria-label={t("workingDossier.details")}
          id={inspectorId}
        >
          <h3>
            {route
              ? routeLabel(content, route, t, format)
              : handoff
                ? handoffLabel(content, handoff.producer, handoff.consumer)
                : selected.kind === "workflow"
                  ? t("questionnaire.target.workflow")
                  : (first?.ownerLabel ?? selected.id)}
          </h3>
          {pin && (
            <div className="working-dossier-pin-identity">
              {occurrence && (
                <p>
                  {pin.name} · {t(`workingDossier.kind.${occurrence.kind}`)}
                </p>
              )}
              <code className="study-hash">{occurrence?.hash ?? pin.hash}</code>
            </div>
          )}
          {occurrence?.parent && (
            <p>
              {t("workingDossier.parentNode")} ·{" "}
              {content.nodes[occurrence.parent]?.label ?? occurrence.parent}
            </p>
          )}
          {handoff && (
            <>
              <Tag
                color={handoff.status === "documented" ? "success" : "warning"}
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
                  />
                </section>
                <section>
                  <h4>{t("workingDossier.consumer")}</h4>
                  {endpoint(handoff.consumer)}
                  <DossierEvidenceLinks
                    evidence={handoff.consumerEvidence}
                    context={context}
                  />
                </section>
              </div>
            </>
          )}
          {route && (
            <>
              {route.condition && (
                <>
                  <h4>{t("workingDossier.routeCondition")}</h4>
                  <p className="questionnaire-text">{route.condition}</p>
                </>
              )}
              {route.maxVisits !== undefined && (
                <p>
                  {format("workingDossier.visitLimit", {
                    count: route.maxVisits,
                  })}
                </p>
              )}
            </>
          )}
          <DossierFieldList fields={fields} context={context} />
        </section>
      </div>
      {Object.keys(content.findings).length > 0 && (
        <section aria-label={t("workingDossier.findings")}>
          <h3>{t("workingDossier.findings")}</h3>
          <div className="working-dossier-field-list">
            {Object.entries(content.findings).map(([id, finding]) => (
              <article className="working-dossier-field" key={id}>
                <p className="questionnaire-text">{finding.consequence}</p>
                {projection.staleFindings.includes(id) && (
                  <Tag color="warning">{t("ledger.state.stale")}</Tag>
                )}
                <ul className="working-dossier-links">
                  {finding.fields.map((id) => {
                    const field = projection.fields.find(
                      (field) => field.id === id,
                    );
                    return (
                      <li key={id}>
                        {field ? `${field.ownerLabel} · ${field.label}` : id}
                      </li>
                    );
                  })}
                </ul>
                <DossierEvidenceLinks
                  evidence={finding.evidence}
                  context={context}
                />
              </article>
            ))}
          </div>
        </section>
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
