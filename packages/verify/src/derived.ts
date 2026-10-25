/**
 * Names a framework derives, which no line writes (ADR 0124 addendum A-derived): a table an ORM's
 * naming strategy gives an entity, a route a routing helper gives, a worker's name. The verifier
 * accepts such a claim only when the cited line (or one either side), or a `cite.with` part,
 * declares the source, and the claim is the framework's derived name exactly (letter case aside,
 * as every claim). Each rule below names the convention it follows; nothing here guesses.
 */

export type DerivedKind = "word" | "route" | "field";

export interface DerivedName {
  kind: DerivedKind;
  value: string;
  /** The convention that gives it, for a reader of the code. */
  rule: string;
}

/** What a rule may look at besides the declaring line: other files of the repo. */
export interface DeriveEnv {
  lines(path: string): readonly string[] | undefined;
  files(): readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Naming helpers, each the framework's own function.

/**
 * Spring Boot's physical naming strategy (`CamelCaseToUnderscoresNamingStrategy`, formerly
 * `SpringPhysicalNamingStrategy`): dots to underscores, an underscore before an upper-case letter
 * that has a lower-case letter on both sides, then lower case.
 */
export function springSnake(name: string): string {
  const s = name.replace(/\./g, "_");
  let out = s[0] ?? "";
  for (let i = 1; i < s.length; i++) {
    const before = s[i - 1]!;
    const cur = s[i]!;
    const after = s[i + 1];
    if (after !== undefined && isLower(before) && isUpper(cur) && isLower(after)) out += "_";
    out += cur;
  }
  return out.toLowerCase();
}
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** ActiveSupport's `underscore` (Rails). */
export const railsUnderscore = (name: string) =>
  name
    .replace(/::/g, "/")
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

/** Laravel's `Str::snake`: an underscore before every upper-case letter but the first. */
export const laravelSnake = (name: string) => name.replace(/(.)(?=[A-Z])/g, "$1_").toLowerCase();

/** TypeORM's `snakeCase` (`StringUtils`), which `DefaultNamingStrategy` uses for tables. */
export const typeormSnake = (name: string) =>
  name
    .replace(/([A-Z])([A-Z])([a-z])/g, "$1_$2$3")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

const UNCOUNTABLE = new Set([
  "equipment",
  "information",
  "rice",
  "money",
  "species",
  "series",
  "fish",
  "sheep",
  "jeans",
  "police",
]);
const IRREGULAR: [string, string][] = [
  ["person", "people"],
  ["man", "men"],
  ["child", "children"],
  ["sex", "sexes"],
  ["move", "moves"],
  ["zombie", "zombies"],
];
/** ActiveSupport's default plural rules, the last that matches wins (so listed last first). */
const PLURAL: [RegExp, string][] = (
  [
    [/$/, "s"],
    [/s$/i, "s"],
    [/^(ax|test)is$/i, "$1es"],
    [/(octop|vir)us$/i, "$1i"],
    [/(octop|vir)i$/i, "$1i"],
    [/(alias|status)$/i, "$1es"],
    [/(bu)s$/i, "$1ses"],
    [/(buffal|tomat)o$/i, "$1oes"],
    [/([ti])um$/i, "$1a"],
    [/([ti])a$/i, "$1a"],
    [/sis$/i, "ses"],
    [/(?:([^f])fe|([lr])f)$/i, "$1$2ves"],
    [/(hive)$/i, "$1s"],
    [/([^aeiouy]|qu)y$/i, "$1ies"],
    [/(x|ch|ss|sh)$/i, "$1es"],
    [/(matr|vert|ind)(?:ix|ex)$/i, "$1ices"],
    [/^(m|l)ouse$/i, "$1ice"],
    [/^(m|l)ice$/i, "$1ice"],
    [/^(ox)$/i, "$1en"],
    [/^(oxen)$/i, "$1"],
    [/(quiz)$/i, "$1zes"],
  ] as [RegExp, string][]
).reverse();

/**
 * The plural of a word by ActiveSupport's default inflections (Rails' table names), applied as
 * Rails applies them, to the whole word: rules match at its end (`sales_person` → `sales_people`,
 * `ledgerEntry` → `ledgerEntries`). Laravel's inflector and Spring Data REST's Evo Inflector agree
 * with these English rules.
 */
export function pluralize(word: string): string {
  if (UNCOUNTABLE_RE.some((re) => re.test(word))) return word;
  for (const [one, many] of IRREGULAR) {
    const m = new RegExp(`(${one[0]})${one.slice(1)}$`, "i").exec(word);
    if (m) return word.slice(0, m.index) + m[1] + many.slice(1);
  }
  for (const [re, to] of PLURAL) if (re.test(word)) return word.replace(re, to);
  return word;
}
const UNCOUNTABLE_RE = [...UNCOUNTABLE].map((w) => new RegExp(`(^|[^A-Za-z0-9_])${w}$`, "i"));

/** A plural taken back to its singular, for Devise's `:users` to its `User` model. */
function singularize(word: string): string {
  for (const [one, many] of IRREGULAR)
    if (word.endsWith(many)) return word.slice(0, -many.length) + one;
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(x|ch|ss|sh)es$/.test(word)) return word.replace(/es$/, "");
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}
const camelize = (s: string) =>
  s
    .split("/")
    .map((p) => p.replace(/(?:^|_)([a-z\d])/g, (_, c: string) => c.toUpperCase()))
    .join("::");

// ---------------------------------------------------------------------------------------------
// Shared readers of a declaration.

const CLASS_JVM =
  /^\s*(?:(?:public|protected|private|abstract|final|static|open|data|internal|sealed)\s+)*class\s+([A-Z]\w*)/;
