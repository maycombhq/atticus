import { DEFAULT_GATEWAY_BUNDLE_FOLDERS, isSecretPath } from "@maycombhq/core";
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
/**
 * Beta.25 review: a document, never code: prose that names a key's segment is no call (a README,
 * an AsciiDoc page, a text or HTML page).
 */
const DOC_FILE = /\.(md|markdown|mdx|adoc|asciidoc|txt|text|rst|html?|textile|org|rtf|wiki)$/i;
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

// The hunt of beta.28.1 (N1): a key's words split by runs of spaces, each run followed by a word,
// so a long run of spaces with no colon after it is passed once (a lazy `[^"'#:]*?` before
// `\s*:` was quadratic on it).
const YAML_KEY = /^(["']?)([^\s"'#:{}[\],&*!|>][^"'#:\s]*(?:\s+[^"'#:\s]+)*)\1\s*:(?:\s+(.*))?$/;

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
  // Beta.25: in a list item, its sequence's key may sit at the dash's own indentation
  // (`containers:` then `- name:`, as Kubernetes manifests write them).
  let seq = at.item;
  for (let j = line - 2; j >= 0 && (col > 0 || seq); j--) {
    const l = lines[j]!;
    if (/^\s*(---|\.\.\.)\s*$/.test(l)) break;
    const y = yamlLine(l);
    if (!y) continue;
    // the start of the list item the mapping we are in belongs to
    if (y.item && y.col === col) {
      col = y.lead;
      seq = true;
      continue;
    }
    if (seq && !y.item && y.col === col && y.key && !y.rest) {
      path.unshift(y.key);
      seq = false;
      continue;
    }
    if (y.col >= col) continue;
    seq = false;
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
  if (isSettingsFile(cite.file) || DOC_FILE.test(cite.file)) return false;
  const segs = keySegments(key);
  if (segs.length < 2 || segs.join(".") !== key.trim()) return false;
  const last = segs[segs.length - 1]!;
  const prefix = segs.slice(0, -1);
  const fileLines = linesOf(cite.file);
  const line = fileLines?.[cite.line - 1];
  if (line === undefined) return false;
  // what follows a `//` is comment; a line that is all comment is left to the comment check
  const code = isCommentLine(line, cite.file, fileLines)
    ? line
    : line.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "");
  // Beta.25 review: the segment is a whole string literal the code passes (`url("createWallet")`)
  // or an identifier outside any literal (`url(createWallet)`), never a word inside a longer
  // literal (`log.warn("createWallet failed")`).
  const literals: string[] = [];
  const bare = code.replace(
    /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g,
    (_all, _q: string, text: string) => {
      literals.push(text);
      return '""';
    },
  );
  if (
    !literals.includes(last) &&
    !new RegExp(`(^|[^A-Za-z0-9_$-])${escape(last)}($|[^A-Za-z0-9_$-])`).test(bare)
  )
    return false;
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

/**
 * A YAML line's value as written: a quoted scalar's text (a single-quoted one's `''` is one
 * quote), else up to a comment; a tag in front (`!!str 8443`) is no part of it.
 */
function yamlScalar(rest: string): string {
  const t = rest.trim().replace(/^!!?[\w/:.-]*\s+/, "");
  const q = /^(["'])((?:(?!\1).|\1\1)*)\1/.exec(t);
  if (q) return q[1] === "'" ? q[2]!.replace(/''/g, "'") : q[2]!;
  return t.replace(/\s+#.*$/, "").trim();
}

/**
 * A properties line's value, both ways it may be claimed (beta.25 review, second round): what
 * follows its key and separator, with the lines it continues on (a line ending in an odd number
 * of `\`) joined and their leading spaces dropped, as written (`https\://`, `C:\\data`) and
 * read, an escaped character as itself (`https://`, `C:\data`).
 */
function propertiesValues(line: string, key: string, next: readonly string[] = []): string[] {
  let v = line.slice(line.indexOf(key) + key.length).replace(/^\s*[=:]?\s*/, "");
  for (let i = 0; /(^|[^\\])(\\\\)*\\$/.test(v) && i < next.length; i++)
    v = v.slice(0, -1) + next[i]!.replace(/^\s+/, "");
  return [v.trim(), decodeProperties(v)];
}

/** A properties value's escapes read: `\uXXXX`, `\t`, `\n`, and any other `\c` as `c`. */
function decodeProperties(v: string): string {
  return v
    .replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
      c.length === 5
        ? String.fromCharCode(parseInt(c.slice(1), 16))
        : c === "t"
          ? "\t"
          : c === "n"
            ? "\n"
            : c,
    )
    .trim();
}

/** A JSON line's `"value":` member, its string unescaped, else its bare literal. */
function jsonValueOn(line: string): string | undefined {
  const m = /"value"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/.exec(line);
  if (!m) return undefined;
  if (!m[1]!.startsWith('"')) return m[1]!;
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    return m[1]!.slice(1, -1);
  }
}

interface JsonFrame {
  type: "{" | "[";
  start: number;
  end: number;
  /** The member the container is the value of (an array's item: the array's). */
  under?: string;
  /** Its `"name"` member's string, for an object. */
  name?: string;
}

/**
 * The JSON containers of a text, each with the lines it spans, the member it sits under and its
 * `"name"`: enough to tell which configuration and which file of a deploy tool's `config.json` a
 * token is in. Unbalanced or not JSON: whatever was read.
 */
function jsonFrames(lines: readonly string[]): JsonFrame[] {
  const out: JsonFrame[] = [];
  const stack: (JsonFrame & { pending?: string; afterColon?: boolean })[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const l = lines[ln]!;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      const top = stack[stack.length - 1];
      if (ch === '"') {
        let j = i + 1;
        let text = "";
        for (; j < l.length && l[j] !== '"'; j++) {
          if (l[j] === "\\" && j + 1 < l.length) j++;
          text += l[j];
        }
        const isKey = top?.type === "{" && !top.afterColon && /^\s*:/.test(l.slice(j + 1));
        if (top?.type === "{") {
          if (isKey) top.pending = text;
          else if (top.afterColon && top.pending === "name" && top.name === undefined)
            top.name = text;
        }
        i = j;
        continue;
      }
      if (ch === ":" && top?.type === "{") top.afterColon = true;
      else if (ch === "," && top?.type === "{") {
        top.afterColon = false;
        top.pending = undefined;
      } else if (ch === "{" || ch === "[") {
        const under = top?.type === "{" ? top.pending : top?.under;
        stack.push({ type: ch, start: ln + 1, end: lines.length, ...(under ? { under } : {}) });
      } else if (ch === "}" || ch === "]") {
        const f = stack.pop();
        if (f) {
          out.push({
            type: f.type,
            start: f.start,
            end: ln + 1,
            ...(f.under ? { under: f.under } : {}),
            ...(f.name !== undefined ? { name: f.name } : {}),
          });
        }
      }
    }
  }
  return out;
}

const noExt = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\.[^.]*$/, "");

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

/** A value written as a deploy token: its text, the name it is set by, a placeholder's default. */
interface DeployToken {
  written: string;
  name: string;
  fallback?: string;
}

/** `@NAME@`, `${NAME}` or `${NAME:default}` as a whole value, else undefined. */
export function deployToken(v: string): DeployToken | undefined {
  const t = v.trim();
  const at = /^@([A-Za-z_][\w.-]*)@$/.exec(t);
  if (at) return { written: t, name: at[1]! };
  const ph = /^\$\{([A-Za-z_][\w.-]*)(?::([^}]*))?\}$/.exec(t);
  if (ph) return { written: t, name: ph[1]!, ...(ph[2] !== undefined ? { fallback: ph[2] } : {}) };
  return undefined;
}

