/**
 * A small YAML reader for the few files the extension reads that have no JSON form (the
 * knowledge scan's `scan.yaml`, a saved search of the wikis). The extension ships with no
 * dependencies, so this reads what the command line's `yaml` library writes: block maps and
 * lists (lists of maps too), plain, quoted and block scalars, lines folded onto the next, and
 * short flow lists. Anchors, tags and multi-document files aren't read. It never throws: what it
 * can't read comes back as undefined. No `vscode` here, so it is tested outside the editor.
 */

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

interface Line {
  indent: number;
  /** Without its indent and any comment; "" for a blank line. */
  text: string;
  raw: string;
}

/** The text without a comment that starts outside quotes. */
function uncomment(text: string): string {
  let q: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = undefined;
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s[{,]/.test(text[i - 1]!))) q = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function unquoteDouble(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (e[0] === "u" || e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
    return map[e] ?? e;
  });
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = undefined;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scalar(raw: string): Value {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return unquoteDouble(s.slice(1, -1));
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'"))
    return s.slice(1, -1).replace(/''/g, "'");
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(scalar);
  if (/^[-+]?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Whether a quoted scalar's text has its closing quote. */
function closed(s: string): boolean {
  if (s[0] === "'") return s.length > 1 && s.slice(1).replace(/''/g, "").endsWith("'");
  for (let i = 1, esc = false; i < s.length; i++) {
    if (esc) esc = false;
    else if (s[i] === "\\") esc = true;
    else if (s[i] === '"') return true;
  }
  return false;
}

/** `key: rest`, the key unquoted; undefined when the text isn't one. */
function keyOf(text: string): { key: string; rest: string } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+|$)(.*)$/.exec(text);
  if (quoted) return { key: scalar(quoted[1]!) as string, rest: quoted[2]! };
  const m = /^([^\s"'#[\]{},-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+|$)(.*)$/.exec(text);
  return m ? { key: m[1]!, rest: m[2]! } : undefined;
}

const isItem = (text: string) => text === "-" || text.startsWith("- ");

class Reader {
  private i = 0;
  constructor(private readonly lines: Line[]) {}

  /** The next line that isn't blank, moving past the blank ones. */
  peek(): Line | undefined {
    while (this.lines[this.i] && !this.lines[this.i]!.text) this.i++;
    return this.lines[this.i];
  }

  node(indent: number): Value {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (isItem(l.text)) return this.seq(l.indent);
    if (keyOf(l.text)) return this.map(l.indent);
    this.i++;
    return this.continued(l.text, l.indent - 1);
  }

  /** A scalar that may go on over the lines indented more than its parent. */
  private continued(first: string, parent: number): Value {
    const t = first.trim();
    if (/^[|>][-+]?$/.test(t)) return this.block(t, parent);
    const quoted = t.startsWith('"') || t.startsWith("'");
    let text = t;
    let blank = false;
    for (let open = quoted && !closed(t); ;) {
      const n = this.lines[this.i];
      if (!n) break;
      if (!n.text) {
        blank = true;
        this.i++;
        continue;
      }
      if (n.indent <= parent && !open) break;
      if (!open && (quoted || isItem(n.text) || keyOf(n.text))) break;
      const part = (open ? n.raw : n.text).trim();
      text += blank ? `\n${part}` : text.endsWith("\\") ? part : ` ${part}`;
      if (text.endsWith("\\") && open) text = text.slice(0, -1);
      blank = false;
      this.i++;
      if (open && closed(text)) open = false;
    }
    // A blank line read past belongs to what comes next.
    if (blank) while (this.i > 0 && !this.lines[this.i - 1]!.text) this.i--;
    return scalar(text);
  }

  private block(head: string, parent: number): Value {
    const out: string[] = [];
    let at: number | undefined;
    for (;;) {
      const n = this.lines[this.i];
      if (!n || (n.text && n.indent <= parent)) break;
      if (n.raw.trim()) at ??= n.indent;
      out.push(n.raw.trim() ? n.raw.slice(at) : "");
      this.i++;
    }
    while (out.length && !out.at(-1)) out.pop();
    const text = head.startsWith(">")
      ? out.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ")
      : out.join("\n");
    return head.endsWith("-") ? text : `${text}\n`;
  }

  private map(indent: number): Value {
    const out: Record<string, Value> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || isItem(l.text)) break;
      const k = keyOf(l.text);
      if (!k) break;
      this.i++;
      if (k.rest.trim()) {
        out[k.key] = this.continued(k.rest, indent);
        continue;
      }
      const n = this.peek();
      if (n && n.indent > indent) out[k.key] = this.node(n.indent);
      else if (n && n.indent === indent && isItem(n.text)) out[k.key] = this.seq(indent);
      else out[k.key] = null;
    }
    return out;
  }

  private seq(indent: number): Value {
    const out: Value[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !isItem(l.text)) break;
      const rest = l.text.slice(1).trimStart();
      if (!rest) {
        this.i++;
        const n = this.peek();
        out.push(n && n.indent > indent ? this.node(n.indent) : null);
        continue;
      }
      // "- key: value" or "- - x": the rest is a node at the column it starts at.
      if (keyOf(rest) || isItem(rest)) {
        const col = indent + (l.text.length - rest.length);
        this.lines[this.i] = { indent: col, text: rest, raw: `${" ".repeat(col)}${rest}` };
        out.push(this.node(col));
      } else {
        this.i++;
        out.push(this.continued(rest, indent));
      }
    }
    return out;
  }
}

/** The value of a YAML file, or undefined when it holds nothing this reader can read. */
export function readYaml(text: string): unknown {
  try {
    const lines: Line[] = [];
    for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
      if (/^\s*#/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)) continue;
      const indent = raw.length - raw.trimStart().length;
      lines.push({ indent, text: raw.trim() ? uncomment(raw.trimStart()) : "", raw });
    }
    const reader = new Reader(lines);
    const first = reader.peek();
    return first ? reader.node(first.indent) : undefined;
  } catch {
    return undefined;
  }
}
