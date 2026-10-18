import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";

/** One flattened configuration value with where it came from. */
export interface ConfigValue {
  value: string;
  line: number;
  file: string;
}

/**
 * Flatten YAML (or JSON) into dotted keys with line numbers:
 * `ledger: { client: { read-timeout: 2000ms } }` → "ledger.client.read-timeout" = "2000ms" (line 7).
 * Sequences are indexed: "spring.kafka.topics[0]".
 */
export function flattenYaml(text: string, file: string): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  const lc = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false, uniqueKeys: false });
  } catch {
    return out;
  }
  const lineOf = (n: Node | null | undefined) => (n?.range ? lc.linePos(n.range[0]).line : 1);
  const walk = (node: unknown, prefix: string, keyLine: number) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        walk(pair.value, prefix ? `${prefix}.${k}` : k, lineOf(pair.key as Node));
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, `${prefix}[${i}]`, lineOf(item as Node)));
    } else if (isScalar(node)) {
      out.set(prefix, {
        value: node.value === null ? "" : String(node.value),
        line: keyLine,
        file,
      });
    }
  };
  walk(doc.contents, "", 1);
  return out;
}

/** Flatten a .properties file. */
export function flattenProperties(text: string, file: string): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) return;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, { value: m[2]!, line: i + 1, file });
  });
  return out;
}

/** Spring-style keys are matched loosely: read-timeout, readTimeout and read_timeout are the same. */
export function relaxedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Resolve ${key} and ${key:default} placeholders from config. Unknown placeholders are left
 * as they are, so a caller can tell the value is incomplete.
 */
export function resolvePlaceholders(text: string, config: Map<string, ConfigValue>): string {
  const relaxed = new Map<string, string>();
  for (const [k, v] of config) relaxed.set(relaxedKey(k), v.value);
  return text.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (whole, key: string, def?: string) => {
    const v = config.get(key)?.value ?? relaxed.get(relaxedKey(key));
    return v ?? def ?? whole;
  });
}

/** Find the line of `key:` in YAML text, for evidence on records built from parsed data. */
export function yamlKeyLine(text: string, key: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? undefined : i + 1;
}
