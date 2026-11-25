import { z } from "zod";
import { RE2JS } from "re2js";
import { Fact, FACT_KINDS } from "./facts.js";

/**
 * G4 (ADR 0176): reading rules the organisation owns, in the org pack, in layers: `org.yaml` for
 * every repo, `types/<type>.yaml` for every repo of a type, `repos/<repo>.yaml` for one repo, and
 * `imported/<team>/<type>.yaml`, a pinned copy of another product team's type rules. Each rule
 * adds to what Atticus's built-in rules tell a reader; a later layer may switch an earlier one off
 * for its scope (a built-in rule set by `builtin:<set>`), saying why. A person or Copilot writes
 * them; every change is reviewed like code. They never change the facts file's format or the
 * verifier: every fact still cites its line.
 */

export const READING_RULES_SCHEMA_VERSION = 3 as const;

/**
 * ADR 0208: what Learn from my corrections writes on a rule it drafted: the corrections it was
 * drafted from (`<repo> <file>:<line>`, each a person's pairing), who ran it and when, and either
 * the proof (the files re-read with it and the corrections the re-read reproduced, with no arrow
 * a person touched changed), which makes the rule active, or why it stays a draft.
 */
export const LearnedFrom = z.strictObject({
  /** The corrections it names (its files), each `<repo> <file>:<line>`; none when it names none. */
  corrections: z.array(z.string().min(1).max(600)).max(500),
  by: z.string().min(1).max(300),
  at: z.iso.datetime({ offset: true }),
  /** The assistant's run (under .runs/) that drafted it. */
  run: z.string().min(1).optional(),
  proof: z
    .strictObject({
      /** The repos it was proven on: only their reads are given it; for the rest it is a draft. */
      repos: z.array(z.string().min(1)).min(1).max(500),
      /** `<repo> <file>`: every file re-read with the rule, and only those. */
      reread: z.array(z.string().min(1)).min(1).max(2000),
      /** The corrections the estate join drew again from the re-read alone, as in `corrections`. */
      reproduced: z.array(z.string().min(1)).min(1).max(500),
      /**
       * ADR 0210 part 2 (schema 3, review of item 7): a recipe's `recipeDigest` when it was
       * proven; a recipe edited since is a draft again.
       */
      digest: z
        .string()
        .regex(/^[0-9a-f]{16}$/)
        .optional(),
    })
    .optional(),
  /** Why it stays a draft: a correction it didn't reproduce, or an arrow a person touched it moved. */
  why: z.string().trim().min(3).max(2000).optional(),
});
export type LearnedFrom = z.infer<typeof LearnedFrom>;

/** The fields of a fact's own a recipe can fill (`id`, `repo`, `commit`, `cite` and the rest are the engine's). */
const ENGINE_FIELDS = new Set([
  "kind",
  "id",
  "repo",
  "commit",
  "component",
  "cite",
  "verified",
  "by",
  "conf",
]);
/** ADR 0210 part 2: a required choice a recipe needn't set, and what it is when it doesn't. */
export const RECIPE_CHOICE_DEFAULTS: Record<string, Record<string, string>> = {
  entry: { entryType: "rest" },
  call: { callType: "rest" },
};

type FieldInfo = { type: "string" | "enum" | "other"; required: boolean; choices?: string[] };
/** Each fact kind's fields, from the facts file's own schema, so a recipe can only fill what is there. */
export const RECIPE_FACT_FIELDS: Record<string, Record<string, FieldInfo>> = (() => {
  const out: Record<string, Record<string, FieldInfo>> = {};
  type Def = { type: string; innerType?: { def: Def }; entries?: Record<string, string> };
  for (const o of Fact.options) {
    const shape = o.shape as Record<string, { def: Def }>;
    const kind = (o.shape.kind as unknown as { def: { values: string[] } }).def.values[0]!;
    const fields: Record<string, FieldInfo> = {};
    for (const [k, v] of Object.entries(shape)) {
      if (ENGINE_FIELDS.has(k)) continue;
      let d = v.def;
      let required = true;
      while ((d.type === "optional" || d.type === "default") && d.innerType) {
        required = false;
        d = d.innerType.def;
      }
      fields[k] =
        d.type === "string"
          ? { type: "string", required }
          : d.type === "enum"
            ? { type: "enum", required, choices: Object.values(d.entries ?? {}) }
            : { type: "other", required };
    }
    out[kind] = fields;
  }
  return out;
})();

