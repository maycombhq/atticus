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
  /** Review of beta.24: empty when the key is a secret itself (an access key id), never shown. */
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
 * Review of beta.24: whether a key is itself a secret, so naming its line by it would show one: a
 * well-known token shape (an access key id written as a credentials file's key), or a long run of
 * letters and digits that switches between them as a random token does (`q7Xf3Kd9…`), not words.
 */
export function keyIsSecret(key: string): boolean {
  if (hasSecretShape(key)) return true;
  // Round 3: a run of 24 or more hex digits, letters and digits both (a random id, a digest).
  for (const run of key.match(/[0-9a-f]{24,}|[0-9A-F]{24,}/g) ?? [])
    if (/\d/.test(run) && /[a-f]/i.test(run)) return true;
  if (key.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(key) || !/\d/.test(key)) return false;
  const kind = (c: string) => (/\d/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : 3);
  let switches = 0;
  for (let i = 1; i < key.length; i++) if (kind(key[i]!) !== kind(key[i - 1]!)) switches++;
  if (switches >= key.length / 2 && !readsAsWords(key)) return true;
  // Round 3: as random as a token is (3.5 bits a character or more), and not words.
  return entropyOf(key) >= 3.5 && !readsAsWords(key);
}

/** Shannon entropy, in bits a character. */
function entropyOf(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

/**
 * Whether a key is made of words (`x509Certificate2Path`, `NorthwindV2ApiKey`): its letters,
 * split at case changes and at what isn't a letter, are mostly pieces of three or more, and its
 * letters have vowels as words do (a random token's are about one in five).
 */
function readsAsWords(key: string): boolean {
  const pieces = key.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  const letters = pieces.join("");
  if (!letters.length) return false;
  const vowels = (letters.match(/[aeiouy]/gi) ?? []).length / letters.length;
  const long = pieces.filter((p) => p.length >= 3).reduce((k, p) => k + p.length, 0);
  return vowels >= 0.25 && long / letters.length >= 0.6;
}

/**
 * The lines of a config file that hold what looks like a live secret. Review of beta.24: a key
 * that is a secret itself (`keyIsSecret`) is said as none (`""`, the app's words say why).
 */
export function liveSecretsIn(file: string, lines: readonly string[]): SecretLine[] {
  const shownKey = (key: string) => (keyIsSecret(key) ? "" : key);
  if (!isConfigFile(file)) return [];
  const out: SecretLine[] = [];
  lines.forEach((text, i) => {
    if (/^\s*(#|\/\/|;|<!--)/.test(text)) return;
    const pairs: { key: string; value: string }[] = [];
    const kv = KEY_VALUE.exec(text);
    if (kv) {
      const key = TOKEN_VALUE_KEY.test(kv[1]!) ? (tokenKeyNear(lines, i) ?? kv[1]!) : kv[1]!;
      pairs.push({ key, value: unquote(kv[2]!) });
    }
    for (const m of text.matchAll(XML_ELEMENT)) pairs.push({ key: m[1]!, value: m[2]!.trim() });
    for (const m of text.matchAll(XML_NAMED)) pairs.push({ key: m[1]!, value: m[2]!.trim() });
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
      out.push({ file, line: i + 1, key: shownKey(named.key) });
      return;
    }
    // A secret by its shape alone (an access key id, a URL's password, a bearer token), whatever
    // names it: said by the line's key, if it has one and it is no secret itself.
    if (hasSecretShape(text))
      out.push({ file, line: i + 1, key: pairs[0] ? shownKey(pairs[0].key) : "(token)" });
  });
  return out;
}
