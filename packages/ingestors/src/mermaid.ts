import { labelText, type Diagram, type LegendWords } from "@maycombhq/reconcile";
import { DEFAULT_LEGEND, edgeParts, legendOf, legendWord } from "./labels.js";

/*
 * Mermaid flowcharts ("flowchart" or "graph"), the diagrams teams keep as code: a .mmd file,
 * or ```mermaid blocks in Markdown. Nodes become boxes (label from the shape text, or the id),
 * links become edges with their text read like a draw.io label. Legend comes from a class
 * named like a legend word (":::new", "class a,b new"; edges by id, "class e7 new") or a
 * bracketed marker in the text. Edges without an id are numbered e1, e2, ... in order.
 * "click" lines are ignored: a diagram's links are never opened.
 */

interface Block {
  lines: string[];
  /** Line number of lines[0] in the file. */
  first: number;
  page: string;
}

const SHAPES: [open: string, close: string, shape: string][] = [
  ["(((", ")))", "double-circle"],
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "parallelogram"],
  ["[/", "\\]", "trapezoid"],
  ["[\\", "\\]", "parallelogram-alt"],
  ["[\\", "/]", "trapezoid-alt"],
  [">", "]", "asymmetric"],
  ["[", "]", "rect"],
  ["(", ")", "rounded"],
  ["{", "}", "diamond"],
];

/** A link with no text in the middle, then an optional |text|. */
const LINK =
  /^(?:<|o|x)?(?:-{2,}>|-{2,}[ox](?![\w])|-{3,}|={2,}>|={2,}[ox](?![\w])|={3,}|-\.+->|-\.+-|~{3,})/;
/** A link with its text in the middle: "-- text -->", "== text ==>", "-. text .->". */
const LINK_TEXT =
  /^(?:<|o|x)?(?:--|==|-\.)\s+(.+?)\s+(?:-{2,}>|-{2,}[ox](?![\w])|-{3,}|={2,}>|={2,}[ox](?![\w])|={3,}|\.+->|\.+-)/;
const ID = /^[A-Za-z0-9_]+/;

function frontMatterTitle(lines: string[]): { title?: string; skip: number } {
  if (lines[0]?.trim() !== "---") return { skip: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { skip: 0 };
  let title: string | undefined;
  for (const l of lines.slice(1, end)) {
    const m = /^title:\s*(.*)$/.exec(l.trim());
    if (m) title = m[1]!.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return { ...(title ? { title } : {}), skip: end + 1 };
}

/** The diagram blocks in a file: ```mermaid fences in Markdown, else the whole text. */
function blocks(text: string): Block[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const fm = frontMatterTitle(lines);
  const fenced = lines.some((l) => /^\s*(`{3,}|~{3,})\s*mermaid\s*$/.test(l));
  if (!fenced) return [{ lines: lines.slice(fm.skip), first: fm.skip + 1, page: fm.title ?? "" }];
  const out: Block[] = [];
  let heading = fm.title ?? "";
  let fence: string | undefined;
  let mermaid: Block | undefined;
  for (let i = fm.skip; i < lines.length; i++) {
    const l = lines[i]!;
    if (fence) {
      if (l.trim().startsWith(fence) && /^\s*(`+|~+)\s*$/.test(l)) {
        if (mermaid) out.push(mermaid);
        fence = undefined;
        mermaid = undefined;
      } else mermaid?.lines.push(l);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(l);
    if (open) {
      fence = open[1]!;
      if (open[2] === "mermaid") mermaid = { lines: [], first: i + 2, page: heading };
      continue;
    }
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h && !fm.title) heading = h[1]!;
  }
  return out;
}

/** Split a line into statements at ";" outside quotes, brackets and |link text|. */
function statements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let pipe = false;
  let cur = "";
  for (const c of line) {
    if (c === '"') quote = !quote;
    else if (!quote) {
      if (c === "|") pipe = !pipe;
      else if (!pipe && "[({".includes(c)) depth++;
      else if (!pipe && "])}".includes(c)) depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0 && !pipe) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (s: string) => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.length >= 2 && t.startsWith("`") && t.endsWith("`")) return t.slice(1, -1);
  return t;
};

