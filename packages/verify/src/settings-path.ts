import { isCommentLine } from "./skipped.js";

/**
 * Beta.24 review: where a setting's key sits in the files that write it, read strictly. A YAML
 * line's key path is the chain of keys its indentation places it under; a properties line's key
 * is written whole. A call whose path is a placeholder a helper puts together
 * (`${forge-remote.uris.createWallet}`) is kept only when the cited line is code naming the key's
 * last segment and one file proves the rest of the key nests so; a config fact's key and value
 * are checked against the line that sets them. Keys are matched in their own case, and `-`
 * joins a segment, never splits one.
 */

/** A settings file: its lines define keys, they never make a call. */
const SETTINGS_FILE =
  /\.(ya?ml|properties|json|xml|config|conf|ini|toml|cfg|env)$|(^|\/)\.env(\.[^/]*)?$/i;
export const isSettingsFile = (path: string) => SETTINGS_FILE.test(path);
const isYaml = (path: string) => /\.ya?ml$/i.test(path);
const isProperties = (path: string) => /\.properties$/i.test(path);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface YamlLine {
  /** Where the line's first character is. */
  lead: number;
  /** Where its key starts (after a list item's `- `). */
  col: number;
  item: boolean;
  key?: string;
  /** What the line sets after its key, if anything. */
  rest?: string;
}

