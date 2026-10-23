import {
  cmp,
  type FlowView,
  type Legend,
  type SequenceView,
  type View,
  type ViewNode,
} from "./views.js";

/** Words Mermaid reads as syntax; an id equal to one of them gets a trailing underscore. */
const RESERVED = new Set([
  "end",
  "graph",
  "subgraph",
  "flowchart",
  "class",
  "classdef",
  "style",
  "linkstyle",
  "click",
  "direction",
  "default",
  "participant",
  "actor",
  "note",
  "loop",
  "alt",
  "else",
  "opt",
  "par",
  "and",
  "rect",
  "critical",
  "break",
  "box",
  "autonumber",
  "activate",
  "deactivate",
]);

const LEGEND_NODES: [Legend, string, string][] = [
  ["new", "legend_new", "+ New"],
  ["modify", "legend_modify", "◇ Modify"],
  ["retire", "legend_retire", "✕ Retire"],
];

/** Mermaid ids: record ids made safe (letters, digits, _), unique, and stable for a view. */
class Ids {
  private used = new Set<string>(["legend", ...LEGEND_NODES.map((l) => l[1])]);
  private map = new Map<string, string>();
  get(key: string, raw: string): string {
    const known = this.map.get(key);
    if (known) return known;
    let base = raw.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z]/.test(base)) base = `n_${base}`;
    if (RESERVED.has(base.toLowerCase())) base = `${base}_`;
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}_${n}`;
    this.used.add(id);
    this.map.set(key, id);
    return id;
  }
}

const esc = (s: string) => s.replace(/"/g, "#quot;");
const HEADER = "Generated from the catalog by Atticus: change the catalog, not this file.";
const header = (v: View & { source?: string }) =>
  `%% ${v.title}. ${v.source ? `Rendered by Atticus from ${v.source}.` : HEADER}`;

const CLASS_DEFS: [string, string][] = [
  ["product", "fill:#dae8fc,stroke:#6c8ebf"],
  ["internal", "fill:#d5e8d4,stroke:#82b366"],
  ["vendor", "fill:#f5f5f5,stroke:#666666,stroke-dasharray:5 5"],
  ["plannedNew", "stroke:#2e7d32,stroke-width:3px,stroke-dasharray:6 3"],
  ["plannedModify", "stroke:#ed6c02,stroke-width:3px"],
  ["plannedRetire", "stroke:#b71c1c,stroke-width:3px,stroke-dasharray:2 2"],
];
const LEGEND_CLASS: Record<Legend, string> = {
  new: "plannedNew",
  modify: "plannedModify",
  retire: "plannedRetire",
};
const LINK_STYLE: Record<Legend, string> = {
  new: "stroke:#2e7d32,stroke-width:2px,stroke-dasharray:6 3",
  modify: "stroke:#ed6c02,stroke-width:2px",
  retire: "stroke:#b71c1c,stroke-width:2px,stroke-dasharray:2 2",
};

function shape(n: ViewNode, id: string): string {
  const l = esc(n.label);
  if (n.kind === "table") return `${id}[("${l}")]`;
  if (n.kind === "topic") return `${id}>"${l}"]`;
  return `${id}["${l}"]`;
}

function flow(v: FlowView): string {
  const ids = new Ids();
  const gid = (id: string) => ids.get(`g:${id}`, id);
  const nid = (id: string) => ids.get(`n:${id}`, id);
  const lines = [header(v), "flowchart LR"];
  const classes = new Map<string, Set<string>>(CLASS_DEFS.map(([c]) => [c, new Set<string>()]));
  const tag = (id: string, x: { boundary?: string; legend?: Legend }) => {
    if (x.boundary) classes.get(x.boundary)?.add(id);
    if (x.legend) classes.get(LEGEND_CLASS[x.legend])!.add(id);
  };
  for (const g of v.groups) {
    const id = gid(g.id);
    tag(id, g);
    lines.push(`  subgraph ${id}["${esc(g.label)}"]`);
    for (const n of v.nodes.filter((x) => x.group === g.id)) {
      lines.push(`    ${shape(n, nid(n.id))}`);
      tag(nid(n.id), n);
    }
    lines.push("  end");
  }
  const grouped = new Set(v.groups.map((g) => g.id));
  for (const n of v.nodes.filter((x) => x.group === undefined || !grouped.has(x.group))) {
    lines.push(`  ${shape(n, nid(n.id))}`);
    tag(nid(n.id), n);
  }
  const links: Record<Legend, number[]> = { new: [], modify: [], retire: [] };
  v.edges.forEach((e, i) => {
    const label = e.label ? `|"${esc(e.label)}"|` : "";
    lines.push(`  ${nid(e.from)} ${e.async ? "-.->" : "-->"}${label} ${nid(e.to)}`);
    if (e.legend) links[e.legend].push(i);
  });
  const planned = [...v.groups, ...v.nodes, ...v.edges].some((x) => x.legend);
  if (planned) {
    lines.push('  subgraph legend["Legend"]');
    for (const [legend, id, text] of LEGEND_NODES) {
      lines.push(`    ${id}["${text}"]`);
      classes.get(LEGEND_CLASS[legend])!.add(id);
    }
    lines.push("  end");
  }
  for (const [c, def] of CLASS_DEFS)
    if (classes.get(c)!.size > 0) lines.push(`  classDef ${c} ${def}`);
  for (const [c] of CLASS_DEFS) {
    const members = [...classes.get(c)!].sort(cmp);
    if (members.length > 0) lines.push(`  class ${members.join(",")} ${c}`);
  }
  for (const legend of ["new", "modify", "retire"] as const)
    if (links[legend].length > 0)
      lines.push(`  linkStyle ${links[legend].join(",")} ${LINK_STYLE[legend]}`);
  return `${lines.join("\n")}\n`;
}

/** Mermaid sequence text can't hold ";" or a newline. */
const seqText = (s: string) => s.replace(/;/g, "#59;").replace(/\s+/g, " ");
const suffix = (legend?: Legend) => (legend ? ` (${legend})` : "");

function sequence(v: SequenceView): string {
  const ids = new Ids();
  const pid = (id: string) => ids.get(`p:${id}`, id);
  const lines = [header(v), "sequenceDiagram"];
  for (const p of v.participants)
    lines.push(`  participant ${pid(p.id)} as ${seqText(p.label + suffix(p.legend))}`);
  for (const s of v.steps)
    lines.push(
      s.kind === "message"
        ? `  ${pid(s.from)}${s.async ? "-)" : "->>"}${pid(s.to)}: ${seqText(s.label + suffix(s.legend))}`
        : `  Note over ${pid(s.over[0])},${pid(s.over[1])}: ${seqText(s.text)}`,
    );
  return `${lines.join("\n")}\n`;
}

/** Render a view as Mermaid text. The same view always gives the same text. */
export function toMermaid(view: View): string {
  return view.type === "sequence" ? sequence(view) : flow(view);
}
