import { useMemo } from "react";

export interface Graph {
  nodes: { id: string; kind: string; label: string; status: string; system?: string }[];
  edges: {
    id: string;
    from: string;
    to: string;
    via: string;
    confidence: string;
    status: string;
  }[];
}

/**
 * A deterministic layout (the same catalog draws the same map): systems on a ring, their
 * components around them; a focus, when given, sits in the middle with its neighbours on a ring.
 */
function layout(g: Graph, w: number, h: number, focus?: string) {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = w / 2;
  const cy = h / 2;
  if (focus && g.nodes.some((n) => n.id === focus)) {
    pos.set(focus, { x: cx, y: cy });
    const others = g.nodes.filter((n) => n.id !== focus);
    others.forEach((n, i) => {
      const a = (i / Math.max(others.length, 1)) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.id, { x: cx + Math.cos(a) * w * 0.36, y: cy + Math.sin(a) * h * 0.36 });
    });
    return pos;
  }
  const systems = [...new Set(g.nodes.map((n) => n.system ?? n.id))].sort();
  systems.forEach((s, i) => {
    const a = (i / Math.max(systems.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const sx = cx + Math.cos(a) * (w * 0.33);
    const sy = cy + Math.sin(a) * (h * 0.33);
    const members = g.nodes.filter((n) => (n.system ?? n.id) === s);
    members.forEach((n, j) => {
      const b = (j / Math.max(members.length, 1)) * Math.PI * 2;
      const r = members.length > 1 ? 30 + members.length * 4 : 0;
      pos.set(n.id, { x: sx + Math.cos(b) * r, y: sy + Math.sin(b) * r * 0.7 });
    });
  });
  return pos;
}

export function GraphView({
  g,
  focus,
  highlight = [],
  onPick,
  height = 430,
}: {
  g: Graph;
  focus?: string;
  highlight?: string[];
  onPick?: (id: string) => void;
  height?: number;
}) {
  const W = 820;
  const H = height;
  const pos = useMemo(() => layout(g, W, H, focus), [g, H, focus]);
  const hot = new Set([...(focus ? [focus] : []), ...highlight]);
  const labelled = new Set(
    g.nodes
      .filter((n) => hot.has(n.id) || n.kind === "Component" || g.nodes.length < 30)
      .map((n) => n.id),
  );
  return (
    <svg
      role="img"
      aria-label={`Graph: ${g.nodes.length} systems and components, ${g.edges.length} interfaces${focus ? `, centred on ${focus}` : ""}.`}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "100%", minHeight: Math.min(H, 360), display: "block" }}
    >
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g strokeWidth={0.9}>
        {g.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const lit = hot.has(e.from) || hot.has(e.to);
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={lit ? "#7FF4FF" : "#2EE6F6"}
              opacity={lit ? 0.95 : 0.35}
              strokeDasharray={e.confidence !== "verified" ? "4 4" : undefined}
              filter={lit ? "url(#glow)" : undefined}
            />
          );
        })}
      </g>
      {g.nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const lit = hot.has(n.id);
        return (
          <g key={n.id}>
            <circle
              cx={p.x}
              cy={p.y}
              r={lit ? 6 : n.kind === "System" ? 4 : 2.6}
              fill={lit ? "#2EE6F6" : "#BFFAFF"}
              filter="url(#glow)"
            />
            {onPick && (
              <circle
                cx={p.x}
                cy={p.y}
                r={12}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onClick={() => onPick(n.id)}
                aria-hidden="true"
              />
            )}
            {labelled.has(n.id) && (
              <text
                x={p.x + 8}
                y={p.y - 7}
                fontFamily="JetBrains Mono, monospace"
                fontSize={lit ? 12 : 10.5}
                fill={lit ? "#E9F6FA" : "#BFEFF7"}
              >
                {n.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
