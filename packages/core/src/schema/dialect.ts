import { z } from "zod";
import { parseTemplate, templateSources, TemplateError } from "../template.js";
import { Confidence, EvidenceSource, RecordId } from "./common.js";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./kinds.js";

/**
 * Contract C2: a dialect rule file, `org-pack/dialects/<name>.yaml`. A dialect teaches the
 * scanner a house framework (custom annotations, base classes, config keys, XML or JSON
 * descriptors) without code. Rules map a match in the source to a catalog record (C1).
 * Every dialect ships tests; a dialect whose tests fail does not load. See ADR 0011.
 */
export const DIALECT_SCHEMA_VERSION = 1 as const;

const Glob = z
  .string()
  .min(1)
  .refine(
    (g) => !g.startsWith("/") && !g.split("/").includes("..") && !g.includes("\\"),
    "repo-relative glob with forward slashes",
  );
const Globs = z.array(Glob).min(1);
const JavaName = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$.]*$/, "a type name, optionally qualified");

const Template = z.string().superRefine((t, ctx) => {
  try {
    parseTemplate(t);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof TemplateError ? e.message : String(e) });
  }
});

/** Grammars shipped with Atticus for syntax matches (ADR 0060). */
export const SyntaxLanguage = z.enum([
  "java",
  "kotlin",
  "typescript",
  "tsx",
  "javascript",
  "c_sharp",
  "python",
  "go",
  "scala",
  "ruby",
  "php",
  "rust",
  "groovy",
]);

/** Exactly one way to match, each with the files it looks in. */
export const DialectMatch = z.union([
  z.strictObject({
    annotation: JavaName,
    /** What the annotation sits on. */
    target: z.enum(["class", "method", "field", "parameter", "any"]).default("any"),
    files: Globs,
  }),
  z.strictObject({ baseClass: JavaName, files: Globs }),
  z.strictObject({
    /** Method name, optionally with the receiver: "send" or "kafkaTemplate.send". */
    methodCall: z.string().regex(/^([A-Za-z_$][A-Za-z0-9_$]*\.)?[A-Za-z_$][A-Za-z0-9_$]*$/),
    /** Only when the receiver's declared type matches. */
    receiverType: JavaName.optional(),
    files: Globs,
  }),
  z.strictObject({
    /** Dotted key; "*" matches one segment: "spring.kafka.*.topic". */
    configKey: z.string().regex(/^[A-Za-z0-9_\-*]+(\.[A-Za-z0-9_\-*[\]]+)*$/),
    files: Globs,
  }),
  z.strictObject({ xpath: z.string().min(1), files: Globs }),
  z.strictObject({ jsonPath: z.string().regex(/^\$/, "JSONPath starts with $"), files: Globs }),
  z.strictObject({
    /** A tree-sitter query over the file's syntax tree (ADR 0060); its captures are ${capture.x}. */
    syntax: z.string().min(1),
    /** The grammar; by default the file's extension says. */
    language: SyntaxLanguage.optional(),
    files: Globs,
  }),
  z.strictObject({
    /** A Terraform (HCL) block type, optionally with its first label: "module", "resource.aws_sqs_queue" (ADR 0056). */
    hclBlock: z
      .string()
      .regex(/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)?$/, "a block type, or type.label"),
    files: Globs,
  }),
  z.strictObject({
    /** A regular expression over file text, for anything else; groups are ${match.N}. */
    regex: z
      .string()
      .min(1)
      .refine((r) => {
        try {
          new RegExp(r);
          return true;
        } catch {
          return false;
        }
      }, "not a valid regular expression"),
    files: Globs,
  }),
]);
export type DialectMatch = z.infer<typeof DialectMatch>;

export function matchType(
  m: DialectMatch,
):
  | "annotation"
  | "baseClass"
  | "methodCall"
  | "configKey"
  | "xpath"
  | "jsonPath"
  | "hclBlock"
  | "syntax"
  | "regex" {
  for (const k of [
    "annotation",
    "baseClass",
    "methodCall",
    "configKey",
    "xpath",
    "jsonPath",
    "hclBlock",
    "syntax",
    "regex",
  ] as const) {
    if (k in m) return k;
  }
  throw new Error("unreachable");
}

