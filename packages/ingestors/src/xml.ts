/**
 * A small XML reader for Office, Visio and SVG parts. Unlike the extractors' reader it keeps
 * text exactly (Word splits words across runs and marks spaces with xml:space="preserve"),
 * keeps text and elements in document order, and decodes numeric character references.
 * It never resolves DTDs or external entities, so a document can't make it fetch anything.
 */
export interface XNode {
  /** Local name, namespace prefix removed ("w:p" becomes "p"). */
  name: string;
  attrs: Record<string, string>;
  /** Child elements and text, in order. */
  children: (XNode | string)[];
  line: number;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string, named: Record<string, string> = NAMED): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return named[e] ?? named[e.toLowerCase()] ?? m;
  });
}

/** Parse XML into a tree. Returns undefined when there is no root element. */
export function parseXmlTree(src: string): XNode | undefined {
  const root: XNode = { name: "#document", attrs: {}, children: [], line: 1 };
  const stack: XNode[] = [root];
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) line++;
    i = to;
  };
  const addText = (t: string) => {
    if (!t) return;
    const top = stack.at(-1)!;
    if (top === root) return;
    const last = top.children.at(-1);
    if (typeof last === "string") top.children[top.children.length - 1] = last + t;
    else top.children.push(t);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      addText(decodeEntities(src.slice(i)));
      break;
    }
    addText(decodeEntities(src.slice(i, lt)));
    advance(lt);
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      advance(end === -1 ? src.length : end + 3);
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      addText(src.slice(i + 9, end === -1 ? src.length : end));
      advance(end === -1 ? src.length : end + 3);
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      advance(end === -1 ? src.length : end + 2);
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE, possibly with an internal subset in brackets; skipped, never resolved.
      let depth = 0;
      let k = i + 2;
      for (; k < src.length; k++) {
        const c = src[k];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      advance(Math.min(k + 1, src.length));
      continue;
    }
    // Find the end of the tag, skipping ">" inside quoted attribute values.
    let end = i + 1;
    let quote = "";
    for (; end < src.length; end++) {
      const c = src[end]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (end >= src.length) break;
    const tag = src.slice(i + 1, end);
    const startLine = line;
    advance(end + 1);
    if (tag.startsWith("/")) {
      const name = localName(tag.slice(1).trim());
      // Pop to the matching element; tolerate stray closing tags.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = decodeEntities(a[3] ?? a[4] ?? "");
    const el: XNode = { name: localName(m[1]!), attrs, children: [], line: startLine };
    stack.at(-1)!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root.children.find((c): c is XNode => typeof c !== "string");
}

const localName = (q: string) => q.replace(/^.*:/, "");

/** An attribute by local name, whatever its prefix ("r:id" and "id" both match "id"). */
export function attr(el: XNode, name: string): string | undefined {
  if (el.attrs[name] !== undefined) return el.attrs[name];
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === name) return v;
  return undefined;
}

/** The relationship id of an element (the prefixed "r:id" attribute, not a plain "id"). */
export function relId(el: XNode): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) if (/^[^:]+:id$/.test(k)) return v;
  return undefined;
}

export const elements = (el: XNode | undefined): XNode[] =>
  (el?.children ?? []).filter((c): c is XNode => typeof c !== "string");

export const child = (el: XNode | undefined, name: string): XNode | undefined =>
  elements(el).find((c) => c.name === name);

export const childrenNamed = (el: XNode | undefined, name: string): XNode[] =>
  elements(el).filter((c) => c.name === name);

/** All descendants with this name, in document order (not descending into matches). */
export function findAll(el: XNode | undefined, name: string, intoMatches = false): XNode[] {
  const out: XNode[] = [];
  const walk = (n: XNode) => {
    for (const c of elements(n)) {
      if (c.name === name) {
        out.push(c);
        if (!intoMatches) continue;
      }
      walk(c);
    }
  };
  if (el) walk(el);
  return out;
}

/** All text inside an element, concatenated as is. */
export function textOf(el: XNode | undefined): string {
  if (!el) return "";
  return el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

/** Relationship id to target, from an OPC .rels part. */
export function relationships(xml: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const doc = xml ? parseXmlTree(xml) : undefined;
  for (const r of childrenNamed(doc, "Relationship")) {
    const id = r.attrs.Id;
    const target = r.attrs.Target;
    if (id && target && r.attrs.TargetMode !== "External") out.set(id, target);
  }
  return out;
}

/** Resolve a relationship target against the folder of the part that owns it. */
export function resolvePart(fromFolder: string, target: string): string {
  const parts = target.startsWith("/") ? [] : fromFolder.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