const YAML_KEY = /^(["']?)([^\s"'#:{}[\],&*!|>][^"'#:]*?)\1\s*:(?:\s+(.*))?$/;

function yamlLine(text: string): YamlLine | undefined {
  if (!text.trim() || /^\s*#/.test(text) || /^\s*(---|\.\.\.)\s*$/.test(text)) return undefined;
  const lead = /^ */.exec(text)![0].length;
  const dash = /^ *-(\s+|$)/.exec(text);
  const col = dash ? dash[0].length : lead;
  const body = text.slice(col);
  const m = YAML_KEY.exec(body.trimEnd());
  const rest = m?.[3]?.trim();
  return {
    lead,
    col,
    item: !!dash,
    key: m?.[2]?.trim(),
    // a comment or an anchor after the key sets nothing
    rest: rest && !/^[#&]/.test(rest) ? rest : undefined,
  };
}

/**
 * The key path a YAML line writes, root first, each key's dotted pieces apart (`spring.datasource:`
 * is two), list items passed through; undefined when the line writes no key or a parent line
 * isn't a key.
 */
export function yamlPathAt(lines: readonly string[], line: number): string[] | undefined {
  const at = yamlLine(lines[line - 1] ?? "");
  if (!at?.key) return undefined;
  const path = [at.key];
  let col = at.item ? at.lead : at.col;
  for (let j = line - 2; j >= 0 && col > 0; j--) {
    const l = lines[j]!;
    if (/^\s*(---|\.\.\.)\s*$/.test(l)) break;
    const y = yamlLine(l);
    if (!y) continue;
    // the start of the list item the mapping we are in belongs to
    if (y.item && y.col === col) {
      col = y.lead;
      continue;
    }
    if (y.col >= col) continue;
    if (!y.key || y.rest) return undefined;
    path.unshift(y.key);
    col = y.lead;
  }
  if (col > 0) return undefined;
  return path.flatMap((k) => k.split("."));
}

/** The keys directly under a YAML line's key. */
function yamlChildren(lines: readonly string[], line: number): string[] {
  const at = yamlLine(lines[line - 1] ?? "");
  if (!at?.key) return [];
  const out: string[] = [];
  let childCol: number | undefined;
  for (let j = line; j < lines.length; j++) {
    const y = yamlLine(lines[j]!);
    if (!y) continue;
    if (y.lead <= at.col) break;
    childCol ??= y.col;
    if (y.col < childCol) break;
    if (y.col === childCol && y.key && !y.item) out.push(y.key);
  }
  return out;
}

/** A properties line's key: `a.b.c=`, `a.b.c:`, `a.b.c value`. */
export function propertiesKeyAt(lines: readonly string[], line: number): string | undefined {
  const l = lines[line - 1] ?? "";
  if (/^\s*[#!]/.test(l)) return undefined;
  return /^\s*((?:\\.|[^\s=:\\])+)\s*[=:\s]/.exec(l)?.[1];
}

const sameSegs = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);
/** A key's segments, an index (`containers[0]`) left out. */
export const keySegments = (key: string) =>
  key
    .trim()
    .split(".")
    .map((s) => s.replace(/\[[^\]]*\]$/, ""))
    .filter(Boolean);

/** `remote-uris` as a field is `remoteUris` (Spring's relaxed binding of a kebab segment). */
const fieldNames = (seg: string) => [
  seg,
  seg.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
];
const CONFIG_PROPS = /@ConfigurationProperties\s*\(\s*(?:(?:prefix|value)\s*=\s*)?"([^"]+)"/;

export interface Part {
  file: string;
  line: number;
  value: string;
}

/**
 * Whether a call cited at `cite` puts the placeholder's key together with a helper: the cited line
 * is code (no settings file's) that names the key's last segment, as an argument or an
 * identifier, in its own case; and one file proves the rest nests so: a YAML line among the
 * parts whose key path is the key, or the key's parents with the last segment under it; a
 * properties line among the parts writing the whole key; or a `@ConfigurationProperties` prefix
 * among the parts whose class's fields, on parts below it in the same file, name the segments
 * between the prefix and the last.
 */
export function helperBuildsKey(
  key: string,
  cite: { file: string; line: number; with?: readonly Part[] },
  linesOf: (path: string) => readonly string[] | undefined,
): boolean {
  if (isSettingsFile(cite.file)) return false;
  const segs = keySegments(key);
  if (segs.length < 2 || segs.join(".") !== key.trim()) return false;
  const last = segs[segs.length - 1]!;
  const prefix = segs.slice(0, -1);
  const line = linesOf(cite.file)?.[cite.line - 1];
  if (line === undefined) return false;
  // what follows a `//` is comment; a line that is all comment is left to the comment check
  const code = isCommentLine(line)
    ? line
    : line.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "");
  if (!new RegExp(`(^|[^A-Za-z0-9_$-])${escape(last)}($|[^A-Za-z0-9_$-])`).test(code)) return false;
  const parts = cite.with ?? [];
  const files = [...new Set(parts.map((p) => p.file))];
  return files.some((file) => {
    const ls = linesOf(file);
    if (!ls) return false;
    const here = parts.filter((p) => p.file === file);
    if (isYaml(file))
      return here.some((p) => {
        const at = yamlPathAt(ls, p.line);
        if (!at) return false;
        if (sameSegs(at, segs)) return true;
        return sameSegs(at, prefix) && yamlChildren(ls, p.line).includes(last);
      });
    if (isProperties(file)) return here.some((p) => propertiesKeyAt(ls, p.line) === segs.join("."));
    if (isSettingsFile(file)) return false;
    return here.some((p) => {
      const m = CONFIG_PROPS.exec(ls[p.line - 1] ?? "");
      if (!m) return false;
      const pre = m[1]!.split(".");
      if (pre.length > prefix.length || !pre.every((s, i) => s === prefix[i])) return false;
      return prefix
        .slice(pre.length)
        .every((seg) =>
          here.some(
            (q) =>
              q.line > p.line &&
              q.line <= p.line + 40 &&
              fieldNames(seg).some((n) =>
                new RegExp(`(^|[^A-Za-z0-9_$])${escape(n)}($|[^A-Za-z0-9_$])`).test(
                  ls[q.line - 1] ?? "",
                ),
              ),
          ),
        );
    });
  });
}

const norm = (s: string) =>
  s
    .replace(/[‘’‚'"“”„`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The lines of the JSON object a line sits in, that object's `{` to its `}`. */
function enclosingObject(lines: readonly string[], line: number): string[] | undefined {
  let depth = 0;
  let start = -1;
  for (let j = line - 1; j >= 0; j--) {
    const l = lines[j]!;
    for (let k = l.length - 1; k >= 0; k--) {
      if (l[k] === "}" && j !== line - 1) depth++;
      if (l[k] === "{") {
        if (depth === 0) {
          start = j;
          break;
        }
        depth--;
      }
    }
    if (start >= 0) break;
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let j = start; j < lines.length; j++) {
    for (const ch of lines[j]!) {
      if (ch === "{") depth++;
      if (ch === "}" && --depth === 0) return lines.slice(start, j + 1);
    }
  }
  return undefined;
}

/**
 * Why a config fact's key or value doesn't hold on its line, or undefined when it does: the
 * value is what the line sets (quotes and spacing aside), on the key's own line when the line is
 * a YAML or properties key with a value, else on the cited line, the line either side or a part;
 * a YAML key sits under the parents the dotted key names, a properties key ends with it; a
 * deploy tool's token (an XPath key in a gateway bundle's `config.json`) has its XPath and value
 * in one token object.
 */
export function configLineProblem(
  f: { key: string; value?: string; cite: { file: string; line: number; with?: readonly Part[] } },
  linesOf: (path: string) => readonly string[] | undefined,
  listed: () => readonly string[],
): string | undefined {
  const lines = linesOf(f.cite.file);
  if (!lines) return undefined;
  const at = lines[f.cite.line - 1] ?? "";
  const where = `${f.cite.file}:${f.cite.line}`;
  const segs = keySegments(f.key);
  const value = f.value === undefined ? undefined : norm(f.value);
  const has = (l: string) => value !== undefined && norm(l).includes(value);

  // a deploy tool's token: `{ "xpath": "<key>", "value": "<value>" }` in a bundle's config.json
  if (f.key.trim().startsWith("/") && /(^|\/)config\.json$/i.test(f.cite.file)) {
    const dir = f.cite.file.replace(/[^/]*$/, "");
    if (!listed().some((p) => p.startsWith(`${dir}apiproxy/`)))
      return `config ${where} is a config.json beside no gateway bundle (no ${dir}apiproxy/); a token's setting is read only from the bundle's own`;
    const obj = enclosingObject(lines, f.cite.line);
    const xpathRe = new RegExp(`"xpath"\\s*:\\s*"${escape(f.key.trim())}"`);
    if (!obj || !obj.some((l) => xpathRe.test(l)))
      return `the token at ${where} has no "xpath" of ${f.key}`;
    if (value !== undefined && !obj.some((l) => /"value"\s*:/.test(l) && has(l)))
      return `the token at ${where} sets no such value; cite the token whose "value" it is`;
    return undefined;
  }

  if (isYaml(f.cite.file)) {
    const y = yamlLine(at);
    const path = yamlPathAt(lines, f.cite.line);
    if (y?.key && path && segs.length && keySegments(y.key).at(-1) === segs.at(-1)) {
      const tail = path.slice(path.length - segs.length);
      if (path.length < segs.length || !sameSegs(tail, segs))
        return `${where} sets ${path.join(".")}, not ${f.key}: the key's parents are not the lines above it`;
      if (value !== undefined && y.rest && !/^[|>]/.test(y.rest)) {
        if (!has(y.rest)) return `${where} sets ${y.key} to something other than the value claimed`;
        return undefined;
      }
    }
  }
  if (isProperties(f.cite.file)) {
    const k = propertiesKeyAt(lines, f.cite.line);
    if (k && k.split(".").at(-1) === segs.at(-1)) {
      if (k !== segs.join(".") && !k.endsWith(`.${segs.join(".")}`))
        return `${where} sets ${k}, not ${f.key}`;
      if (value !== undefined) {
        if (!has(at.slice(at.indexOf(k) + k.length)))
          return `${where} sets ${k} to something other than the value claimed`;
        return undefined;
      }
    }
  }
  if (value === undefined || value === "") return undefined;
  const near = [f.cite.line - 1, f.cite.line, f.cite.line + 1].map((n) => lines[n - 1] ?? "");
  const partLines = (f.cite.with ?? []).map((p) => linesOf(p.file)?.[p.line - 1] ?? "");
  if (![...near, ...partLines].some(has))
    return `${where} (or the line either side) and its parts don't write the value claimed`;
  return undefined;
}
