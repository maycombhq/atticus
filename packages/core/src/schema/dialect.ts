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
): "annotation" | "baseClass" | "methodCall" | "configKey" | "xpath" | "jsonPath" | "regex" {
  for (const k of [
    "annotation",
    "baseClass",
    "methodCall",
    "configKey",
    "xpath",
    "jsonPath",
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

export const DialectRule = z.strictObject({
  id: RecordId,
  description: z.string().min(1),
  match: DialectMatch,
  emit: DialectEmit,
  /** What a rule can claim: never "asserted", which is reserved for people. */
  confidence: Confidence.exclude(["asserted"]),
});
export type DialectRule = z.infer<typeof DialectRule>;

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
      repoTypes: z.array(RecordId).default([]),
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
      const shape = (RECORD_SCHEMAS[r.emit.kind] as unknown as { shape: Record<string, unknown> })
        .shape;
      for (const f of Object.keys(r.emit.fields)) {
        if (["kind", "id", "schemaVersion", "evidence", "confidence"].includes(f)) {
          ctx.addIssue({
            code: "custom",
            path: ["rules", i, "emit", "fields", f],
            message: `${f} is set by the engine, not by a rule`,
          });
        } else if (!(f in shape)) {
          ctx.addIssue({
            code: "custom",
            path: ["rules", i, "emit", "fields", f],
            message: `${r.emit.kind} has no field ${f} in contract C1`,
          });
        }
      }
      // Check each template uses only values this kind of match can supply.
      if (r.emit.kind === "Interface" && r.emit.id !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "emit", "id"],
          message: "Interface ids are derived (if-<hash>); leave id out",
        });
      }
      if (r.emit.kind !== "Interface" && r.emit.id === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "emit", "id"],
          message: `${r.emit.kind} needs an id template`,
        });
      }
      const templates = [
        ...(r.emit.id === undefined ? [] : [r.emit.id]),
        ...Object.values(r.emit.fields).flatMap((v) =>
          typeof v === "string" ? [v] : Array.isArray(v) ? v : [],
        ),
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
            !["regex", "configKey", "xpath", "jsonPath"].includes(matchType(r.match))
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["rules", i],
              message: "${match.N} needs a regex, configKey, xpath or jsonPath match",
            });
          }
          if (
            s.type === "attr" &&
            !["annotation", "methodCall", "xpath", "jsonPath"].includes(matchType(r.match))
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["rules", i],
              message: "${attr.*} needs an annotation, methodCall, xpath or jsonPath match",
            });
          }
        }
      }
    });
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
