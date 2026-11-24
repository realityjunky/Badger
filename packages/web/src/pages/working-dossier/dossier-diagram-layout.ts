import type {
  DossierInterface,
  DossierOccurrence,
  DossierRoute,
  WorkingDossierContent,
} from "@realityjunky/badger";

export const NODE_WIDTH = 132;
const COLUMN_GAP = 56;
const ROW_GAP = 30;
const MARGIN = 22;
const TRACK_GAP = 22;

export type EdgeKind = "interface" | "route";

export interface DiagramEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  variant: DossierInterface["status"] | DossierRoute["kind"];
  label: string;
}

interface Point {
  x: number;
  y: number;
}

interface DiagramNode extends Point {
  id: string;
  node: DossierOccurrence;
  column: number;
  row: number;
}

type Side = "left" | "right" | "top";

interface Port {
  node: DiagramNode;
  side: Side;
  order: number;
  offset: number;
  spacing: number;
}

function arrangeNodes(nodes: WorkingDossierContent["nodes"], height: number) {
  const ordered = Object.entries(nodes).sort(
    ([firstId, first], [secondId, second]) =>
      first.order - second.order || firstId.localeCompare(secondId),
  );
  const roots: typeof ordered = [];
  const calls = new Map<string, typeof ordered>();
  for (const entry of ordered) {
    const parent = entry[1].parent;
    if (
      parent &&
      Object.hasOwn(nodes, parent) &&
      nodes[parent].kind === "node"
    ) {
      const children = calls.get(parent) ?? [];
      children.push(entry);
      calls.set(parent, children);
    } else {
      roots.push(entry);
    }
  }
  return roots.map((root, column) =>
    [root, ...(calls.get(root[0]) ?? [])].map(([id, node], row) => ({
      id,
      node,
      column,
      row,
      x: MARGIN + column * (NODE_WIDTH + COLUMN_GAP),
      y: MARGIN + row * (height + ROW_GAP),
    })),
  );
}

function portPoint(port: Port, height: number, gap = 0): Point {
  const { node, side, offset } = port;
  if (side === "top") {
    return { x: node.x + NODE_WIDTH / 2 + offset, y: node.y - gap };
  }

  const radius = height / 2;
  const inset =
    node.node.kind === "required-skill-call"
      ? radius - Math.sqrt(radius ** 2 - offset ** 2)
      : 0;
  return {
    x: node.x + (side === "left" ? inset - gap : NODE_WIDTH - inset + gap),
    y: node.y + radius + offset,
  };
}

function roundedPath(points: Point[]) {
  const [start, ...turns] = points;
  return turns.reduce((path, turn, index) => {
    const next = turns[index + 1];
    if (!next) return `${path} L ${turn.x} ${turn.y}`;
    const previous = turns[index - 1] ?? start;
    const incoming = Math.hypot(turn.x - previous.x, turn.y - previous.y);
    const outgoing = Math.hypot(turn.x - next.x, turn.y - next.y);
    const radius = Math.min(14, incoming / 2, outgoing / 2);
    const beforeX = turn.x + ((previous.x - turn.x) * radius) / incoming;
    const beforeY = turn.y + ((previous.y - turn.y) * radius) / incoming;
    const afterX = turn.x + ((next.x - turn.x) * radius) / outgoing;
    const afterY = turn.y + ((next.y - turn.y) * radius) / outgoing;
    return `${path} L ${beforeX} ${beforeY} Q ${turn.x} ${turn.y} ${afterX} ${afterY}`;
  }, `M ${start.x} ${start.y}`);
}

function trackEntry(
  port: Port,
  point: Point,
  trackY: number,
  nodeHeight: number,
): Point[] {
  if (port.side === "top") return [{ x: point.x, y: trackY }];
  const offset = 20 + (8 * port.offset) / (nodeHeight - 34);
  const x =
    port.node.x + (port.side === "right" ? NODE_WIDTH + offset : -offset);
  return [
    { x, y: point.y },
    { x, y: trackY },
  ];
}

function parentPath([parent, ...calls]: DiagramNode[], height: number) {
  const last = calls.at(-1);
  if (!last) return [];
  const rail = parent.x - 12;
  const start = parent.y + height / 2 + 15;
  const branches = calls.map(({ x, y }) => {
    const end = y + height / 2 + 15;
    return `M ${rail} ${end - 9} Q ${rail} ${end} ${x + 4} ${end}`;
  });
  return [
    `M ${parent.x} ${start} Q ${rail} ${start} ${rail} ${start + 10} V ${last.y + height / 2 + 6} ${branches.join(" ")}`,
  ];
}