/** `{name}` references with at most one separator from `/ . : - _` between two, and nothing else. */
const TEMPLATE = /^\{[A-Za-z_][A-Za-z0-9_]*\}(?:[/.:\-_]?\{[A-Za-z_][A-Za-z0-9_]*\})*$/;
/** The names a template uses, in order. */
export function templateNames(t: string): string[] {
  return [...t.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}
/**
 * A recipe's pattern, compiled by RE2 (`re2js`): matching takes time linear in the line, however
 * the pattern is written (a model drafts it; the lines come from repos). What RE2 can't express
 * (a backreference, a lookaround) is refused.
 */
export function recipeRegExp(p: string): RecipePattern {
  return RE2JS.compile(p);
}
/**
 * What a compiled recipe pattern offers the engine: RE2JS's own methods, named here so the
 * SDK's published types don't import `re2js` (bundled into its JavaScript, not a dependency).
 */
export interface RecipePattern {
  matcher(input: string): {
    find(): boolean;
    group(name?: string | number): string | null;
  };
  namedGroups(): Record<string, number>;
}
/** The named groups of a pattern. */
export function groupNames(p: string): string[] {
  try {
    return Object.keys(recipeRegExp(p).namedGroups());
  } catch {
    return [];
  }
}
const Pattern = z
  .string()
  .min(1)
  .max(2000)
  .superRefine((p, ctx) => {
    try {
      recipeRegExp(p);
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        message: `not a pattern a recipe can use (RE2 syntax: no backreferences or lookarounds): ${(e as Error).message}`,
      });
    }
  });

export const RecipeScope = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  /** Matched line by line; its group named `name` is the scope's value, from that line on. */
  pattern: Pattern,
  /** Where the scope stops holding (`</rest>`); with none it holds to the end of the file. */
  end: Pattern.optional(),
});

/** The fields of the fact, each a template of `{group}` references. */
const Fields = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.string().min(1).max(300));
/** The choice fields a recipe may set: what kind of entry, call or setting, not a claim read off a line. */
export const RECIPE_SET_FIELDS = ["entryType", "callType", "settingKind", "tableKind"] as const;
/** A choice field of `RECIPE_SET_FIELDS` set to one of its choices. */
const Set_ = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.string().min(1).max(60));

/**
 * ADR 0210 part 2: a recipe, what the engine in core (`runRecipe`) reads without a model. A
 * `pattern` matched line by line, with scopes (the nearest line above that matches, until its
 * `end`), or every scalar leaf of a YAML file (`yaml: leaves`, groups `key` and `value`). Every
 * part of a value is a cited capture: a field is only `{group}` references.
 */
