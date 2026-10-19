import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";

/** One flattened configuration value with where it came from. */
export interface ConfigValue {
  value: string;
  line: number;
  file: string;
}

/**
 * Each YAML document of a file, flattened, with the profile it belongs to: a document that
 * sets `spring.config.activate.on-profile` (or the older `spring.profiles`) is that profile's.
 */
export function flattenYamlDocuments(
  text: string,
  file: string,
): { profile?: string; values: Map<string, ConfigValue> }[] {
  const lc = new LineCounter();
  let docs;
  try {
    docs = parseAllDocuments(text, { lineCounter: lc, keepSourceTokens: false, uniqueKeys: false });
  } catch {
    return [];
  }
  if (!Array.isArray(docs)) return [];
  const lineOf = (n: Node | null | undefined) => (n?.range ? lc.linePos(n.range[0]).line : 1);
  return docs.map((doc) => {
    const out = new Map<string, ConfigValue>();
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
    const profile =
      out.get("spring.config.activate.on-profile")?.value ?? out.get("spring.profiles")?.value;
    return profile ? { profile, values: out } : { values: out };
  });
}

/**
 * Flatten YAML (or JSON) into dotted keys with line numbers:
 * `ledger: { client: { read-timeout: 2000ms } }` → "ledger.client.read-timeout" = "2000ms" (line 7).
 * Sequences are indexed: "spring.kafka.topics[0]". Only documents that belong to no profile
 * (flattenYamlDocuments has the others).
 */
export function flattenYaml(text: string, file: string): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  for (const d of flattenYamlDocuments(text, file))
    if (!d.profile) for (const [k, v] of d.values) if (!out.has(k)) out.set(k, v);
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
 * Resolve ${key} and ${key:default} placeholders from config, as Spring does: innermost first,
 * so a default can itself be a placeholder (${a:${b:x}}), and a value that holds placeholders is
 * resolved too (url → ${base}/v2 → https://${host}/v2). Unknown placeholders are left as they
 * are, so a caller can tell the value is incomplete.
 */
export function resolvePlaceholders(text: string, config: Map<string, ConfigValue>): string {
  const relaxed = new Map<string, string>();
  for (const [k, v] of config) relaxed.set(relaxedKey(k), v.value);
  // Unknown placeholders are parked behind a marker so the loop doesn't find them again.
  const parked: string[] = [];
  let out = text;
  for (let pass = 0; pass < 20; pass++) {
    const next = out.replace(/\$\{([^${}]*)\}/g, (whole, body: string) => {
      const i = body.indexOf(":");
      const key = i < 0 ? body : body.slice(0, i);
      const def = i < 0 ? undefined : body.slice(i + 1);
      const v = config.get(key)?.value ?? relaxed.get(relaxedKey(key)) ?? def;
      if (v !== undefined) return v;
      parked.push(whole);
      return `${parked.length - 1}`;
    });
    if (next === out) break;
    out = next;
  }
  // Private-use characters as markers: they don't occur in config text.
  return out.replace(/(\d+)/g, (_, n: string) => parked[Number(n)]!);
}

/** Find the line of `key:` in YAML text, for evidence on records built from parsed data. */
export function yamlKeyLine(text: string, key: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? undefined : i + 1;
}