/**
 * Whether the part's line sets the token `name` to a value `same` accepts: a build file's
 * `<name>value</name>`, a `-Dname=value` flag (one shell word, quoted or not), a YAML key whose
 * whole dotted path is `name` (in a CI file, a variable under `variables:` or `env:` too), a
 * `name=value` / `name: value` line from its start (`export name=…`), or a bundle config.json's
 * token object named `@name@` (or `name`) whose own `"value"` it is. The review of beta.28.1: a
 * test's resources or a secret file never set one (`notSource`).
 */
function setsToken(
  p: Part,
  name: string,
  same: (v: string | undefined) => boolean,
  linesOf: (path: string) => readonly string[] | undefined,
  notSource: (path: string) => boolean,
): boolean {
  if (notSource(p.file)) return false;
  const lines = linesOf(p.file);
  const l = lines?.[p.line - 1];
  if (!lines || l === undefined) return false;
  const n = escape(name);
  const xml = new RegExp(`<${n}>([^<]*)</${n}>`).exec(l);
  if (xml) return same(xml[1]!.trim());
  const flag = new RegExp(`(?:^|\\s)-D${n}=("[^"]*"|'[^']*'|\\S+)`).exec(l);
  if (flag) return same(flag[1]!.replace(/^(["'])(.*)\1$/, "$2"));
  if (/\.ya?ml$/i.test(p.file)) {
    // The cheap test first: a line under no key path sets nothing.
    const path = yamlPathAt(lines, p.line);
    if (!path) return false;
    // The hunt of beta.28.1 (N1): trimmed, and a key whose words are split by single runs of
    // spaces, so nothing backtracks on a long run of them (the old form was cubic).
    const kv = /^["']?[^"':#\s]+(?:\s+[^"':#\s]+)*["']?\s*:\s*(.*)$/.exec(l.trim());
    if (!kv) return false;
    const own = path.join(".") === name;
    // A CI file's variables (`variables:`, `env:`) are set by their own name at any depth.
    const ci =
      CI_FILE.test(p.file) &&
      path[path.length - 1] === name &&
      path.slice(0, -1).some((x) => /^(variables|env|environment|vars)$/i.test(x));
    return (own || ci) && same(yamlScalar(kv[1]!));
  }
  const kv = new RegExp(`^(?:export\\s+)?["']?${n}["']?\\s*[:=]\\s*(.*)$`).exec(l);
  if (kv) return same(yamlScalar(kv[1]!.replace(/,\s*$/, "")));
  if (/(^|\/)config\.json$/i.test(p.file)) {
    const frames = jsonFrames(lines);
    const obj = frames
      .filter((x) => x.type === "{" && x.start <= p.line && x.end >= p.line)
      .sort((a, b) => b.start - a.start)[0];
    if (obj?.name === undefined) return false;
    if (obj.name.trim().replace(/^@(.+)@$/, "$1") !== name) return false;
    // Only the object's own members: a nested container's lines (and its `"value"`) aren't.
    const inner = frames.filter((x) => x !== obj && x.start >= obj.start && x.end <= obj.end);
    return lines.slice(obj.start - 1, obj.end).some((x, i) => {
      const at = obj.start + i;
      const v = inner.some((c) => c.start <= at && c.end >= at)
        ? undefined
        : jsonValueOn(at === obj.start ? x.replace(/^[^{]*\{/, "") : x);
      return same(v);
    });
  }
  return false;
}

/** A CI or deploy pipeline file, whose `variables:` / `env:` set tokens by their own name. */
const CI_FILE =
  /(^|\/)(\.gitlab-ci\.ya?ml|\.github\/workflows\/[^/]+|azure-pipelines[^/]*\.ya?ml|bitbucket-pipelines\.ya?ml|\.circleci\/[^/]+|ci\/[^/]+\.ya?ml|[^/]*pipeline[^/]*\.ya?ml)$/i;

/** The review of beta.28.1: a test's resources or fixtures, and secret files, set no token. */
export const notTokenSource = (path: string): boolean =>
  isSecretPath(path) ||
  /(^|\/)(src\/test|src\/it|tests?|__tests__|fixtures?|testdata)\//i.test(path.replace(/\\/g, "/"));

/**
 * Why a config fact's key or value doesn't hold on its line, or undefined when it does: the
 * value is what the line sets (quotes and spacing aside), on the key's own line when the line is
 * a YAML or properties key with a value, else on the cited line, the line either side or a part;
 * a YAML key sits under the parents the dotted key names, a properties key ends with it; a
 * deploy tool's token (an XPath key in a gateway bundle's `config.json`) has its XPath and value
 * in one token object.
 */
export function configLineProblem(
  f: {
    key: string;
    value?: string | undefined;
    target?: string | undefined;
    env?: string | undefined;
    cite: { file: string; line: number; with?: readonly Part[] | undefined };
  },
  linesOf: (path: string) => readonly string[] | undefined,
  listed: () => readonly string[],
  bundleFolders: readonly string[] = DEFAULT_GATEWAY_BUNDLE_FOLDERS,
  /** Files a `with` line may not set a deploy token from (a test's, a fixture's, a secret's). */
  notSource: (path: string) => boolean = notTokenSource,
): string | undefined {
  const lines = linesOf(f.cite.file);
  if (!lines) return undefined;
  const at = lines[f.cite.line - 1] ?? "";
  const where = `${f.cite.file}:${f.cite.line}`;
  const segs = keySegments(f.key);
  const value = f.value === undefined ? undefined : norm(f.value);
  // Beta.25 review: the value a line sets is the whole value, never a prefix of a longer one
  // (`https://api.northwind.example` is not `https://api.northwind.example.evil.example/v1`).
  const same = (v: string | undefined) =>
    value !== undefined && v !== undefined && norm(v) === value;
  // A line of free text (no key the check reads) holds the value somewhere in it.
  const has = (l: string) => value !== undefined && norm(l).includes(value);
  // Beta.28.1: a value written as a deploy token (`@NAME@`, filled in when the build copies its
  // resources; `${NAME}` or `${NAME:default}`, filled in when the app starts) is the token as
  // written; the value it resolves to only where a `cite.with` line sets NAME to it (a build
  // file's `<NAME>value</NAME>`, a `NAME=value` or `NAME: value` line, a bundle config.json's
  // `{ "name": "@NAME@", "value": … }`), or a placeholder's own default.
  const tokenProblem = (tok: DeployToken, key: string): string | undefined => {
    if (tok.fallback !== undefined && same(tok.fallback)) return undefined;
    if ((f.cite.with ?? []).some((p) => setsToken(p, tok.name, same, linesOf, notSource)))
      return undefined;
    // The hunt of beta.28.1: a `with` line refused for where it is, said as such.
    const refused = (f.cite.with ?? []).filter((p) => notSource(p.file));
    const why = refused.length
      ? ` (${refused.map((p) => `${p.file}:${p.line}`).join(", ")} ${refused.length === 1 ? "is" : "are"} a test's resource, a fixture or a secret file: ${refused.length === 1 ? "it sets" : "they set"} no token for the app)`
      : "";
    return `${where} sets ${key} to the token ${tok.written}; claim the token, or cite where ${tok.written} is set in \`with\` (the build property, deploy or CI line that sets ${tok.name})${why}`;
  };

  // a deploy tool's token: `{ "xpath": "<key>", "value": "<value>" }` in a bundle's config.json
  if (f.key.trim().startsWith("/") && /(^|\/)config\.json$/i.test(f.cite.file)) {
    const dir = f.cite.file.replace(/[^/]*$/, "");
    // Beta.25 review: the bundle folders are the org pack's (`gatewayBundleFolders`).
    if (!listed().some((p) => bundleFolders.some((b) => p.startsWith(`${dir}${b}/`))))
      return `config ${where} is a config.json beside no gateway bundle (no ${bundleFolders.map((b) => `${dir}${b}/`).join(" or ")}); a token's setting is read only from the bundle's own`;
    const obj = enclosingObject(lines, f.cite.line);
    const xpathRe = new RegExp(`"xpath"\\s*:\\s*"${escape(f.key.trim())}"`);
    if (!obj || !obj.some((l) => xpathRe.test(l)))
      return `the token at ${where} has no "xpath" of ${f.key}`;
    if (value !== undefined && !obj.some((l) => same(jsonValueOn(l))))
      return `the token at ${where} sets no such value; cite the token whose "value" it is`;
    // Beta.25 review: the token's environment and file are the configuration's and the file's
    // it sits in (`configurations[].name`, `targets[]`/`policies[]`/`proxies[]` `.name`).
    const around = jsonFrames(lines)
      .filter((x) => x.type === "{" && x.start <= f.cite.line && x.end >= f.cite.line)
      .sort((a, b) => b.start - a.start);
    if (f.target !== undefined) {
      const file = around.find((x) => /^(targets|policies|proxies)$/i.test(x.under ?? ""));
      if (!file?.name || noExt(file.name) !== noExt(f.target))
        return `the token at ${where} is ${file?.name ? `${file.name}'s` : "in no file's list"}, not ${f.target}'s; give the target the token's file is named`;
    }
    if (f.env !== undefined) {
      const conf = around.find((x) => /^configurations$/i.test(x.under ?? ""));
      if (!conf?.name || conf.name.trim() !== f.env.trim())
        return `the token at ${where} is in ${conf?.name ? `the ${conf.name} configuration` : "no named configuration"}, not ${f.env}; give the env its configuration is named`;
    }
    return undefined;
  }

  // Beta.27: a deploy token set by its name in a bundle's config.json, `{ "name": "@token@",
  // "value": "<value>" }` in a configuration's `policies` (or `targets`, `proxies`) list, as some
  // deploy steps write it (not the config plugin's XPath `tokens`). The setting is that token's,
  // its key the token's name (with or without its marks), its value the object's `"value"`, its
  // env the configuration's name.
  if (/(^|\/)config\.json$/i.test(f.cite.file)) {
    const around = jsonFrames(lines)
      .filter((x) => x.type === "{" && x.start <= f.cite.line && x.end >= f.cite.line)
      .sort((a, b) => b.start - a.start);
    const token = around[0];
    const own = token ? lines.slice(token.start - 1, token.end) : [];
    if (
      token?.name !== undefined &&
      /^(policies|targets|proxies)$/i.test(token.under ?? "") &&
      own.some((l) => jsonValueOn(l) !== undefined)
    ) {
      const dir = f.cite.file.replace(/[^/]*$/, "");
      if (!listed().some((p) => bundleFolders.some((b) => p.startsWith(`${dir}${b}/`))))
        return `config ${where} is a config.json beside no gateway bundle (no ${bundleFolders.map((b) => `${dir}${b}/`).join(" or ")}); a token's setting is read only from the bundle's own`;
      const bare = (s: string) =>
        s
          .trim()
          .replace(/^@(.+)@$/, "$1")
          .replace(/^\{\{\s*(.+?)\s*\}\}$/, "$1");
      if (bare(token.name) !== bare(f.key))
        return `the token at ${where} is named ${token.name}, not ${f.key}; give the key the token's name`;
      if (value !== undefined && !own.some((l) => same(jsonValueOn(l))))
        return `the token at ${where} sets no such value; cite the token whose "value" it is`;
      if (f.env !== undefined) {
        const conf = around.find((x) => /^configurations$/i.test(x.under ?? ""));
        if (!conf?.name || conf.name.trim() !== f.env.trim())
          return `the token at ${where} is in ${conf?.name ? `the ${conf.name} configuration` : "no named configuration"}, not ${f.env}; give the env its configuration is named`;
      }
      return undefined;
    }
  }

  if (isYaml(f.cite.file)) {
    const y = yamlLine(at);
    const path = yamlPathAt(lines, f.cite.line);
    if (y?.key && path && segs.length && keySegments(y.key).at(-1) === segs.at(-1)) {
      const tail = path.slice(path.length - segs.length);
      if (path.length < segs.length || !sameSegs(tail, segs))
        return `${where} sets ${path.join(".")}, not ${f.key}: the key's parents are not the lines above it`;
      if (value !== undefined && y.rest && !/^[|>]/.test(y.rest)) {
        const written = yamlScalar(y.rest);
        if (same(written)) return undefined;
        const tok = deployToken(written);
        if (tok) return tokenProblem(tok, keySegments(y.key).at(-1)!);
        return `${where} sets ${y.key} to something other than the value claimed`;
      }
    }
  }
  if (isProperties(f.cite.file)) {
    const k = propertiesKeyAt(lines, f.cite.line);
    if (k && k.split(".").at(-1) === segs.at(-1)) {
      if (k !== segs.join(".") && !k.endsWith(`.${segs.join(".")}`))
        return `${where} sets ${k}, not ${f.key}`;
      if (value !== undefined) {
        const written = propertiesValues(at, k, lines.slice(f.cite.line));
        if (written.some(same)) return undefined;
        const tok = written.map(deployToken).find((t) => t !== undefined);
        if (tok) return tokenProblem(tok, k.split(".").at(-1)!);
        return `${where} sets ${k} to something other than the value claimed`;
      }
    }
  }
  if (value === undefined || value === "") return undefined;
  const near = [f.cite.line - 1, f.cite.line, f.cite.line + 1].map((n) => lines[n - 1] ?? "");
  const partLines = (f.cite.with ?? []).map((p) => linesOf(p.file)?.[p.line - 1] ?? "");
  if ([...near, ...partLines].some(has)) return undefined;
  // Beta.25: a host and port written as two fields (an Apigee TargetServer's `"host"` and
  // `"port"`), each a part whose line writes it: the value is `host:port`.
  const hp = /^([^\s:/]+):(\d{1,5})$/.exec(f.value!.trim());
  if (hp) {
    const parts = f.cite.with ?? [];
    const written = (want: string) =>
      parts.some((p) => {
        if (p.value.trim() !== want) return false;
        const l = linesOf(p.file)?.[p.line - 1] ?? "";
        return new RegExp(`(^|[^A-Za-z0-9.-])${escape(want)}($|[^A-Za-z0-9.-])`).test(l);
      });
    if (written(hp[1]!) && written(hp[2]!)) return undefined;
  }
  return `${where} (or the line either side) and its parts don't write the value claimed`;
}