export const RecipeExtract = z
  .union([
    z.strictObject({
      /** The facts-file kind it writes (ADR 0124). */
      fact: z.enum(FACT_KINDS),
      /** A regular expression matched on each line of 2,000 characters or fewer; its named groups are the parts. */
      pattern: Pattern,
      scopes: z.array(RecipeScope).max(12).optional(),
      /** Names the templates use that may match nothing (an empty part); any other drops the fact. */
      optional: z.array(z.string().min(1)).max(24).optional(),
      /** Each field of the fact as `{group}` references, at most one of `/ . : - _` between two, nothing else. */
      fields: Fields,
      /** A choice field (`entryType`, `callType`, `settingKind`, `tableKind`) set to one of its choices; an entry's `entryType` is `rest` when unset. */
      set: Set_.optional(),
    }),
    z.strictObject({
      fact: z.enum(FACT_KINDS),
      /** One fact per scalar leaf key of a YAML file: groups `key` (dotted) and `value`; each parent key is cited. */
      yaml: z.literal("leaves"),
      /** As a pattern's, from `key` and `value`; default `{ key: "{key}", value: "{value}" }`. */
      fields: Fields.optional(),
      set: Set_.optional(),
    }),
  ])
  .superRefine((e, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const kind = RECIPE_FACT_FIELDS[e.fact] ?? {};
    const fields = e.fields ?? (e.fact === "config" ? { key: "{key}", value: "{value}" } : {});
    const known =
      "yaml" in e
        ? new Set(["key", "value"])
        : new Set([...groupNames(e.pattern), ...(e.scopes ?? []).map((s) => s.name)]);
    const used = new Set<string>();
    for (const [f, t] of Object.entries(fields)) {
      const info = kind[f];
      if (!info || info.type === "other")
        issue(["fields", f], `a ${e.fact} fact has no ${f} a recipe can fill`);
      if (!TEMPLATE.test(t)) {
        issue(
          ["fields", f],
          `${f}: a template is only {group} references, with at most one of / . : - _ between two (ADR 0210)`,
        );
        continue;
      }
      for (const n of templateNames(t)) {
        used.add(n);
        if (!known.has(n))
          issue(["fields", f], `${f}: {${n}} is no group of the pattern and no scope`);
      }
    }
    for (const [f, v] of Object.entries(e.set ?? {})) {
      const info = kind[f];
      if (!(RECIPE_SET_FIELDS as readonly string[]).includes(f) || info?.type !== "enum")
        issue(
          ["set", f],
          `${f}: set takes only ${RECIPE_SET_FIELDS.join(", ")} (a ${e.fact} fact's)`,
        );
      else if (!info.choices?.includes(v)) issue(["set", f], `${f}: ${v} is none of its choices`);
      if (f in fields) issue(["set", f], `${f} is both set and a template`);
    }
    for (const [f, info] of Object.entries(kind))
      if (
        info.required &&
        !(f in fields) &&
        !(f in (e.set ?? {})) &&
        !RECIPE_CHOICE_DEFAULTS[e.fact]?.[f]
      )
        issue(["fields"], `a ${e.fact} fact needs ${f}`);
    if (!("yaml" in e)) {
      const own = new Set(groupNames(e.pattern));
      e.scopes?.forEach((s, i) => {
        if (own.has(s.name))
          issue(["scopes", i, "name"], `scope ${s.name} has the name of a group of the pattern`);
        if (!groupNames(s.pattern).includes(s.name))
          issue(["scopes", i, "pattern"], `scope ${s.name}'s pattern has no group named ${s.name}`);
      });
      for (const n of e.optional ?? [])
        if (!used.has(n)) issue(["optional"], `${n} is optional but no template uses it`);
      // The facts file's `with` holds six parts: a value of more is refused.
      const scopes = (e.scopes ?? []).filter((s) => used.has(s.name)).length;
      if (scopes > 6) issue(["scopes"], `a value of ${scopes} scopes is more than six cited parts`);
    }
  });
export type RecipeExtract = z.infer<typeof RecipeExtract>;

export const ReadingRule = z.strictObject({
  /** Names the rule in its layer and the ones after it: a change re-reads only what it matches. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** draft: proposed (by Copilot or a person), not given to readers until a person sets it active. */
  status: z.enum(["active", "draft"]).default("active"),
  /** The rule, in words a person and Copilot both read. */
  rule: z.string().trim().min(10).max(2000),
  /** The files it is about, as globs in the repo (`src/main/java/**\/*Client.java`); none: every file a read reads. */
  files: z.array(z.string().min(1)).optional(),
  /** A cited line the rule is about (`path:line`), so a reviewer can check it. */
  example: z
    .string()
    .regex(/^[^\s:](?:[^:\n]*[^\s:])?:\d+$/)
    .optional(),
  /** Where it came from: a person, or drafted by Copilot and kept by a person. */
  by: z.string().min(1).max(300).optional(),
  /** ADR 0208 (schema version 2): what Learn from my corrections drafted it from, and its proof. */
  learned: LearnedFrom.optional(),
  /** ADR 0210 part 2 (schema version 3): a recipe the engine in core reads without a model. */
  extract: RecipeExtract.optional(),
});
export type ReadingRule = z.infer<typeof ReadingRule>;