interface NodeRef {
  id: string;
  label?: string;
  shape?: string;
  classes: string[];
}

/** Parse a node at the start of `s`: id, optional @{...}, optional shape, optional :::class. */
function parseNode(s: string): { node: NodeRef; rest: string } | undefined {
  const id = ID.exec(s);
  if (!id) return undefined;
  let rest = s.slice(id[0].length);
  const node: NodeRef = { id: id[0], classes: [] };
  if (rest.startsWith("@{")) {
    let q = false;
    let end = -1;
    for (let i = 2; i < rest.length; i++) {
      if (rest[i] === '"') q = !q;
      else if (!q && rest[i] === "}") {
        end = i;
        break;
      }
    }
    if (end < 0) return undefined;
    for (const m of rest.slice(2, end).matchAll(/(\w+)\s*:\s*("([^"]*)"|'([^']*)'|[^,]+)/g)) {
      const v = (m[3] ?? m[4] ?? m[2]!).trim();
      if (m[1] === "label") node.label = v;
      else if (m[1] === "shape") node.shape = v;
    }
    rest = rest.slice(end + 1);
  } else {
    for (const [open, close, shape] of SHAPES) {
      if (!rest.startsWith(open)) continue;
      const body = rest.slice(open.length);
      let end = -1;
      let label = "";
      if (body.startsWith('"')) {
        const q = body.indexOf('"', 1);
        if (
          q > 0 &&
          body
            .slice(q + 1)
            .trimStart()
            .startsWith(close)
        ) {
          label = body.slice(1, q);
          end = body.indexOf(close, q + 1);
        }
      } else {
        end = body.indexOf(close);
        label = end >= 0 ? body.slice(0, end) : "";
      }
      if (end < 0) continue;
      node.label = unquote(label);
      node.shape = shape;
      rest = body.slice(end + close.length);
      break;
    }
  }
  const cls = /^:::([\w-]+)/.exec(rest);
  if (cls) {
    node.classes.push(cls[1]!);
    rest = rest.slice(cls[0].length);
  }
  return { node, rest };
}

interface LinkRef {
  id?: string;
  text: string;
}

function parseLink(s: string): { link: LinkRef; rest: string } | undefined {
  let rest = s;
  let id: string | undefined;
  const named = /^([A-Za-z0-9_]+)@(?=[-=.<ox~])/.exec(rest);
  if (named) {
    id = named[1];
    rest = rest.slice(named[0].length);
  }
  const plain = LINK.exec(rest);
  if (plain) {
    rest = rest.slice(plain[0].length);
    let text = "";
    const piped = /^\s*\|([^|]*)\|/.exec(rest);
    if (piped) {
      text = piped[1]!;
      rest = rest.slice(piped[0].length);
    }
    return { link: { ...(id ? { id } : {}), text: unquote(text) }, rest };
  }
  const middle = LINK_TEXT.exec(rest);
  if (middle) {
    return {
      link: { ...(id ? { id } : {}), text: unquote(middle[1]!) },
      rest: rest.slice(middle[0].length),
    };
  }
  return undefined;
}

/** Parse "a & b --> c -->|x| d" into groups of nodes joined by links; undefined if it isn't one. */
function parseChain(s: string): { groups: NodeRef[][]; links: LinkRef[] } | undefined {
  const groups: NodeRef[][] = [];
  const links: LinkRef[] = [];
  let rest = s.trim();
  const group = (): boolean => {
    const g: NodeRef[] = [];
    for (;;) {
      const n = parseNode(rest);
      if (!n) return false;
      g.push(n.node);
      rest = n.rest.trimStart();
      if (!rest.startsWith("&")) break;
      rest = rest.slice(1).trimStart();
    }
    groups.push(g);
    return true;
  };
  if (!group()) return undefined;
  while (rest) {
    const l = parseLink(rest);
    if (!l) return undefined;
    links.push(l.link);
    rest = l.rest.trimStart();
    if (!group()) return undefined;
  }
  return { groups, links };
}

interface NodeState {
  cell: string;
  label?: string;
  line: number;
  page: string;
  style: Record<string, string>;
  classes: string[];
}