const FieldValue = z.union([Template, z.number(), z.boolean(), z.array(Template)]);

export const DialectEmit = z.strictObject({
  kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]),
  /** Record id template. Omitted for Interface: the engine derives it from from, to, method and path. */
  id: Template.optional(),
  /** Record fields as templates. Only fields contract C1 defines for the kind are allowed. */
  fields: z.record(z.string(), FieldValue).default({}),
  evidence: z
    .strictObject({
      source: EvidenceSource.default("code"),
      side: z.enum(["caller", "callee", "gateway", "definition"]).optional(),
    })
    .default({ source: "code" }),
});

/** A condition on a match (ADR 0056): the template's value must match the regex. */
export const DialectWhere = z.strictObject({
  value: Template,
  matches: z
    .string()
    .min(1)
    .refine((r) => {
      try {
        new RegExp(r);
        return true;
      } catch {
        return false;
      }
    }, "not a valid regular expression"),
});

export const DialectRule = z.strictObject({
  id: RecordId,
  description: z.string().min(1),
  match: DialectMatch,
  /** Conditions that must all hold for a match to emit; an unfilled value fails its condition. */
  where: z.array(DialectWhere).optional(),
  /** The record to emit for each match, or several (ADR 0058). */
  emit: z.union([DialectEmit, z.array(DialectEmit).min(1)]),
  /** What a rule can claim: never "asserted", which is reserved for people. */
  confidence: Confidence.exclude(["asserted"]),
});
export type DialectRule = z.infer<typeof DialectRule>;
export type DialectEmit = z.infer<typeof DialectEmit>;

/**
 * A lookup table (ADR 0058): rows from the places a match finds, each keyed by a template and
 * holding named template values. Rules read a row with ${lookup:<table>(<key>).<value>}.
 */
export const DialectLookup = z.strictObject({
  match: DialectMatch,
  key: Template,
  values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/), Template),
});

export const DialectTest = z.strictObject({
  name: z.string().min(1),
  /** Inline files (path → content), or a fixture folder relative to the dialect file. */
  files: z.record(z.string(), z.string()).optional(),
  fixture: z.string().optional(),
  /** Records that must be produced; each lists kind, id and any fields to compare. */
  expect: z
    .array(
      z.looseObject({ kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]), id: RecordId }),
    )
    .default([]),
  /** Record ids that must not be produced. */
  absent: z.array(RecordId).default([]),
});

