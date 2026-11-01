import { DEFAULT_READ_RULES, type ReadRules } from "./conventions.js";
import type { FileSource } from "./source.js";
import { isSourceFile } from "./verify.js";

/**
 * R3: the house packages a repo imports that no taught framework covers, found before its first
 * read (ADR 0147). The org pack's `housePrefixes` say which imports are the house's own
 * (`com.forge.`, `@forge/`); a taught framework (org-pack/frameworks/, ADR 0054) covers the
 * imports under its `packages`. What is left is a framework the reader would read as ordinary
 * code: teaching it first means the first read already knows its annotations and clients.
 *
 * Plain text, one line at a time, any language with an import line: nothing here is a fact, and
 * nothing is checked. A warning, never a stop.
 */
export interface HouseImport {
  /** The house package, the prefix and one more part: com.forge.platform, @forge/lantern. */
  package: string;
  /** A name for the framework file, from the package: forge-platform. */
  name: string;
  /** How many of the repo's files import it. */
  files: number;
  /** The first import of it, `file:line`, in path order. */
  first: string;
  /** `atticus frameworks learn <name> --from <its source> --package <package>`. */
  command: string;
}

const CODE =
  /\.(java|kt|kts|scala|groovy|cs|vb|fs|ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rb|php|swift)$/i;

/** The modules a line imports, as written. */
const IMPORTS: readonly RegExp[] = [
  // Java, Kotlin, Scala, Groovy, Python's `import a.b`, Go's one-line import
  /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)/,
  // C#, F#
  /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/,
  /^\s*open\s+([A-Za-z_][\w.]*)\s*$/,
  // Python
  /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/,
  // JavaScript, TypeScript: import ... from "x", export ... from "x", import "x", require("x"), import("x")
  /\bfrom\s+["']([^"'\s]+)["']/,
  /^\s*import\s+["']([^"'\s]+)["']/,
  /\brequire\s*\(\s*["']([^"'\s]+)["']\s*\)/,
  /\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/,
];
/** Go, inside an import block or on one line: "forge.example/platform/x". */
const GO_IMPORT = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w.-]+(?:\/[\w.-]+)+)"\s*$/;

function modulesOf(line: string, go: boolean): string[] {
  const out: string[] = [];
  for (const re of go ? [...IMPORTS, GO_IMPORT] : IMPORTS) {
    const m = re.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

const lower = (s: string) => s.toLowerCase();

/** Whether a module is under a package prefix, whole parts only: tide.platform covers tide.platform.web. */
const under = (module: string, pkg: string) =>
  module === pkg ||
  (module.startsWith(pkg) && (/[./]$/.test(pkg) || /[./]/.test(module[pkg.length] ?? "")));

/** The prefix and the next part of the module after it: com.forge.platform.web.X → com.forge.platform. */
function packageOf(module: string, prefix: string): string {
  let i = prefix.length;
  while (i < module.length && /[./]/.test(module[i]!)) i++;
  const rest = module.slice(i);
  const part = /^[^./]*/.exec(rest)?.[0] ?? "";
  return module.slice(0, i + part.length).replace(/[./]+$/, "");
}

/** forge-platform from com.forge.platform, forge-lantern from @forge/lantern. */
function nameOf(pkg: string): string {
  const parts = lower(pkg)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length > 2 && /^(com|org|net|io|dev|co|uk|de|fr|nl|ch)$/.test(parts[0]!)) parts.shift();
  return parts.join("-") || "house-framework";
}

/**
 * The house packages these files import that no taught package prefix covers, most used first
 * (then by name). Empty when there are no house prefixes.
 */
export function houseImportsUntaught(
  source: FileSource,
  o: {
    /** The org pack's `housePrefixes`. */
    prefixes: readonly string[];
    /** Every taught framework's `packages`. */
    taught: readonly string[];
    rules?: ReadRules;
    /** Accepted exclusion globs, as regexps: their files are not read either. */
    exclude?: readonly RegExp[];
  },
): HouseImport[] {
  if (!o.prefixes.length) return [];
  const rules = o.rules ?? DEFAULT_READ_RULES;
  const prefixes = o.prefixes.map(lower);
  const taught = o.taught.map(lower);
  const found = new Map<string, { files: Set<string>; first: string }>();
  const paths = source
    .list()
    .filter(
      (p) =>
        CODE.test(p) &&
        !rules.notRead.test(p) &&
        !(o.exclude ?? []).some((re) => re.test(p)) &&
        isSourceFile(p, "", undefined, rules),
    )
    .sort();
  for (const p of paths) {
    const text = source.read(p);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const go = /\.go$/i.test(p);
    lines.forEach((line, i) => {
      if (!/\b(import|using|from|require|open)\b/.test(line) && !(go && /^\s*"/.test(line))) return;
      for (const m of modulesOf(line, go)) {
        const ml = lower(m);
        const prefix = prefixes.find((x) => ml.startsWith(x));
        if (!prefix) continue;
        if (taught.some((t) => under(ml, t))) continue;
        const pkg = packageOf(m, prefix);
        const f = found.get(pkg) ?? { files: new Set<string>(), first: `${p}:${i + 1}` };
        f.files.add(p);
        found.set(pkg, f);
      }
    });
  }
  return [...found.entries()]
    .map(([pkg, f]) => {
      const name = nameOf(pkg);
      return {
        package: pkg,
        name,
        files: f.files.size,
        first: f.first,
        command: `atticus frameworks learn ${name} --from <its source, JAR or npm package> --package ${pkg}`,
      };
    })
    .sort(
      (a, b) => b.files - a.files || (a.package < b.package ? -1 : a.package > b.package ? 1 : 0),
    );
}
