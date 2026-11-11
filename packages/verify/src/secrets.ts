import { hasSecretShape, looksLikeSecret } from "@maycombhq/core";

/**
 * Beta.24: a config file's line that holds what looks like a live secret, said when the repo is
 * verified (Map › Trust): its file, line and key, never its value. The facts never hold a
 * secret's value (`looksLikeSecret` refuses one), so a secret written into a config file is
 * otherwise read past without a word.
 */
export interface SecretLine {
  file: string;
  line: number;
  key: string;
}

/**
 * The files a setting is written in: YAML, properties, JSON, XML (Maven's `settings.xml`), .NET's
 * `.config`, env, ini, TOML, conf, and a credentials file with no extension.
 */
const CONFIG_FILE =
  /\.(ya?ml|properties|json|xml|config|env|ini|toml|conf|cfg)$|(^|\/)\.env(\.[^/]*)?$|(^|\/)credentials?$/i;

/** Whether a path is a file a setting is written in, as the secrets check reads it. */
export const isConfigFile = (path: string) => CONFIG_FILE.test(path.replace(/\\/g, "/"));

/** A value that stands in for a secret rather than being one. */
const PLACEHOLDER =
  /^(<[^>]*>|\*+|x{3,}|changeme|change-me|secret|password|todo|tbd|none|null|nil|dummy|example|sample|test|redacted|your[-_ ].*)$/i;

/** `key: value`, `key = value`, `"key": "value"`, `export KEY=value`: the key and the value. */
const KEY_VALUE =
  /^\s*(?:-\s+)?(?:export\s+)?["']?([A-Za-z0-9_.\-[\]]+)["']?\s*[:=]\s*(.*?)\s*,?\s*$/;
/** An XML element that holds its value: `<password>x</password>`. */
const XML_ELEMENT = /<([A-Za-z_][\w.-]*)>([^<]+)<\/\1>/g;
/** An XML element that names its value: `<add key="ApiKey" value="x" />`. */
const XML_NAMED = /\b(?:key|name)\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/g;
/** Beta.25: the same, its value first: `<cm:property value="x" name="ledger.password"/>`. */
const XML_NAMED_AFTER = /\bvalue\s*=\s*"([^"]*)"\s+(?:key|name)\s*=\s*"([^"]+)"/g;
/** A connection string's pairs: `Server=db;User Id=forge;Password=x;`. */
const CONNECTION_PAIR = /(?:^|[;"'])\s*([A-Za-z][A-Za-z0-9 _.-]*?)\s*=\s*([^;"'<>\s][^;"'<>]*)/g;
/** A deploy tool's token (the Apigee config plugin's `config.json`) names its value elsewhere. */
const TOKEN_VALUE_KEY = /^(value|val)$/i;
const TOKEN_NAME = /^\s*"(xpath|name|key)"\s*:\s*"([^"]+)"/;

/**
 * A value that names where the secret lives, not the secret: a store (`vault:`, `env:`), a
 * placeholder (`${VAR}`, `{{ x }}`), a resource (`classpath:`, `file:`) or a file's path
 * (`/etc/forge/api.key`, `./local/token.txt`, `keys/jwt.pem`).
 */
function isReference(value: string): boolean {
  return (
    /^(vault|env|secret|ref|arn|kms|sm|gcp-sm|azure-kv|classpath\*?|file):/i.test(value) ||
    /\$\{|\{\{/.test(value) ||
    /^(~|\.{1,2})?\/[\w.\-/]+$/.test(value) ||
    /^[\w.-]+(\/[\w.-]+)+\.[A-Za-z0-9]{1,10}$/.test(value)
  );
}

const unquote = (v: string) =>
  v
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();

/** The key a JSON token's `value` sets: its object's `xpath` (or `name`, `key`) line's. */
function tokenKeyNear(lines: readonly string[], i: number): string | undefined {
  for (const step of [-1, 1])
    for (let j = i + step; j >= 0 && j < lines.length && Math.abs(j - i) <= 4; j += step) {
      const l = lines[j]!;
      const m = TOKEN_NAME.exec(l);
      if (m) return m[2]!;
      if (/[{}]/.test(l)) break;
    }
  return undefined;
}

/**
 * Beta.25: the name a YAML list item gives the `value:` under it (`- name: NORTHWIND_CLIENT_SECRET`
 * then `value: "…"`, a container's env): the item's `name:` or `key:` line above, in the same item.
 */
function itemNameAbove(lines: readonly string[], i: number): string | undefined {
  const col = /^\s*/.exec(lines[i]!)![0].length;
  for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
    const l = lines[j]!;
    if (!l.trim()) continue;
    const lead = /^\s*/.exec(l)![0].length;
    const item = /^(\s*)-\s+(.*)$/.exec(l);
    const keyCol = item ? item[1]!.length + (l.length - item[1]!.length - item[2]!.length) : lead;
    if (keyCol !== col) return undefined;
    const m = /^(?:\s*-\s+|\s*)(name|key)\s*:\s*["']?([^"'\s#]+)["']?\s*$/.exec(l);
    if (m) return m[2]!;
    if (item) return undefined;
  }
  return undefined;
}

/** The lines of a config file that hold what looks like a live secret. */
export function liveSecretsIn(file: string, lines: readonly string[]): SecretLine[] {
  if (!isConfigFile(file)) return [];
  const out: SecretLine[] = [];
  lines.forEach((text, i) => {
    if (/^\s*(#|\/\/|;|<!--)/.test(text)) return;
    const pairs: { key: string; value: string }[] = [];
    const kv = KEY_VALUE.exec(text);
    if (kv) {
      const key = TOKEN_VALUE_KEY.test(kv[1]!)
        ? (tokenKeyNear(lines, i) ??
          (/\.ya?ml$/i.test(file) ? itemNameAbove(lines, i) : undefined) ??
          kv[1]!)
        : kv[1]!;
      pairs.push({ key, value: unquote(kv[2]!) });
    }
    for (const m of text.matchAll(XML_ELEMENT)) pairs.push({ key: m[1]!, value: m[2]!.trim() });
    for (const m of text.matchAll(XML_NAMED)) pairs.push({ key: m[1]!, value: m[2]!.trim() });
    for (const m of text.matchAll(XML_NAMED_AFTER)) pairs.push({ key: m[2]!, value: m[1]!.trim() });
    if (text.includes(";"))
      for (const m of text.matchAll(CONNECTION_PAIR))
        pairs.push({ key: m[1]!.trim(), value: m[2]!.trim() });
    const named = pairs.find(
      ({ key, value }) =>
        value &&
        !PLACEHOLDER.test(value) &&
        // a key with a nested map under it, or an encrypted value (`{cipher}…`), sets nothing here
        !/^[{[]/.test(value) &&
        !isReference(value) &&
        looksLikeSecret(key, value),
    );
    if (named) {
      out.push({ file, line: i + 1, key: named.key });
      return;
    }
    // A secret by its shape alone (an access key id, a URL's password, a bearer token), whatever
    // names it: said by the line's key, if it has one.
    if (hasSecretShape(text)) out.push({ file, line: i + 1, key: pairs[0]?.key ?? "(token)" });
  });
  return out;
}