export const Dialect = z
  .strictObject({
    schemaVersion: z.literal(DIALECT_SCHEMA_VERSION),
    name: RecordId,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver"),
    description: z.string().optional(),
    /** Other dialects whose rules this one inherits; a rule with the same id overrides. */
    extends: z.array(RecordId).default([]),
    appliesTo: z.strictObject({
      /** Repo types from repos.manifest.yaml; empty means any repo that lists this dialect. */
      repoTypes: z.array(z.union([RecordId, z.literal("*")])).default([]),
      /** A file that must exist for the dialect to apply, e.g. "forge.yaml". */
      marker: Glob.optional(),
    }),
    layout: z
      .strictObject({
        sourceRoots: z.array(Glob).default([]),
        /** Files ${config:key} reads, in order of precedence. */
        configFiles: z.array(Glob).default([]),
      })
      .default({ sourceRoots: [], configFiles: [] }),
    normalize: z
      .strictObject({
        /** Prefixes removed from paths before ids and normalisedPath are built. */
        stripPathPrefixes: z.array(z.string().startsWith("/")).default([]),
      })
      .default({ stripPathPrefixes: [] }),
    /** Code for what rules can't express: a module in the org pack exporting an extractor. */
    plugin: z
      .strictObject({
        module: z
          .string()
          .regex(/^\.\/[A-Za-z0-9_./-]+\.m?js$/, "a relative .js or .mjs path inside the org pack"),
        export: z.string().default("default"),
      })
      .optional(),
    /** Tables rules look values up in, across files (ADR 0058). */
    lookups: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/), DialectLookup).optional(),
    rules: z.array(DialectRule).default([]),
    tests: z.array(DialectTest).min(1, "every dialect ships at least one test"),
  })
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    d.rules.forEach((r, i) => {
      if (ids.has(r.id))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "id"],
          message: `duplicate rule id ${r.id}`,
        });
      ids.add(r.id);
      const emits = Array.isArray(r.emit) ? r.emit : [r.emit];
      emits.forEach((emit, j) => {
        const at: (string | number)[] = Array.isArray(r.emit)
          ? ["rules", i, "emit", j]
          : ["rules", i, "emit"];
        const shape = (RECORD_SCHEMAS[emit.kind] as unknown as { shape: Record<string, unknown> })
          .shape;
        for (const f of Object.keys(emit.fields)) {
          if (["kind", "id", "schemaVersion", "evidence", "confidence"].includes(f)) {
            ctx.addIssue({
              code: "custom",
              path: [...at, "fields", f],
              message: `${f} is set by the engine, not by a rule`,
            });
          } else if (!(f in shape)) {
            ctx.addIssue({
              code: "custom",
              path: [...at, "fields", f],
              message: `${emit.kind} has no field ${f} in contract C1`,
            });
          }
        }
        // Check each template uses only values this kind of match can supply.
        if (emit.kind === "Interface" && emit.id !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...at, "id"],
            message: "Interface ids are derived (if-<hash>); leave id out",
          });
        }
        if (emit.kind !== "Interface" && emit.id === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...at, "id"],
            message: `${emit.kind} needs an id template`,
          });
        }
        const templates = [
          ...(emit.id === undefined ? [] : [emit.id]),
          ...Object.values(emit.fields).flatMap((v) =>
            typeof v === "string" ? [v] : Array.isArray(v) ? v : [],
          ),
          ...(r.where ?? []).map((w) => w.value),
        ];
        for (const t of templates) {
          let sources;
          try {
            sources = templateSources(t);
          } catch {
            continue; // reported by the Template refinement
          }
          for (const s of sources) {
            if (s.type === "subject")
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message: `\${${s.name}} is only for checklist questions`,
              });
            if (
              s.type === "match" &&
              !["regex", "configKey", "xpath", "jsonPath", "hclBlock"].includes(matchType(r.match))
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message: "${match.N} needs a regex, configKey, xpath, jsonPath or hclBlock match",
              });
            }
            if (s.type === "capture" && matchType(r.match) !== "syntax")
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message: "${capture.*} needs a syntax match",
              });
            if (s.type === "lookup" && !d.lookups?.[s.table])
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message: `lookup ${s.table} isn't declared under lookups`,
              });
            if (
              s.type === "node" &&
              !["xpath", "jsonPath", "hclBlock"].includes(matchType(r.match))
            )
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message: "${node...} needs an xpath, jsonPath or hclBlock match",
              });
            if (
              s.type === "attr" &&
              !["annotation", "methodCall", "xpath", "jsonPath", "hclBlock"].includes(
                matchType(r.match),
              )
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["rules", i],
                message:
                  "${attr.*} needs an annotation, methodCall, xpath, jsonPath or hclBlock match",
              });
            }
          }
        }
      });
    });
    // A lookup's own templates can't look up another table.
    for (const [name, l] of Object.entries(d.lookups ?? {}))
      for (const t of [l.key, ...Object.values(l.values)]) {
        let sources;
        try {
          sources = templateSources(t);
        } catch {
          continue;
        }
        if (sources.some((x) => x.type === "lookup"))
          ctx.addIssue({
            code: "custom",
            path: ["lookups", name],
            message: "a lookup's templates can't use another lookup",
          });
      }
    if (d.rules.length === 0 && !d.plugin) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "a dialect needs rules or a plugin",
      });
    }
    if (d.extends.includes(d.name))
      ctx.addIssue({ code: "custom", path: ["extends"], message: "a dialect can't extend itself" });
    d.tests.forEach((t, i) => {
      if (!t.files === !t.fixture) {
        ctx.addIssue({
          code: "custom",
          path: ["tests", i],
          message: "a test has either files or fixture, not both or neither",
        });
      }
    });
  });
export type Dialect = z.infer<typeof Dialect>;