export function layoutDossierDiagram(
  content: WorkingDossierContent,
  edges: DiagramEdge[],
  nodeHeight: number,
) {
  const columns = arrangeNodes(content.nodes, nodeHeight);
  const nodes = columns.flat();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ports = new Map<string, Port[]>();
  const tracks: { left: number; right: number }[][] = [];
  const loops = new Map<number, number>();

  function addPort(
    node: DiagramNode,
    side: Side,
    other: DiagramNode,
    track: number,
  ): Port {
    const key = `${side}/${node.id}`;
    const group = ports.get(key) ?? [];
    const port = {
      node,
      side,
      order:
        side === "top"
          ? Math.sign(other.column - node.column) / (track + 1)
          : other.row,
      offset: 0,
      spacing: 16,
    };
    group.push(port);
    ports.set(key, group);
    return port;
  }

  const connections = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];

    const distance = to.column - from.column;
    const bypass =
      distance !== 0 && (distance !== 1 || edge.variant === "rework");
    let track = -1;
    if (bypass) {
      const left = Math.min(from.column, to.column);
      const right = Math.max(from.column, to.column);
      track = tracks.findIndex((spans) =>
        spans.every((span) => right < span.left || left > span.right),
      );
      if (track < 0) track = tracks.push([]) - 1;
      tracks[track].push({ left, right });
    }

    const loop = distance === 0 ? (loops.get(from.column) ?? 0) : undefined;
    if (loop !== undefined) loops.set(from.column, loop + 1);
    const startSide = distance < 0 ? "left" : "right";
    const endSide = distance <= 0 ? "right" : "left";
    return [
      {
        edge,
        track,
        loop,
        start: addPort(
          from,
          bypass && from.row === 0 ? "top" : startSide,
          to,
          track,
        ),
        end: addPort(to, bypass && to.row === 0 ? "top" : endSide, from, track),
      },
    ];
  });

  for (const group of ports.values()) {
    group.sort((first, second) => first.order - second.order);
    const span = group[0].side === "top" ? NODE_WIDTH - 36 : nodeHeight - 34;
    const spacing = Math.min(16, span / Math.max(1, group.length - 1));
    group.forEach((port, index) => {
      port.offset = (index - (group.length - 1) / 2) * spacing;
      port.spacing = spacing;
    });
  }

  const top = tracks.length * TRACK_GAP;
  for (const node of nodes) node.y += top;

  const paths = connections.map(({ edge, start, end, track, loop }) => {
    const source = portPoint(start, nodeHeight);
    const target = portPoint(end, nodeHeight, 2);
    let path: string;
    if (track >= 0) {
      const trackY = MARGIN + (tracks.length - 1 - track) * TRACK_GAP;
      path = roundedPath([
        source,
        ...trackEntry(start, source, trackY, nodeHeight),
        ...trackEntry(end, target, trackY, nodeHeight).reverse(),
        target,
      ]);
    } else if (loop !== undefined) {
      const count = loops.get(start.node.column) ?? 1;
      const reach =
        start.node.x + NODE_WIDTH + 26 + (loop * 18) / Math.max(1, count - 1);
      path = `M ${source.x} ${source.y} C ${reach} ${source.y} ${reach} ${target.y} ${target.x} ${target.y}`;
    } else {
      const curve = (target.x - source.x) / 2;
      path = `M ${source.x} ${source.y} C ${source.x + curve} ${source.y} ${target.x - curve} ${target.y} ${target.x} ${target.y}`;
    }
    return { ...edge, path, hitWidth: Math.min(start.spacing, end.spacing) };
  });

  const lastColumn = columns.length - 1;
  return {
    nodes,
    paths,
    parentPaths: columns.flatMap((column) => parentPath(column, nodeHeight)),
    width:
      Math.max(0, columns.length * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP) +
      2 * MARGIN +
      (loops.has(lastColumn) ? COLUMN_GAP / 2 : 0),
    height: Math.max(0, ...nodes.map(({ y }) => y)) + nodeHeight + MARGIN,
  };
}
