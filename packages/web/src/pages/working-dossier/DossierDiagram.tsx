import { Space } from "antd";
import { useId } from "react";
import type {
  DossierOccurrence,
  WorkingDossierContent,
} from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";
import { handoffLabel, routeLabel } from "./DossierFields.js";

const CARD_WIDTH = 184;
const CARD_HEIGHT = 60;
const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 110;
const MARGIN = 20;

interface DiagramNode {
  id: string;
  node: DossierOccurrence;
  x: number;
  y: number;
}

function arrangeNodes(content: WorkingDossierContent) {
  const occurrences = Object.entries(content.nodes).sort(
    ([firstId, first], [secondId, second]) =>
      first.order - second.order || firstId.localeCompare(secondId),
  );
  const incoming = new Map<string, string[]>();
  const routes = Object.values(content.routes ?? {});
  const connections = routes.length
    ? routes.filter((route) => route.kind !== "rework")
    : Object.values(content.interfaces).map(({ producer, consumer }) => ({
        from: producer,
        to: consumer,
      }));
  for (const { from, to } of connections) {
    const parents = incoming.get(to) ?? [];
    parents.push(from);
    incoming.set(to, parents);
  }
  const levels = new Map<string, number>();
  const lanes = new Map<number, number>();
  return occurrences.map(([id, node]): DiagramNode => {
    const previous = [
      ...(incoming.get(id) ?? []),
      ...(node.parent ? [node.parent] : []),
    ];
    const level = Math.max(
      0,
      ...previous.map((parent) => (levels.get(parent) ?? -1) + 1),
    );
    const lane = lanes.get(level) ?? 0;
    levels.set(id, level);
    lanes.set(level, lane + 1);
    return {
      id,
      node,
      x: MARGIN + lane * COLUMN_WIDTH,
      y: MARGIN + level * ROW_HEIGHT,
    };
  });
}

function edgePath(
  from: DiagramNode,
  to: DiagramNode,
  offset = 0,
  loop = false,
) {
  const start = from.x + CARD_WIDTH / 2 + offset;
  const end = to.x + CARD_WIDTH / 2 + offset;
  if (!loop && from.y < to.y) {
    const bottom = from.y + CARD_HEIGHT;
    const middle = bottom + (to.y - bottom) / 2;
    return `M ${start} ${bottom} C ${start} ${middle}, ${end} ${middle}, ${end} ${to.y}`;
  }
  const side = Math.max(from.x, to.x) + CARD_WIDTH + 22 + offset;
  const startY = from.y + CARD_HEIGHT * 0.7 + offset / 3;
  const endY = to.y + CARD_HEIGHT * 0.3 + offset / 3;
  return `M ${from.x + CARD_WIDTH} ${startY} H ${side} V ${endY} H ${to.x + CARD_WIDTH}`;
}

export type DossierSelection = {
  kind: "workflow" | "skill" | "node" | "interface" | "route";
  id: string;
};

export function DossierDiagram({
  content,
  selection,
  onSelect,
  inspectorId,
}: {
  content: WorkingDossierContent;
  selection: DossierSelection;
  onSelect(selection: DossierSelection): void;
  inspectorId: string;
}) {
  const { t, format } = useI18n();
  const marker = useId();
  const nodes = arrangeNodes(content);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = Object.entries(content.interfaces);
  const routes = Object.entries(content.routes ?? {});
  const width =
    Math.max(0, ...nodes.map((node) => node.x)) + CARD_WIDTH + MARGIN * 3;
  const height =
    Math.max(0, ...nodes.map((node) => node.y)) + CARD_HEIGHT + MARGIN;
  const links = edges.flatMap(([id, edge]) => {
    const from = byId.get(edge.producer);
    const to = byId.get(edge.consumer);
    return from && to
      ? [
          {
            id,
            kind: "interface" as const,
            variant: edge.status,
            path: edgePath(from, to, routes.length ? -11 : 0),
          },
        ]
      : [];
  });
  const routeLinks = routes.flatMap(([id, route]) => {
    const from = byId.get(route.from);
    const to = byId.get(route.to);
    return from && to
      ? [
          {
            id,
            kind: "route" as const,
            variant: route.kind,
            path: edgePath(from, to, 11, route.kind === "rework"),
          },
        ]
      : [];
  });

  return (
    <section
      className="working-dossier-diagram"
      aria-label={t("workingDossier.diagram")}
    >
      <h3>{t("workingDossier.diagram")}</h3>
      {nodes.length ? (
        <div
          className="working-dossier-diagram-canvas"
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
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke" />
                </marker>
              </defs>
              {nodes.map(({ id, node, x, y }) => {
                const parent = node.parent ? byId.get(node.parent) : undefined;
                return (
                  parent && (
                    <path
                      key={id}
                      d={edgePath(parent, { id, node, x, y })}
                      className="working-dossier-parent-edge"
                    />
                  )
                );
              })}
              {[...links, ...routeLinks].map(({ id, kind, variant, path }) => (
                <g key={`${kind}/${id}`}>
                  <path
                    className="working-dossier-edge"
                    data-selected={
                      selection.kind === kind && selection.id === id
                    }
                    data-variant={variant}
                    d={path}
                    markerEnd={`url(#${marker})`}
                  />
                  <path
                    className="working-dossier-edge-target"
                    d={path}
                    onClick={() => onSelect({ kind, id })}
                  />
                </g>
              ))}
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
                  minHeight: CARD_HEIGHT,
                }}
                aria-label={node.label}
                aria-pressed={selection.kind === "node" && selection.id === id}
                aria-controls={inspectorId}
                title={node.label}
                onClick={() => onSelect({ kind: "node", id })}
              >
                <span>{node.label}</span>
                <small>{t(`workingDossier.kind.${node.kind}`)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">{t("workingDossier.noOccurrences")}</p>
      )}
      {edges.length > 0 && (
        <ul
          className="working-dossier-handoff-list"
          aria-label={t("workingDossier.handoffs")}
        >
          {edges.map(([id, edge]) => (
            <li key={id}>
              <Space wrap>
                <button
                  type="button"
                  className="working-dossier-selection"
                  aria-pressed={
                    selection.kind === "interface" && selection.id === id
                  }
                  aria-controls={inspectorId}
                  onClick={() => onSelect({ kind: "interface", id })}
                >
                  {handoffLabel(content, edge.producer, edge.consumer)}
                </button>
                <span className="muted">
                  {t(`workingDossier.interface.${edge.status}`)}
                </span>
              </Space>
            </li>
          ))}
        </ul>
      )}
      {routes.length > 0 && (
        <div aria-label={t("questionnaire.topic.routes")}>
          <h4>{t("questionnaire.topic.routes")}</h4>
          <ul className="working-dossier-handoff-list">
            {routes.map(([id, route]) => (
              <li key={id}>
                <button
                  type="button"
                  className="working-dossier-selection working-dossier-route-selection"
                  data-variant={route.kind}
                  aria-controls={inspectorId}
                  aria-pressed={
                    selection.kind === "route" && selection.id === id
                  }
                  onClick={() => onSelect({ kind: "route", id })}
                >
                  {routeLabel(content, route, t, format)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
