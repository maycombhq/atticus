import { z } from "zod";

/**
 * Contract C6: the house conventions a read leans on (ADR 0147), `org-pack/conventions.yaml`.
 * A new, optional file: a pack without it reads with the defaults below, which are the lists
 * Atticus had written into its code before, so nothing changes until an organisation writes one.
 * Every key is optional; a key given replaces its default list whole (it doesn't add to it), so
 * an organisation can take a word out as well as put one in.
 */
export const CONVENTIONS_SCHEMA_VERSION = 1 as const;

/** A folder name or a short folder path (`src/test`), matched as whole path segments anywhere. */
const Folder = z
  .string()
  .trim()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      !p.includes("\\") &&
      !/[*?[\]{}]/.test(p) &&
      !p.split("/").some((s) => s === "" || s === "." || s === ".."),
    "a folder name or path inside a repo, such as tests or src/test: no slashes at either end, no glob",
  );
const Word = z.string().trim().min(1);

/** The folders an API spec is kept in, as a gateway's repo keeps its proxy's spec. */
export const DEFAULT_API_SPEC_FOLDERS = [
  "oas",
  "openapi",
  "swagger",
  "asyncapi",
  "api-spec",
  "api-specs",
  "apispec",
  "apispecs",
] as const;

/** The folders of a gateway's proxy bundles: an entry under one is a gateway route, whatever the repo. */
export const DEFAULT_GATEWAY_BUNDLE_FOLDERS = ["apiproxy", "sharedflowbundle"] as const;

/** The words a virtual host or a gateway's config uses for each side of the organisation. */
export const DEFAULT_FACING_WORDS = {
  internal: ["internal", "private", "intranet", "inside"],
  external: ["external", "partner", "public", "internet", "egress"],
} as const;

/** Folders whose files hold nothing of what a repo serves, calls or stores: tests and fixtures. */
export const DEFAULT_NOT_PRODUCT_FOLDERS = [
  "src/test",
  "src/it",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "spec",
  "specs",
  "e2e",
  "testdata",
  "test-data",
  "fixtures",
] as const;

/** Folders whose strings aren't the product's (generated, built, vendored), for the skipped-lines note. */
export const DEFAULT_NOT_READ_FOLDERS = [
  "generated",
  "generated-sources",
  "__generated__",
  "gen",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "node_modules",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  ".next",
  ".nuxt",
  "coverage",
] as const;

/**
 * A framework the organisation tells Atticus about (verify's framework table, ADR 0124 addendum
 * A-framework): what a declaration in a build file means. Looked at before the built-in table,
 * so an entry here can also say what a known declaration means in this house.
 */
export const ConventionFramework = z.strictObject({
  /** The declaration, group or scope and version aside; ending in `*` matches what starts with it. */
  declares: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\s*]+\*?$/, "a declaration such as forge-web-starter, or a prefix ending in *"),
  /** The name a framework fact for it must give. */
  name: z.string().trim().min(1),
  /** The reading rules it turns on: one of the reading protocol's framework parts (spring, express, house, ...). */
  topic: z
    .string()
    .regex(/^[a-z][a-z-]*$/)
    .optional(),
  /** What its patterns put in the facts, so a repo that declares it and shows none is a question. */
  shape: z.enum(["rest", "screen", "batch-job", "store"]).optional(),
});
export type ConventionFramework = z.infer<typeof ConventionFramework>;

/** An import prefix of the house's own packages: `com.forge.`, `@forge/`. */
const HousePrefix = z
  .string()
  .trim()
  .min(2)
  .regex(/^@?[\w.-]+(\/[\w.-]*)*$/, "a package or module prefix, such as com.forge. or @forge/");

export const Conventions = z.strictObject({
  schemaVersion: z.literal(CONVENTIONS_SCHEMA_VERSION),
  /** Folders whose YAML and JSON are API specs: code whatever their size, and read for routes. */
  apiSpecFolders: z.array(Folder).default([...DEFAULT_API_SPEC_FOLDERS]),
  /** Folders of a gateway's proxy bundles: an entry cited in one is a gateway route. */
  gatewayBundleFolders: z.array(Folder).default([...DEFAULT_GATEWAY_BUNDLE_FOLDERS]),
  /** The words that say which side a gateway faces (A-gateway2); internal is read first. */
  facing: z
    .strictObject({
      internal: z.array(Word).default([...DEFAULT_FACING_WORDS.internal]),
      external: z.array(Word).default([...DEFAULT_FACING_WORDS.external]),
    })
    .default({
      internal: [...DEFAULT_FACING_WORDS.internal],
      external: [...DEFAULT_FACING_WORDS.external],
    }),
  /** Frameworks the house builds on, looked at before the built-in table. */
  frameworks: z.array(ConventionFramework).default([]),
  /** Folders coverage doesn't count: tests, mocks, fixtures. */
  notProductFolders: z.array(Folder).default([...DEFAULT_NOT_PRODUCT_FOLDERS]),
  /** Folders verify doesn't look in for skipped paths, URLs and topics (R1). */
  notReadFolders: z.array(Folder).default([...DEFAULT_NOT_READ_FOLDERS]),
  /**
   * Import prefixes of the house's own packages. A repo importing one that no taught framework
   * (org-pack/frameworks/) covers is warned of before its first read (R3). None by default.
   */
  housePrefixes: z.array(HousePrefix).default([]),
});
export type Conventions = z.infer<typeof Conventions>;

/** The conventions of a pack without conventions.yaml: the built-in lists. */
export const DEFAULT_CONVENTIONS: Conventions = Conventions.parse({
  schemaVersion: CONVENTIONS_SCHEMA_VERSION,
});

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A test for a path under one of these folders, as whole segments anywhere in it: `(^|/)(a|b)/`.
 * `tail` follows the folder (default: anything). Matches nothing when the list is empty.
 */
export function underFolders(
  folders: readonly string[],
  o: { tail?: string; flags?: string } = {},
): RegExp {
  if (!folders.length) return /(?!)/;
  return new RegExp(`(^|/)(${folders.map(esc).join("|")})/${o.tail ?? ""}`, o.flags ?? "i");
}

/** An entry cited under one of these folders is a gateway route (default: the built-in bundle folders). */
export function gatewayBundleTest(folders?: readonly string[]): RegExp {
  return underFolders(folders ?? DEFAULT_GATEWAY_BUNDLE_FOLDERS, { flags: "" });
}