export function readMermaid(text: string, legendWords: LegendWords = DEFAULT_LEGEND): Diagram {
  const diagram: Diagram = { nodes: [], edges: [], problems: [] };
  let found = false;
  for (const block of blocks(text)) {
    const fm = frontMatterTitle(block.lines);
    const page = fm.title ?? block.page;
    const nodes = new Map<string, NodeState>();
    const edges: { cell: string; from: string; to: string; text: string; line: number }[] = [];
    const classOf = new Map<string, string[]>();
    let header = false;
    let count = 0;
    const mention = (n: NodeRef, line: number, extra: Record<string, string> = {}) => {
      let st = nodes.get(n.id);
      if (!st) {
        st = { cell: n.id, line, page, style: { ...extra }, classes: [] };
        nodes.set(n.id, st);
      }
      if (n.label !== undefined && st.label === undefined) st.label = n.label;
      if (n.shape && !st.style.shape && !st.style.subgraph) st.style.shape = n.shape;
      st.classes.push(...n.classes);
    };
    for (let i = fm.skip; i < block.lines.length; i++) {
      const raw = block.lines[i]!.trim();
      const line = block.first + i;
      if (!raw || raw.startsWith("%%")) continue;
      for (const st of statements(raw)) {
        if (!header) {
          if (!/^(flowchart|graph)\b/i.test(st)) break;
          header = true;
          found = true;
          continue;
        }
        if (/^end$/i.test(st)) continue;
        if (/^(classDef|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(st)) continue;
        const cls = /^class\s+([\w,\s]+?)\s+([\w-]+)$/.exec(st);
        if (cls) {
          for (const id of cls[1]!.split(",").map((x) => x.trim()))
            classOf.set(id, [...(classOf.get(id) ?? []), cls[2]!]);
          continue;
        }
        const sub = /^subgraph\s+(.+)$/i.exec(st);
        if (sub) {
          const n = parseNode(sub[1]!.trim());
          const ref: NodeRef =
            n && !n.rest.trim()
              ? n.node
              : { id: sub[1]!.trim(), label: unquote(sub[1]!), classes: [] };
          mention({ ...ref, shape: undefined } as NodeRef, line, { subgraph: "1" });
          continue;
        }
        const chain = parseChain(st);
        if (!chain) {
          diagram.problems.push({ cell: `L${line}`, message: "line not understood" });
          continue;
        }
        chain.groups.forEach((g) => g.forEach((n) => mention(n, line)));
        chain.links.forEach((l, k) => {
          for (const a of chain.groups[k]!)
            for (const b of chain.groups[k + 1]!) {
              count++;
              edges.push({
                cell: l.id ?? `e${count}`,
                from: a.id,
                to: b.id,
                text: l.text,
                line,
              });
            }
        });
      }
      if (!header) break;
    }
    if (!header) continue;
    const label = (id: string) => {
      const n = nodes.get(id)!;
      return labelText(n.label ?? n.cell) || n.cell;
    };
    const classLegend = (id: string, own: string[] = []) => {
      for (const c of [...own, ...(classOf.get(id) ?? [])]) {
        const l = legendWord(c, legendWords);
        if (l) return l;
      }
      return undefined;
    };
    const labels = new Map<string, string>();
    for (const n of nodes.values()) {
      const { legend, text: lbl } = legendOf(
        classLegend(n.cell, n.classes),
        label(n.cell),
        legendWords,
      );
      labels.set(n.cell, lbl);
      diagram.nodes.push({
        cell: n.cell,
        label: lbl,
        page: n.page,
        line: n.line,
        ...(legend ? { legend } : {}),
        style: n.style,
      });
    }
    for (const e of edges) {
      const { legend, text: lbl } = legendOf(classLegend(e.cell), labelText(e.text), legendWords);
      diagram.edges.push({
        cell: e.cell,
        from: labels.get(e.from)!,
        to: labels.get(e.to)!,
        label: lbl,
        ...edgeParts(lbl),
        ...(legend ? { legend } : {}),
        page,
        line: e.line,
      });
    }
  }
  if (!found) diagram.problems.push({ cell: "", message: "no flowchart or graph diagram found" });
  return diagram;
}