const isComment = (l: string) => /^\s*(\/\/|\/\*|\*|#)/.test(l);

/** The annotations written above a JVM class or field line, as one text (stops at code). */
function annotationsAbove(
  lines: readonly string[],
  idx: number,
  max = 12,
): { text: string; from: number } {
  let from = idx;
  for (let i = idx - 1; i >= 0 && idx - i <= max; i--) {
    const l = lines[i]!;
    const t = l.trim();
    if (t === "" || isComment(l)) {
      from = i;
      continue;
    }
    if (/[;{}]\s*$/.test(t) || /^(import|package)\b/.test(t)) break;
    from = i;
  }
  return { text: lines.slice(from, idx).join("\n"), from };
}

/** The class line a declaring line belongs to: itself, or the class its annotation is on. */
function classLineOf(lines: readonly string[], idx: number, re = CLASS_JVM): number | undefined {
  if (re.test(lines[idx] ?? "")) return idx;
  if (!/^\s*@/.test(lines[idx] ?? "")) return undefined;
  for (let i = idx + 1; i < lines.length && i - idx <= 10; i++) {
    if (re.test(lines[i]!)) return i;
    const t = lines[i]!.trim();
    if (t !== "" && !t.startsWith("@") && !isComment(lines[i]!) && /[;{}]\s*$/.test(t))
      return undefined;
  }
  return undefined;
}

interface JpaEntity {
  className: string;
  /** `@Entity(name = ...)` or the class name. */
  entityName: string;
  /** The physical table: `@Table(name)` as written, else Spring's snake_case of the entity name. */
  table: string;
  tableWritten: boolean;
  file: string;
  lines: readonly string[];
  classLine: number;
}

function jpaEntityAt(file: string, lines: readonly string[], idx: number): JpaEntity | undefined {
  if (!/\.(java|kt)$/.test(file)) return undefined;
  const cl = classLineOf(lines, idx);
  if (cl === undefined) return undefined;
  const { text, from } = annotationsAbove(lines, cl);
  if (idx < cl && idx < from) return undefined;
  if (!/@(?:(?:javax|jakarta)\.persistence\.)?Entity\b/.test(text)) return undefined;
  const className = CLASS_JVM.exec(lines[cl]!)![1]!;
  const entityName = /@Entity\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/.exec(text)?.[1] ?? className;
  const written = /@Table\s*\([^)]*?\bname\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return {
    className,
    entityName,
    table: written ?? springSnake(entityName),
    tableWritten: written !== undefined,
    file,
    lines,
    classLine: cl,
  };
}

/** The entity class whose body holds a line: the nearest class line above it. */
function enclosingJpaEntity(
  file: string,
  lines: readonly string[],
  idx: number,
): JpaEntity | undefined {
  for (let i = idx; i >= 0; i--) if (CLASS_JVM.test(lines[i]!)) return jpaEntityAt(file, lines, i);
  return undefined;
}

/** The column an entity's `@Id` field maps to: `@Column(name)` or Spring's snake of the field. */
function jpaIdColumn(e: JpaEntity): string | undefined {
  for (let i = e.classLine + 1; i < e.lines.length; i++) {
    if (!/^\s*@(Id|EmbeddedId)\b/.test(e.lines[i]!)) continue;
    if (/@EmbeddedId/.test(e.lines[i]!)) return undefined;
    for (let j = i; j < e.lines.length && j - i <= 5; j++) {
      const f = jvmField(e.lines[j]!);
      if (f) {
        const named = /@Column\s*\([^)]*?\bname\s*=\s*"([^"]+)"/.exec(
          e.lines.slice(i, j + 1).join("\n"),
        )?.[1];
        return named ?? springSnake(f.name);
      }
    }
  }
  return undefined;
}

/** A JVM field declaration: its name, type and the type argument of a collection. */
function jvmField(line: string): { name: string; type: string; arg?: string } | undefined {
  const java =
    /^\s*(?:(?:private|protected|public|final|transient)\s+)*([\w.]+)(?:<\s*([\w.]+)\s*(?:,\s*[\w.]+\s*)?>)?\s+(\w+)\s*(?:=[^;]*)?;/.exec(
      line,
    );
  if (java && !/^(return|new|throw)$/.test(java[1]!))
    return { type: java[1]!, arg: java[2], name: java[3]! };
  const kt =
    /^\s*(?:(?:private|protected|public|internal|lateinit|override)\s+)*va[lr]\s+(\w+)\s*:\s*([\w.]+)(?:<\s*([\w.]+)\s*>)?/.exec(
      line,
    );
  if (kt) return { name: kt[1]!, type: kt[2]!, arg: kt[3] };
  return undefined;
}

/**
 * The file that declares a class, by name: the one its imports name, else the one in the same
 * folder, else the only one in the repo whose folder shares the longest prefix with `near`.
 */