export const ReadingRulesOff = z.strictObject({
  /** A rule's key from an earlier layer, or `builtin:<set>` for a built-in rule set. */
  key: z.string().regex(/^(builtin:)?[a-z0-9][a-z0-9-]{0,62}$/),
  reason: z.string().trim().min(3).max(500),
});

export const ReadingRulesFile = z
  .strictObject({
    /**
     * 1; 2 (ADR 0208) for a file whose rules carry `learned`; 3 (ADR 0210) for one whose rules
     * carry `extract`. A version 1 or 2 file reads as it did.
     */
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(READING_RULES_SCHEMA_VERSION)]),
    /** For an imported copy: where it came from and at which version. */
    source: z
      .strictObject({ from: z.string().min(1), at: z.string().min(1), team: z.string().min(1) })
      .optional(),
    rules: z.array(ReadingRule).default([]),
    off: z.array(ReadingRulesOff).default([]),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.rules.forEach((r, i) => {
      if (seen.has(r.key))
        ctx.addIssue({ code: "custom", path: ["rules", i, "key"], message: `${r.key} is twice` });
      seen.add(r.key);
      if (r.learned && f.schemaVersion < 2)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned"],
          message: "learned needs schemaVersion: 2 (ADR 0208)",
        });
      // ADR 0208: a learned rule is active only with its proof.
      if (r.learned && r.status === "active" && !r.learned.proof)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned"],
          message: "a learned rule is active only with its proof",
        });
      if (r.extract && f.schemaVersion < 3)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "extract"],
          message: "extract needs schemaVersion: 3 (ADR 0210)",
        });
      if (r.extract && !r.files?.length)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "files"],
          message: "a recipe names the files it reads (ADR 0210)",
        });
      if (r.extract && r.status === "active" && r.learned?.proof && !r.learned.proof.digest)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned", "proof"],
          message: "an active recipe's proof carries the digest of what it proved (ADR 0210)",
        });
      // ADR 0210 part 2: a recipe reads only once proven on two repos it wasn't written from.
      if (r.extract && r.status === "active" && (r.learned?.proof?.repos.length ?? 0) < 2)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned"],
          message: "a recipe is active only with its proof on two repos (ADR 0210)",
        });
    });
  });
export type ReadingRulesFile = z.infer<typeof ReadingRulesFile>;

/**
 * Reading rules 1 → 2 (ADR 0208), or 1 or 2 → 3 (ADR 0210) when `to` is 3: the number only,
 * every other line as the person wrote it. Version 2 adds `learned` and version 3 `extract`; a
 * file without them means the same at an earlier version, so only a file written with them is
 * moved on (Learn's default stays 2, so a file it writes still reads in an older Atticus).
 */
export function migrateReadingRulesText(
  text: string,
  to: 2 | 3 = 2,
): { text: string; changed: boolean } {
  const line =
    to === 3
      ? /^schemaVersion:[ \t]*(?:[12]|"[12]"|'[12]')[ \t]*(#.*)?$/m
      : /^schemaVersion:[ \t]*(?:1|"1"|'1')[ \t]*(#.*)?$/m;
  if (!line.test(text)) return { text, changed: false };
  return {
    text: text.replace(line, (_m, c?: string) => `schemaVersion: ${to}${c ? ` ${c}` : ""}`),
    changed: true,
  };
}
