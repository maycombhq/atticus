import { looksLikeSecret } from "@maycombhq/core";

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

/** The files a setting is written in: YAML, properties, JSON, env, ini, TOML, conf. */
const CONFIG_FILE = /\.(ya?ml|properties|json|env|ini|toml|conf|cfg)$|(^|\/)\.env(\.[^/]*)?$/i;

/** A value that stands in for a secret rather than being one. */
const PLACEHOLDER =
  /^(<[^>]*>|\*+|x{3,}|changeme|change-me|secret|password|todo|tbd|none|null|nil|dummy|example|sample|test|redacted|your[-_ ].*)$/i;

/** `key: value`, `key = value`, `"key": "value"`: the key and the value as written. */
const KEY_VALUE = /^\s*(?:-\s+)?["']?([A-Za-z0-9_.\-[\]]+)["']?\s*[:=]\s*(.*?)\s*,?\s*$/;

/** The lines of a config file that hold what looks like a live secret. */
export function liveSecretsIn(file: string, lines: readonly string[]): SecretLine[] {
  if (!CONFIG_FILE.test(file)) return [];
  const out: SecretLine[] = [];
  lines.forEach((text, i) => {
    if (/^\s*(#|\/\/|;)/.test(text)) return;
    const m = KEY_VALUE.exec(text);
    if (!m) return;
    const key = m[1]!;
    const value = m[2]!
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    // A key with a nested map under it, or an empty value, sets nothing here.
    if (!value || PLACEHOLDER.test(value) || /^[{[]/.test(value)) return;
    // A value that names where the secret lives (vault:, env:, ${VAR}) is none.
    if (
      /^(vault|env|secret|ref|arn|kms|sm|gcp-sm|azure-kv):/i.test(value) ||
      /\$\{|\{\{/.test(value)
    )
      return;
    if (looksLikeSecret(key, value)) out.push({ file, line: i + 1, key });
  });
  return out;
}