function findClassFile(
  env: DeriveEnv,
  name: string,
  near: string,
  exts: RegExp,
  declares: (lines: readonly string[]) => boolean,
  imports: readonly string[] = [],
): string | undefined {
  const all = env.files().filter((p) => exts.test(p));
  const byFile = all.filter((p) => new RegExp(`(^|/)${name}\\.[a-z]+$`).test(p));
  const declaring = (ps: string[]) => ps.filter((p) => declares(env.lines(p) ?? []));
  const imported = imports
    .map((i) => /import\s+([\w.]+)\s*;?/.exec(i)?.[1])
    .filter((i): i is string => !!i && i.endsWith(`.${name}`))
    .map((i) => i.replace(/\./g, "/"));
  for (const imp of imported) {
    const hit = declaring(byFile.filter((p) => p.replace(/\.[a-z]+$/, "").endsWith(imp)));
    if (hit.length === 1) return hit[0];
  }
  const dir = near.split("/").slice(0, -1).join("/");
  const same = declaring(byFile.filter((p) => p.split("/").slice(0, -1).join("/") === dir));
  if (same.length === 1) return same[0];
  const candidates = declaring(byFile.length ? byFile : all);
  const shared = (p: string) => {
    const a = p.split("/");
    const b = near.split("/");
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const best = Math.max(-1, ...candidates.map(shared));
  const top = candidates.filter((p) => shared(p) === best);
  return top.length === 1 ? top[0] : undefined;
}

function jpaEntityByName(
  env: DeriveEnv,
  name: string,
  near: string,
  nearLines: readonly string[],
): JpaEntity | undefined {
  const re = new RegExp(`^\\s*(?:[a-z]+\\s+)*class\\s+${name}\\b`);
  const file = findClassFile(
    env,
    name,
    near,
    /\.(java|kt)$/,
    (ls) => ls.some((l) => re.test(l)),
    nearLines.filter((l) => /^\s*import\s/.test(l)),
  );
  if (!file) return undefined;
  const ls = env.lines(file) ?? [];
  const at = ls.findIndex((l) => re.test(l));
  return at < 0 ? undefined : jpaEntityAt(file, ls, at);
}

/** The field declared at or just after a declaring line, with the annotations above it. */
function jvmFieldAt(
  lines: readonly string[],
  idx: number,
): { field: { name: string; type: string; arg?: string }; ann: string; line: number } | undefined {
  const at = (j: number) => {
    const field = jvmField(lines[j] ?? "");
    return field ? { field, ann: annotationsAbove(lines, j, 6).text, line: j } : undefined;
  };
  const here = at(idx);
  if (here) return here;
  if (!/^\s*@/.test(lines[idx] ?? "")) return undefined;
  for (let j = idx + 1; j < lines.length && j - idx <= 4; j++) {
    const f = at(j);
    if (f) return f;
    if (/[{}]\s*$/.test(lines[j]!.trim())) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The rules. Each takes the declaring line (0-based index) and gives the names it derives.

type Rule = (file: string, lines: readonly string[], idx: number, env: DeriveEnv) => DerivedName[];

/**
 * JPA with Spring Boot's naming: an `@Entity` class without `@Table(name)` is its snake_case
 * (`OrderLine` → `order_line`).
 */
const jpaEntityTable: Rule = (file, lines, idx) => {
  const e = jpaEntityAt(file, lines, idx);
  if (!e || e.tableWritten) return [];
  return [{ kind: "word", value: e.table, rule: "jpa-spring-table" }];
};

/**
 * JPA associations without a named join table or column:
 * - `@OneToMany` (no `mappedBy`, no `@JoinColumn`) or owning `@ManyToMany`: the join table is
 *   Spring Boot's `<owner table>_<property>` (`SpringImplicitNamingStrategy`) or JPA's
 *   `<owner table>_<target table>` (`ImplicitNamingStrategyJpaCompliantImpl`), snake_cased; its
 *   columns `<owner entity>_<owner id>` (or `<inverse property>_<owner id>` when the target maps
 *   it back) and `<property>_<target id>`.
 * - `@ElementCollection`: the collection table `<entity>_<property>`.
 * - `@ManyToOne` or owning `@OneToOne` without `@JoinColumn(name)`: the column
 *   `<property>_<target id>` (`customer` + `customerId` → `customer_customer_id`).
 */
const jpaAssociation: Rule = (file, lines, idx, env) => {
  if (!/\.(java|kt)$/.test(file)) return [];
  const at = jvmFieldAt(lines, idx);
  if (!at) return [];
  const { field, ann } = at;
  const owner = enclosingJpaEntity(file, lines, at.line);
  if (!owner) return [];
  const out: DerivedName[] = [];
  const mapped = /\bmappedBy\s*=/.test(ann);
  const joinTableNamed = /@JoinTable\s*\([^)]*?\bname\s*=/.test(ann);
  const targetName =
    /targetEntity\s*=\s*(\w+)(?:::|\.)class/.exec(ann)?.[1] ?? field.arg ?? field.type;
  const target = () => jpaEntityByName(env, targetName, file, lines);
  if (/@ElementCollection\b/.test(ann) && !/@CollectionTable\s*\([^)]*?\bname\s*=/.test(ann))
    out.push({
      kind: "word",
      value: springSnake(`${owner.entityName}_${field.name}`),
      rule: "jpa-collection-table",
    });
  const toMany =
    /@ManyToMany\b/.test(ann) || (/@OneToMany\b/.test(ann) && !/@JoinColumn\b/.test(ann));
  if (toMany && !mapped && field.arg) {
    const t = target();
    if (!joinTableNamed) {
      out.push({
        kind: "word",
        value: springSnake(`${owner.table}_${field.name}`),
        rule: "jpa-spring-join-table",
      });
      if (t)
        out.push({
          kind: "word",
          value: springSnake(`${owner.table}_${t.table}`),
          rule: "jpa-join-table",
        });
    }
    if (!/@JoinTable\s*\([^)]*?joinColumns/.test(ann)) {
      const ownerId = jpaIdColumn(owner);
      const inverse = t
        ? (() => {
            for (let i = 0; i < t.lines.length; i++)
              if (new RegExp(`mappedBy\\s*=\\s*"${field.name}"`).test(t.lines[i]!)) {
                const f = jvmFieldAt(t.lines, i);
                if (f) return f.field.name;
              }
            return undefined;
          })()
        : undefined;
      if (ownerId)
        out.push({
          kind: "field",
          value: springSnake(`${inverse ?? owner.entityName}_${ownerId}`),
          rule: "jpa-join-column-owner",
        });
      const targetId = t && jpaIdColumn(t);
      if (targetId)
        out.push({
          kind: "field",
          value: springSnake(`${field.name}_${targetId}`),
          rule: "jpa-join-column-target",
        });
    }
  }
  const toOne = /@ManyToOne\b/.test(ann) || (/@OneToOne\b/.test(ann) && !mapped);
  if (toOne && !/@JoinColumn\s*\([^)]*?\bname\s*=/.test(ann)) {
    const t = target();
    const id = t && jpaIdColumn(t);
    if (id)
      out.push({
        kind: "field",
        value: springSnake(`${field.name}_${id}`),
        rule: "jpa-foreign-key",
      });
  }
  return out;
};

const DJANGO_CLASS = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/;
const djangoAppDir = (file: string) =>
  /^(?:(.*)\/)?models\.py$/.exec(file)?.[1] ?? /^(?:(.*)\/)?models\/[^/]+\.py$/.exec(file)?.[1];

interface DjangoModel {
  name: string;
  table: string;
  tableWritten: boolean;
}

/** A Django model declared on a top-level class line of an app's models module. */
function djangoModelAt(
  file: string,
  lines: readonly string[],
  idx: number,
  env: DeriveEnv,
): DjangoModel | undefined {
  const appDir = djangoAppDir(file);
  if (appDir === undefined) return undefined;
  const m = DJANGO_CLASS.exec(lines[idx] ?? "");
  if (!m) return undefined;
  const bases = m[2]!.split(",").map((b) => b.trim().split(".").pop()!);
  if (!bases.some((b) => /Model$|^Abstract\w*User$/.test(b))) return undefined;
  const body: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  const meta = body.join("\n").split(/^\s+class\s+Meta\b.*$/m)[1] ?? "";
  if (/^\s+(abstract|proxy)\s*=\s*True\b/m.test(meta)) return undefined;
  const written = /^\s+db_table\s*=\s*["']([^"']+)["']/m.exec(meta)?.[1];
  // The app a model belongs to is the installed app that contains its module: the nearest folder
  // up from it with an `apps.py` (its AppConfig's `label`, else the last part of its `name`), else
  // the models module's own folder.
  const dirs = appDir ? appDir.split("/") : [];
  let config: { dir: string; text: string } | undefined;
  for (let n = dirs.length; n > 0 && !config; n--) {
    const dir = dirs.slice(0, n).join("/");
    const text = env.lines(`${dir}/apps.py`);
    if (text) config = { dir, text: text.join("\n") };
  }
  const label =
    /^\s+app_label\s*=\s*["']([^"']+)["']/m.exec(meta)?.[1] ??
    (config
      ? (/^\s+label\s*=\s*["']([^"']+)["']/m.exec(config.text)?.[1] ??
        /^\s+name\s*=\s*["']([\w.]+)["']/m.exec(config.text)?.[1]?.split(".").pop() ??
        config.dir.split("/").pop())
      : dirs[dirs.length - 1]);
  if (!label) return undefined;
  return {
    name: m[1]!,
    table: written ?? `${label}_${m[1]!.toLowerCase()}`,
    tableWritten: written !== undefined,
  };
}

/** Django: a model's default table is `<app_label>_<model name in lower case>`. */
const djangoModelTable: Rule = (file, lines, idx, env) => {
  const m = djangoModelAt(file, lines, idx, env);
  return m && !m.tableWritten ? [{ kind: "word", value: m.table, rule: "django-table" }] : [];
};

/**
 * Django fields: a `ManyToManyField` without `through` or `db_table` makes `<model table>_<field>`;
 * a `ForeignKey` or `OneToOneField` without `db_column` is the column `<field>_id`.
 */
const djangoField: Rule = (file, lines, idx, env) => {
  if (djangoAppDir(file) === undefined) return [];
  const f = /^\s+(\w+)\s*=\s*(?:models\.)?(ManyToManyField|ForeignKey|OneToOneField)\s*\(/.exec(
    lines[idx] ?? "",
  );
  if (!f) return [];
  let args = "";
  for (let i = idx, depth = 0; i < lines.length && i - idx < 10; i++) {
    args += `${lines[i]}\n`;
    depth += (lines[i]!.match(/\(/g) ?? []).length - (lines[i]!.match(/\)/g) ?? []).length;
    if (depth <= 0) break;
  }
  let cls = -1;
  for (let i = idx - 1; i >= 0; i--)
    if (/^\S/.test(lines[i]!)) {
      cls = DJANGO_CLASS.test(lines[i]!) ? i : -1;
      break;
    }
  if (cls < 0) return [];
  const model = djangoModelAt(file, lines, cls, env);
  if (!model) return [];
  if (f[2] === "ManyToManyField")
    return /\b(through|db_table)\s*=/.test(args)
      ? []
      : [{ kind: "word", value: `${model.table}_${f[1]}`, rule: "django-m2m-table" }];
  return /\bdb_column\s*=/.test(args)
    ? []
    : [{ kind: "field", value: `${f[1]}_id`, rule: "django-fk-column" }];
};

/**
 * Rails (ActiveRecord): a top-level model class under `ApplicationRecord` or `ActiveRecord::Base`,
 * with no `self.table_name` and not abstract, is the plural of its underscored name
 * (`DocClass` → `doc_classes`).
 */
const railsModelTable: Rule = (file, lines, idx) => {
  if (!/\.rb$/.test(file)) return [];
  const m = /^class\s+([A-Z]\w*)\s*<\s*(ApplicationRecord|ActiveRecord::Base)\s*$/.exec(
    lines[idx] ?? "",
  );
  if (!m) return [];
  const text = lines.join("\n");
  if (/self\.table_name\s*=|self\.abstract_class\s*=\s*true/.test(text)) return [];
  return [{ kind: "word", value: pluralize(railsUnderscore(m[1]!)), rule: "rails-table" }];
};

const LARAVEL_CLASS =
  /^\s*(?:final\s+)?class\s+(\w+)\s+extends\s+\\?(?:Illuminate\\(?:Database\\Eloquent|Foundation\\Auth)\\)?(Model|Authenticatable|User)\b/;

/**
 * Laravel (Eloquent): a model class without `$table` is the snake_case plural of its name
 * (`ArticleTag` → `article_tags`); `belongsToMany(Related::class)` with no table argument joins
 * on the two models' snake_case names in alphabetical order (`article_tag`).
 */
const laravelModel: Rule = (file, lines, idx) => {
  if (!/\.php$/.test(file)) return [];
  const text = lines.join("\n");
  if (/^\s*abstract\s+class\b/m.test(text)) return [];
  const own = lines.map((l) => LARAVEL_CLASS.exec(l)).find((m) => m)?.[1];
  if (!own) return [];
  const cls = LARAVEL_CLASS.exec(lines[idx] ?? "");
  if (cls) {
    if (/protected\s+\$table\s*=/.test(text)) return [];
    // pluralStudly: the last StudlyCase word made plural, then snake_case
    return [{ kind: "word", value: laravelSnake(pluralize(cls[1]!)), rule: "laravel-table" }];
  }
  const rel = /->belongsToMany\(\s*(?:[\w\\]*\\)?(\w+)::class\s*\)/.exec(lines[idx] ?? "");
  if (!rel) return [];
  const pivot = [laravelSnake(own), laravelSnake(rel[1]!)].sort().join("_");
  return [{ kind: "word", value: pivot, rule: "laravel-pivot" }];
};

const TS_CLASS = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;

/** A TypeORM entity's table: `@Entity("name")` as written, else `snakeCase(className)`. */
function typeormEntityAt(
  lines: readonly string[],
  idx: number,
): { name: string; table: string; written: boolean } | undefined {
  const cl = classLineOf(lines, idx, TS_CLASS);
  if (cl === undefined) return undefined;
  const { text } = annotationsAbove(lines, cl);
  const e = /@Entity\s*\(([^)]*)\)/.exec(text);
  if (!e) return undefined;
  const name = TS_CLASS.exec(lines[cl]!)![1]!;
  const written =
    /^\s*["'`]([^"'`]+)["'`]/.exec(e[1]!)?.[1] ??
    /\bname\s*:\s*["'`]([^"'`]+)["'`]/.exec(e[1]!)?.[1];
  return { name, table: written ?? typeormSnake(name), written: written !== undefined };
}

/**
 * TypeORM's `DefaultNamingStrategy`: an `@Entity()` without a name is `snakeCase(className)`; a
 * `@ManyToMany` with `@JoinTable()` and no name is
 * `snakeCase(<owner table>_<property>_<target table>)`.
 */
const typeorm: Rule = (file, lines, idx, env) => {
  if (!/\.[cm]?[jt]s$/.test(file)) return [];
  const e = typeormEntityAt(lines, idx);
  if (e) return e.written ? [] : [{ kind: "word", value: e.table, rule: "typeorm-table" }];
  // the @JoinTable() line, the @ManyToMany line or the property they are on
  let prop = -1;
  for (let j = idx; j < lines.length && j - idx <= 4; j++)
    if (
      /^\s*(?:readonly\s+)?\w+[!?]?\s*:\s*[\w.]+\[\]/.test(lines[j]!) ||
      /^\s*\w+[!?]?\s*:\s*(?:Array|Promise)<[\w.]+(?:\[\])?>/.test(lines[j]!)
    ) {
      prop = j;
      break;
    } else if (j > idx && !/^\s*@/.test(lines[j]!)) break;
  if (prop < 0) return [];
  const ann = annotationsAbove(lines, prop, 6).text;
  const jt = /@JoinTable\s*\(([^)]*)\)/.exec(ann);
  const mm = /@ManyToMany\s*\(\s*\(\)\s*=>\s*(\w+)/.exec(ann);
  if (!jt || !mm || /\bname\s*:/.test(jt[1]!)) return [];
  const propName = /^\s*(?:readonly\s+)?(\w+)/.exec(lines[prop]!)![1]!;
  let owner: { table: string } | undefined;
  for (let i = prop; i >= 0; i--)
    if (TS_CLASS.test(lines[i]!)) {
      owner = typeormEntityAt(lines, i);
      break;
    }
  const tre = new RegExp(`^\\s*export\\s+(?:default\\s+)?class\\s+${mm[1]}\\b`);
  const tfile = findClassFile(env, mm[1]!, file, /\.[cm]?[jt]s$/, (ls) =>
    ls.some((l) => tre.test(l)),
  );
  const tl = tfile ? (env.lines(tfile) ?? []) : [];
  const ti = tl.findIndex((l) => tre.test(l));
  const target = ti >= 0 ? typeormEntityAt(tl, ti) : undefined;
  if (!owner || !target) return [];
  return [
    {
      kind: "word",
      value: typeormSnake(`${owner.table}_${propName}_${target.table}`),
      rule: "typeorm-join-table",
    },
  ];
};

/**
 * Prisma: an implicit many-to-many relation (a list field on both models, no `fields:` in
 * `@relation`) is the table `_<A>To<B>`, the models in alphabetical order, or `_<name>` when the
 * relation is named.
 */
const prismaImplicitM2M: Rule = (file, lines, idx) => {
  if (!/\.prisma$/.test(file)) return [];
  const f = /^\s*(\w+)\s+(\w+)\[\](?:\s+@relation\(\s*(?:name:\s*)?"([^"]+)"([^)]*)\))?\s*$/.exec(
    lines[idx] ?? "",
  );
  if (!f || /fields\s*:/.test(f[4] ?? "")) return [];
  let model: string | undefined;
  for (let i = idx; i >= 0; i--) {
    const m = /^\s*model\s+(\w+)\s*\{/.exec(lines[i]!);
    if (m) {
      model = m[1];
      break;
    }
    if (/^\s*\}/.test(lines[i]!)) return [];
  }
  const target = f[2]!;
  if (!model || model === target) return [];
  // the other side: a list field of this model's type in the target model, with the same name
  const start = lines.findIndex((l) => new RegExp(`^\\s*model\\s+${target}\\s*\\{`).test(l));
  if (start < 0) return [];
  let back = false;
  for (let i = start + 1; i < lines.length && !/^\s*\}/.test(lines[i]!); i++) {
    const b = /^\s*\w+\s+(\w+)\[\](?:\s+@relation\(\s*(?:name:\s*)?"([^"]+)"[^)]*\))?\s*$/.exec(
      lines[i]!,
    );
    if (b && b[1] === model && b[2] === f[3]) back = true;
  }
  if (!back) return [];
  const value = f[3] ? `_${f[3]}` : `_${[model, target].sort().join("To")}`;
  return [{ kind: "word", value, rule: "prisma-implicit-m2m" }];
};

/**
 * The path prefix Rails' routing blocks give a line in `config/routes.rb`: `namespace :x` and
 * `scope "x"` (or `scope path: "x"`) add a segment; `draw`, `constraints`, `controller`,
 * `defaults`, `devise_scope` (or `as`), `authenticate(d)` and a scope without a path add none. Any other
 * enclosing block (`resources :x do`) makes the prefix unknown, so nothing is derived.
 */
function railsPrefix(lines: readonly string[], idx: number): string | undefined {
  const stack: (string | null)[] = [];
  for (let i = 0; i < idx; i++) {
    const l = lines[i]!.replace(/#.*$/, "");
    if (/^\s*end\b/.test(l)) {
      stack.pop();
      continue;
    }
    if (!/\bdo\s*(\|[^|]*\|)?\s*$/.test(l)) continue;
    const ns = /^\s*namespace\s+:(\w+)(.*)$/.exec(l);
    const scope = /^\s*scope\b(.*)$/.exec(l);
    if (ns) {
      const path = /\bpath:\s*["']([^"']*)["']/.exec(ns[2]!)?.[1];
      stack.push(path ?? ns[1]!);
    } else if (scope) {
      const path =
        /^\s*\(?\s*["']([^"']*)["']/.exec(scope[1]!)?.[1] ??
        /\bpath:\s*["']([^"']*)["']/.exec(scope[1]!)?.[1];
      if (path === undefined && /^\s*\(?\s*:\w+\s*(?:,|\)|do)/.test(scope[1]!)) stack.push(null);
      else if (path !== undefined && /[()*]/.test(path)) stack.push(null);
      else stack.push(path ?? "");
    } else if (
      /(\.routes\.draw|^\s*(constraints|controller|defaults|devise_scope|as|authenticated?|concern)\b)/.test(
        l,
      )
    )
      stack.push("");
    else stack.push(null);
  }
  if (stack.includes(null)) return undefined;
  return stack
    .flatMap((s) => (s ?? "").split("/"))
    .filter(Boolean)
    .map((s) => `/${s}`)
    .join("");
}

/** Rails: `root to: "c#a"` (or `root "c#a"`) is `/`, under its namespace or scope. */
const railsRoot: Rule = (file, lines, idx) => {
  if (!/(^|\/)config\/routes(\/[^/]+)?\.rb$/.test(file)) return [];
  if (!/^\s*root\s*(\(|\s)\s*(?:to:\s*|:to\s*=>\s*|controller:\s*)?["':]/.test(lines[idx] ?? ""))
    return [];
  const prefix = railsPrefix(lines, idx);
  return prefix === undefined ? [] : [{ kind: "route", value: prefix || "/", rule: "rails-root" }];
};

/**
 * Devise's routes (as `skip:` and `only:` name them), the model module each comes with and the
 * paths each gives under the default `path_names`.
 */
const DEVISE: { module: string; route: string; paths: (n: (k: string) => string) => string[] }[] = [
  {
    module: "database_authenticatable",
    route: "session",
    paths: (n) => [`/${n("sign_in")}`, `/${n("sign_out")}`],
  },
  {
    module: "registerable",
    route: "registration",
    paths: (n) => {
      const r = n("registration");
      const at = r ? `/${r}` : "";
      return [`${at}/${n("sign_up")}`, at || "/", `${at}/${n("edit")}`, `${at}/${n("cancel")}`];
    },
  },
  {
    module: "recoverable",
    route: "password",
    paths: (n) => [
      `/${n("password")}`,
      `/${n("password")}/${n("new")}`,
      `/${n("password")}/${n("edit")}`,
    ],
  },
  {
    module: "confirmable",
    route: "confirmation",
    paths: (n) => [`/${n("confirmation")}`, `/${n("confirmation")}/${n("new")}`],
  },
  {
    module: "lockable",
    route: "unlock",
    paths: (n) => [`/${n("unlock")}`, `/${n("unlock")}/${n("new")}`],
  },
];

/**
 * Devise: `devise_for :users` gives the routes of the modules the model's `devise` call lists
 * (`/users/sign_in` for `database_authenticatable`, `/users/password/new` for `recoverable`,
 * `/users/auth/<provider>/callback` for `omniauthable`), under `path:` when given, without what
 * `skip:` leaves out or `only:` doesn't name, with `path_names:` applied.
 */
const deviseFor: Rule = (file, lines, idx, env) => {
  if (!/(^|\/)config\/routes(\/[^/]+)?\.rb$/.test(file)) return [];
  const d = /^\s*devise_for\s+:(\w+)(.*)$/.exec(lines[idx] ?? "");
  if (!d) return [];
  const prefix = railsPrefix(lines, idx);
  if (prefix === undefined) return [];
  // the options, over the lines a trailing comma carries them to
  let opts = d[2]!;
  for (let i = idx + 1; /,\s*$/.test(lines[i - 1]!.replace(/#.*$/, "")) && i < lines.length; i++)
    opts += ` ${lines[i]!.replace(/#.*$/, "")}`;
  const resource = /\bpath:\s*["']([^"']*)["']/.exec(opts)?.[1] ?? d[1]!;
  // Devise singularizes what `skip:` and `only:` name (`:registrations` or `:registration`)
  const list = (k: string) => {
    const m = new RegExp(`\\b${k}:\\s*(?:\\[([^\\]]*)\\]|:(\\w+))`).exec(opts);
    return m
      ? (m[1] ?? `:${m[2]}`)
          .split(",")
          .map((s) => singularize(s.trim().replace(/^:/, "")))
          .filter(Boolean)
      : undefined;
  };
  const skip = list("skip") ?? [];
  const only = list("only");
  const names: Record<string, string> = { registration: "" };
  const pn = /\bpath_names:\s*\{([^}]*)\}/.exec(opts)?.[1] ?? "";
  for (const m of pn.matchAll(/(\w+):\s*["']([^"']*)["']/g)) names[m[1]!] = m[2]!;
  const n = (k: string) => names[k] ?? k;
  // the model: class_name, else the resource's singular
  const cls = /\bclass_name:\s*["']([\w:]+)["']/.exec(opts)?.[1] ?? camelize(singularize(d[1]!));
  const modelFile = `app/models/${railsUnderscore(cls)}.rb`;
  const ml =
    env.lines(modelFile) ?? env.lines(file.replace(/config\/routes(\/[^/]+)?\.rb$/, modelFile));
  if (!ml) return [];
  const start = ml.findIndex((l) => /^\s*devise\s+:/.test(l));
  if (start < 0) return [];
  let call = "";
  for (let i = start; i < ml.length; i++) {
    call += ` ${ml[i]!.replace(/#.*$/, "")}`;
    if (!/,\s*$/.test(ml[i]!.replace(/#.*$/, ""))) break;
  }
  const modules = new Set(
    [...call.replace(/\w+:\s*\[[^\]]*\]|\w+:\s*[^,]+/g, "").matchAll(/:(\w+)/g)].map((m) => m[1]!),
  );
  const allowed = (c: string) =>
    !skip.includes(c) && !skip.includes("all") && (!only || only.includes(c));
  const at = `${prefix}${resource ? `/${resource}` : ""}`;
  const out: DerivedName[] = [];
  for (const m of DEVISE)
    if (modules.has(m.module) && allowed(m.route))
      for (const p of m.paths(n))
        out.push({ kind: "route", value: p === "/" ? at || "/" : `${at}${p}`, rule: "devise" });
  if (modules.has("omniauthable") && allowed("omniauth_callback")) {
    const providers = new Set(
      [...(/omniauth_providers:\s*\[([^\]]*)\]/.exec(call)?.[1] ?? "").matchAll(/:(\w+)/g)].map(
        (m) => m[1]!,
      ),
    );
    for (const l of env.lines("config/initializers/devise.rb") ?? [])
      for (const m of l.matchAll(/^\s*config\.omniauth\s+:(\w+)/g)) providers.add(m[1]!);
    for (const p of providers)
      out.push(
        { kind: "route", value: `${at}/auth/${p}`, rule: "devise-omniauth" },
        { kind: "route", value: `${at}/auth/${p}/callback`, rule: "devise-omniauth" },
      );
  }
  return out;
};

/**
 * Spring Data REST: a repository with `@RepositoryRestResource` is exported at its `path`, else
 * the uncapitalized plural of its domain type (Evo Inflector: `LedgerEntry` → `ledgerEntries`):
 * `/<path>`, `/<path>/{id}`, `/<path>/search` and `/<path>/search/<method>` for each query method
 * it declares (or the method's `@RestResource(path)`). Not when `exported = false`.
 */
const springDataRest: Rule = (file, lines, idx) => {
  if (!/\.(java|kt)$/.test(file)) return [];
  const a = /@RepositoryRestResource\b(?:\s*\(([^)]*)\))?/.exec(lines[idx] ?? "");
  if (!a || /\bexported\s*=\s*false/.test(a[1] ?? "")) return [];
  let decl = -1;
  for (let i = idx; i < lines.length && i - idx <= 6; i++)
    if (/\binterface\s+\w+/.test(lines[i]!)) {
      decl = i;
      break;
    }
  if (decl < 0) return [];
  const domain = /\binterface\s+\w+\s*(?:extends|:)\s*[\w.]+\s*<\s*([\w.]+)\s*,/.exec(
    lines.slice(decl, decl + 3).join(" "),
  )?.[1];
  const path =
    /\bpath\s*=\s*"([^"]+)"/.exec(a[1] ?? "")?.[1] ??
    (domain
      ? (() => {
          const p = pluralize(domain.split(".").pop()!);
          return p[0]!.toLowerCase() + p.slice(1);
        })()
      : undefined);
  if (!path) return [];
  const at = `/${path.replace(/^\/+|\/+$/g, "")}`;
  const out: DerivedName[] = [
    { kind: "route", value: at, rule: "spring-data-rest" },
    { kind: "route", value: `${at}/{id}`, rule: "spring-data-rest" },
  ];
  const methods: string[] = [];
  for (let i = decl + 1, depth = 1; i < lines.length && depth > 0; i++) {
    const l = lines[i]!;
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    const m =
      /^\s*(?:@\w+(?:\([^)]*\))?\s+)*[\w<>[\],.?\s]+?\s+((?:find|read|get|query|search|stream|count|exists)\w*)\s*\(/.exec(
        l,
      ) ?? /^\s*fun\s+((?:find|read|get|query|search|stream|count|exists)\w*)\s*\(/.exec(l);
    if (!m) continue;
    const rr = /@RestResource\s*\([^)]*\bpath\s*=\s*"([^"]+)"/.exec(
      `${lines[i - 1] ?? ""} ${l}`,
    )?.[1];
    methods.push(rr ?? m[1]!);
  }
  if (methods.length) out.push({ kind: "route", value: `${at}/search`, rule: "spring-data-rest" });
  for (const m of methods)
    out.push({
      kind: "route",
      value: `${at}/search/${m.replace(/^\/+/, "")}`,
      rule: "spring-data-rest",
    });
  return out;
};

/**
 * A background worker's name (an entry `batch-job`): an ActiveJob class (under `ApplicationJob`,
 * `ActiveJob::Base`, or a `*Job` base in `app/jobs`) or a Sidekiq worker (`include Sidekiq::Job`
 * or `Sidekiq::Worker`) is named by its class with the modules it is nested in
 * (`Billing::SendReceiptJob`).
 */
const rubyWorker: Rule = (file, lines, idx) => {
  if (!/\.rb$/.test(file)) return [];
  const m = /^(\s*)class\s+((?:\w+::)*\w+)(?:\s*<\s*([\w:]+))?\s*$/.exec(lines[idx] ?? "");
  if (!m) return [];
  const activeJob =
    /^(ApplicationJob|ActiveJob::Base)$/.test(m[3] ?? "") ||
    (/(^|\/)app\/jobs\//.test(file) && /Job$/.test(m[3] ?? ""));
  const sidekiq = lines
    .slice(idx + 1, idx + 6)
    .some((l) => /^\s*include\s+Sidekiq::(Job|Worker)\b/.test(l));
  if (!activeJob && !sidekiq) return [];
  const indent = m[1]!.length;
  const modules: string[] = [];
  let level = indent;
  for (let i = idx - 1; i >= 0 && level > 0; i--) {
    const mm = /^(\s*)(?:module|class)\s+((?:\w+::)*\w+)/.exec(lines[i]!);
    if (mm && mm[1]!.length < level) {
      modules.unshift(mm[2]!);
      level = mm[1]!.length;
    }
  }
  return [
    {
      kind: "word",
      value: [...modules, m[2]!].join("::"),
      rule: sidekiq ? "sidekiq-worker" : "active-job",
    },
  ];
};

/**
 * Celery: a function decorated `@shared_task` or `@<app>.task` without `name=` is named
 * `<module>.<function>`, the module being its dotted path from the outermost package (the folders
 * with an `__init__.py`).
 */
const celeryTask: Rule = (file, lines, idx, env) => {
  if (!/\.py$/.test(file)) return [];
  let def = -1;
  for (let j = idx; j < lines.length && j - idx <= 4; j++) {
    if (/^\s*(?:async\s+)?def\s+\w+/.test(lines[j]!)) {
      def = j;
      break;
    }
    if (!/^\s*@/.test(lines[j]!)) break;
  }
  if (def < 0) return [];
  const decorators: string[] = [];
  for (let i = def - 1; i >= 0 && /^\s*@/.test(lines[i]!); i--) decorators.push(lines[i]!);
  const task = decorators.find((d) => /^\s*@(?:shared_task|[\w.]+\.task)\b/.test(d));
  if (!task || /\bname\s*=/.test(task)) return [];
  const fn = /def\s+(\w+)/.exec(lines[def]!)![1]!;
  const parts = file.replace(/\.py$/, "").split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop();
  let top = parts.length - 1;
  while (top > 0 && env.lines(`${parts.slice(0, top).join("/")}/__init__.py`) !== undefined) top--;
  const module = parts.slice(top).join(".");
  return [{ kind: "word", value: `${module}.${fn}`, rule: "celery-task" }];
};

const RULES: Rule[] = [
  jpaEntityTable,
  jpaAssociation,
  djangoModelTable,
  djangoField,
  railsModelTable,
  laravelModel,
  typeorm,
  prismaImplicitM2M,
  railsRoot,
  deviseFor,
  springDataRest,
  rubyWorker,
  celeryTask,
];

const PARAM_SEG = /^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/;
const segsOf = (p: string) =>
  p
    .split(/[?#]/, 1)[0]!
    .split("/")
    .filter(Boolean)
    .map((s) => (PARAM_SEG.test(s) ? "{}" : s.toLowerCase()));
const fieldKey = (f: string) =>
  f
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Whether a claim is one of the derived names: a table or worker name equal to it (letter case
 * aside), a column equal as fields compare (`_` and case aside), a route equal with parameters in
 * any style. A derived route may sit under a prefix the fact's `cite.with` parts write (Spring
 * Data REST's base path, a context path): the claim's leading segments are then checked with
 * `partsNamePath` against the parts' lines, as any built path is.
 */
export function derivedHolds(
  c: { kind: "route" | "word" | "field"; value: string },
  derived: readonly DerivedName[],
  partLines: readonly string[],
  namesPath: (lines: readonly string[], path: string) => boolean,
): boolean {
  if (c.kind === "word")
    return derived.some(
      (d) => d.kind === "word" && d.value.toLowerCase() === c.value.trim().toLowerCase(),
    );
  if (c.kind === "field")
    return derived.some((d) => d.kind === "field" && fieldKey(d.value) === fieldKey(c.value));
  const claim = segsOf(c.value);
  return derived.some((d) => {
    if (d.kind !== "route") return false;
    const r = segsOf(d.value);
    if (claim.length === r.length) return claim.every((s, i) => s === r[i]);
    if (!partLines.length || claim.length < r.length) return false;
    const head = claim.slice(0, claim.length - r.length);
    if (!claim.slice(head.length).every((s, i) => s === r[i])) return false;
    const original = c.value.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).slice(0, head.length);
    return (
      original.some((s) => !PARAM_SEG.test(s)) && namesPath(partLines, `/${original.join("/")}`)
    );
  });
}

/**
 * The names a framework derives from what is declared at `line` (1-based) or one line either
 * side, in `file`. A rule that can't settle a name (a target class it can't find, an enclosing
 * block it doesn't know) gives none.
 */
export function derivedNamesAt(
  file: string,
  lines: readonly string[],
  line: number,
  env: DeriveEnv,
): DerivedName[] {
  const out: DerivedName[] = [];
  for (let i = Math.max(0, line - 2); i <= Math.min(lines.length - 1, line); i++) {
    if (isComment(lines[i]!)) continue;
    for (const r of RULES) out.push(...r(file, lines, i, env));
  }
  return out;
}
