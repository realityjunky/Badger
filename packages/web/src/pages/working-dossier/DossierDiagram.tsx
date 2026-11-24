import { useId } from "react";
import type {
  DossierOccurrence,
  WorkingDossierContent,
} from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";
import { usePreferences } from "../../preferences/PreferencesContext.js";
import { fontScaleFactor, typeScale } from "../../theme/tokens.js";
import {
  layoutDossierDiagram,
  NODE_WIDTH,
  type DiagramEdge,
  type EdgeKind,
} from "./dossier-diagram-layout.js";
import { handoffLabel, routeLabel } from "./DossierFields.js";

export type DossierSelection = {
  kind: EdgeKind | "node" | "skill" | "finding";
  id: string;
};

export type DossierHighlights = Record<EdgeKind | "node", Set<string>>;

const occurrenceKinds: DossierOccurrence["kind"][] = [
  "node",
  "required-skill-call",
];

export function DossierDiagram({
  content,
  selection,
  highlights,
  edgeView,
  onSelect,
  inspectorId,
}: {
  content: WorkingDossierContent;
  selection?: DossierSelection;
  highlights: DossierHighlights;
  edgeView?: EdgeKind;
  onSelect(selection: DossierSelection): void;
  inspectorId: string;
}) {
  const { t, format } = useI18n();
  const { preferences } = usePreferences();
  const marker = useId();
  const edges: DiagramEdge[] = [
    ...Object.entries(content.interfaces).map(([id, edge]) => ({
      id,
      kind: "interface" as const,
      from: edge.producer,
      to: edge.consumer,
      variant: edge.status,
      label: `${handoffLabel(content, edge.producer, edge.consumer)} · ${t(`workingDossier.interface.${edge.status}`)}`,
    })),
    ...Object.entries(content.routes ?? {}).map(([id, route]) => ({
      id,
      kind: "route" as const,
      from: route.from,
      to: route.to,
      variant: route.kind,
      label: routeLabel(content, route, t, format),
    })),
  ];
  const nodeHeight = Math.ceil(
    18 + 3 * 1.25 * typeScale.base * fontScaleFactor(preferences.fontScale),
  );
  const { nodes, paths, parentPaths, width, height } = layoutDossierDiagram(
    content,
    edges,
    nodeHeight,
  );
  const isFocused =
    highlights.node.size > 0 ||
    highlights.interface.size > 0 ||
    highlights.route.size > 0;
  const edgeLegend = [
    ["documented", t("workingDossier.interface.documented")],
    ["proposed", t("workingDossier.interface.proposed")],
    ["next", t("workingDossier.route.next")],
    ["optional", t("workingDossier.route.optional")],
    ["rework", t("workingDossier.route.rework")],
    ["parent", t("workingDossier.parentNode")],
  ].filter(([variant]) =>
    variant === "parent"
      ? parentPaths.length > 0
      : paths.some((edge) => edge.variant === variant),
  );

  return (
    <section
      className="working-dossier-diagram"
      aria-label={t("workingDossier.diagram")}
    >
      <h3>{t("workingDossier.diagram")}</h3>
      {nodes.length ? (
        <>
          <div
            className="working-dossier-diagram-canvas"
            role="group"
            tabIndex={0}
            aria-label={t("workingDossier.occurrences")}
          >
            <div
              className="working-dossier-diagram-layout"
              style={{ width, height }}
            >
              <svg width={width} height={height} aria-hidden="true">
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke" />
                  </marker>
                </defs>
                {parentPaths.map((path) => (
                  <path
                    key={path}
                    d={path}
                    className="working-dossier-edge"
                    data-variant="parent"
                  />
                ))}
                {paths.map(({ id, kind, variant, label, path, hitWidth }) => {
                  const highlighted = highlights[kind].has(id);
                  return (
                    <g key={`${kind}/${id}`}>
                      <title>{label}</title>
                      <path
                        className="working-dossier-edge"
                        data-highlighted={highlighted}
                        data-muted={
                          !highlighted &&
                          (isFocused || (edgeView && edgeView !== kind))
                            ? true
                            : undefined
                        }
                        data-variant={variant}
                        d={path}
                        markerEnd={`url(#${marker})`}
                      />
                      <path
                        className="working-dossier-edge-target"
                        d={path}
                        strokeWidth={hitWidth}
                        onClick={() => onSelect({ kind, id })}
                      />
                    </g>
                  );
                })}
              </svg>
              {nodes.map(({ id, node, x, y }) => (
                <button
                  key={id}
                  type="button"
                  className="working-dossier-node"
                  data-kind={node.kind}
                  style={{
                    left: x,
                    top: y,
                    width: NODE_WIDTH,
                    height: nodeHeight,
                  }}
                  aria-label={node.label}
                  aria-description={t(`workingDossier.kind.${node.kind}`)}
                  aria-pressed={
                    selection?.kind === "node" && selection.id === id
                  }
                  aria-controls={inspectorId}
                  data-highlighted={highlights.node.has(id)}
                  title={node.label}
                  onClick={() => onSelect({ kind: "node", id })}
                >
                  <span>{node.label}</span>
                </button>
              ))}
            </div>
          </div>
          <ul className="working-dossier-legend">
            {occurrenceKinds
              .filter((kind) => nodes.some(({ node }) => node.kind === kind))
              .map((kind) => (
                <li key={kind}>
                  <span
                    className="working-dossier-node-swatch"
                    data-kind={kind}
                    aria-hidden="true"
                  />
                  {t(`workingDossier.kind.${kind}`)}
                </li>
              ))}
            {edgeLegend.map(([variant, label]) => (
              <li key={variant}>
                <svg width="28" height="8" aria-hidden="true">
                  <path
                    className="working-dossier-edge"
                    data-variant={variant}
                    d="M 1 4 H 27"
                  />
                </svg>
                {label}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">{t("workingDossier.noOccurrences")}</p>
      )}
    </section>
  );
}
