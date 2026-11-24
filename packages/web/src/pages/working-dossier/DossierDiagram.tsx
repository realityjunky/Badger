import { useId } from "react";
import type {
  DossierInterface,
  DossierOccurrence,
  DossierRoute,
  WorkingDossierContent,
} from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";
import { handoffLabel, routeLabel } from "./DossierFields.js";

const CARD_WIDTH = 200;
const CARD_HEIGHT = 68;
const COLUMN_WIDTH = 272;
const ROW_HEIGHT = 100;
const MARGIN = 24;

type EdgeKind = "interface" | "route";

export type DossierSelection = {
  kind: EdgeKind | "node" | "skill" | "finding";
  id: string;
};

export type DossierHighlights = Record<EdgeKind | "node", Set<string>>;

interface DiagramNode {
  id: string;
  node: DossierOccurrence;
  x: number;
  y: number;
}

interface DiagramEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  variant: DossierInterface["status"] | DossierRoute["kind"];
  label: string;
}

function arrangeNodes(content: WorkingDossierContent): DiagramNode[] {
  const ordered = Object.entries(content.nodes).sort(
    ([firstId, first], [secondId, second]) =>
      first.order - second.order || firstId.localeCompare(secondId),
  );
  const columns: typeof ordered = [];
  const calls = new Map<string, typeof ordered>();
  for (const entry of ordered) {
    const parent = entry[1].parent;
    if (parent && Object.hasOwn(content.nodes, parent)) {
      const children = calls.get(parent) ?? [];
      children.push(entry);
      calls.set(parent, children);
    } else {
      columns.push(entry);
    }
  }
  return columns.flatMap((main, columnIndex) => {
    return [main, ...(calls.get(main[0]) ?? [])].map(([id, node], row) => ({
      id,
      node,
      x: MARGIN + columnIndex * COLUMN_WIDTH,
      y: MARGIN + row * ROW_HEIGHT,
    }));
  });
}

function edgePath(
  from: DiagramNode,
  to: DiagramNode,
  offset: number,
  detourY?: number,
) {
  const startX = from.x + CARD_WIDTH;
  const startY = from.y + CARD_HEIGHT / 2 + offset;
  const endY = to.y + CARD_HEIGHT / 2 + offset;
  if (from.x === to.x) {
    const side = startX + 22 + offset / 2;
    const end = from === to ? endY - 20 : endY;
    return `M ${startX} ${startY} H ${side} V ${end} H ${startX + 2}`;
  }
  const endX = to.x - 2;
  if (detourY !== undefined) {
    const exit = startX + 16 + offset / 3;
    const entry = endX - 16 + offset / 3;
    return `M ${startX} ${startY} H ${exit} V ${detourY} H ${entry} V ${endY} H ${endX}`;
  }
  const middle = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`;
}

function placeEdges(
  edges: DiagramEdge[],
  byId: Map<string, DiagramNode>,
  bottom: number,
) {
  // Give routes and handoffs between the same boxes separate ports.
  const bundles = new Map<string, DiagramEdge[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.from, edge.to].sort());
    const bundle = bundles.get(key) ?? [];
    bundle.push(edge);
    bundles.set(key, bundle);
  }
  let lowest = bottom;
  const paths = [...bundles.values()].flatMap((bundle) => {
    const spacing = Math.min(24, 40 / Math.max(1, bundle.length - 1));
    return bundle.flatMap((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];
      const offset = (index - (bundle.length - 1) / 2) * spacing;
      const distance = to.x - from.x;
      const detour =
        distance !== 0 &&
        (distance !== COLUMN_WIDTH || edge.variant === "rework");
      return [
        {
          ...edge,
          path: edgePath(from, to, offset, detour ? (lowest += 22) : undefined),
          hitWidth: Math.min(20, spacing),
        },
      ];
    });
  });
  return { paths, height: lowest + MARGIN };
}

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
  const marker = useId();
  const nodes = arrangeNodes(content);
  const byId = new Map(nodes.map((node) => [node.id, node]));
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
  const width =
    Math.max(0, ...nodes.map((node) => node.x)) + CARD_WIDTH + MARGIN * 2;
  const bottom = Math.max(0, ...nodes.map((node) => node.y)) + CARD_HEIGHT;
  const { paths, height } = placeEdges(edges, byId, bottom);
  const isFocused =
    highlights.node.size > 0 ||
    highlights.interface.size > 0 ||
    highlights.route.size > 0;
  const legend = [
    ["documented", t("workingDossier.interface.documented")],
    ["proposed", t("workingDossier.interface.proposed")],
    ["next", t("workingDossier.route.next")],
    ["optional", t("workingDossier.route.optional")],
    ["rework", t("workingDossier.route.rework")],
    ["parent", t("workingDossier.parentNode")],
  ].filter(([variant]) =>
    variant === "parent"
      ? nodes.some(({ node }) => node.parent)
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
                {nodes.map(({ id, node, x, y }) => {
                  const parent = node.parent
                    ? byId.get(node.parent)
                    : undefined;
                  return (
                    parent && (
                      <path
                        key={id}
                        d={`M ${parent.x} ${parent.y + CARD_HEIGHT / 2} H ${x - 12} V ${y + CARD_HEIGHT / 2} H ${x}`}
                        className="working-dossier-edge"
                        data-variant="parent"
                      />
                    )
                  );
                })}
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
                  style={{
                    left: x,
                    top: y,
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
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
                  <small>{t(`workingDossier.kind.${node.kind}`)}</small>
                </button>
              ))}
            </div>
          </div>
          {legend.length > 0 && (
            <ul className="working-dossier-legend">
              {legend.map(([variant, label]) => (
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
          )}
        </>
      ) : (
        <p className="muted">{t("workingDossier.noOccurrences")}</p>
      )}
    </section>
  );
}
