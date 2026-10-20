/**
 * A minimal XML reader with line numbers, for gateway bundles, Maven poms and similar
 * descriptors. It handles elements, attributes, text, comments, CDATA and the XML
 * declaration; it does not validate or expand entities beyond the five standard ones.
 */
import type { ParsedAt } from "./parsed.js";

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
  line: number;
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]!);

/** Read an XML file; once per repo scan for every reader with its parse cache (ADR 0067). */
export function parseXml(src: string, at?: ParsedAt): XmlElement | undefined {
  return at?.cache ? at.cache.get("xml", at.path, src, readXml) : readXml(src);
}

function readXml(src: string): XmlElement | undefined {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "", line: 1 };
  const stack: XmlElement[] = [root];
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src[k] === "\n") line++;
    i = to;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    const text = src.slice(i, lt);
    if (text.trim()) stack.at(-1)!.text += decode(text.trim());
    advance(lt);
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      advance(end === -1 ? src.length : end + 3);
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      stack.at(-1)!.text += src.slice(i + 9, end === -1 ? src.length : end);
      advance(end === -1 ? src.length : end + 3);
      continue;
    }
    if (src.startsWith("<?", i) || src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      advance(end === -1 ? src.length : end + 1);
      continue;
    }
    const end = src.indexOf(">", i);
    if (end === -1) break;
    const tag = src.slice(i + 1, end);
    const startLine = line;
    advance(end + 1);
    if (tag.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = decode(a[3] ?? a[4] ?? "");
    const el: XmlElement = {
      name: m[1]!.replace(/^.*:/, ""),
      attrs,
      children: [],
      text: "",
      line: startLine,
    };
    stack.at(-1)!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root.children[0];
}

/** Elements matching a simple path from `el`: "HTTPProxyConnection/BasePath", or "//Step/Name" anywhere. */
export function select(el: XmlElement | undefined, path: string): XmlElement[] {
  if (!el) return [];
  const deep = path.startsWith("//");
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  const descendants = (e: XmlElement): XmlElement[] =>
    e.children.flatMap((c) => [c, ...descendants(c)]);
  let current: XmlElement[] = deep
    ? [el, ...descendants(el)].filter((e) => e.name === parts[0])
    : el.name === parts[0]
      ? [el]
      : el.children.filter((c) => c.name === parts[0]);
  for (const part of parts.slice(1))
    current = current.flatMap((e) => e.children.filter((c) => c.name === part));
  return current;
}

/** Text of the first match, trimmed. */
export function selectText(
  el: XmlElement | undefined,
  path: string,
): { text: string; line: number } | undefined {
  const m = select(el, path)[0];
  return m ? { text: m.text.trim(), line: m.line } : undefined;
}
