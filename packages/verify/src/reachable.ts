import { citedFiles, type Fact } from "@maycombhq/core";
import { readingOrder, readingRank } from "./batches.js";

/**
 * Reachable-first reading of model classes (ADR 0169). A service repo can hold hundreds of
 * request, response and message classes; reading them all costs many sessions, and a reader
 * short of room marks whole folders "reviewed, nothing to record", sweeping the controllers away
 * with them. So the planner reads first the classes the repo's entry points and outbound calls
 * reach, and leaves out, recorded and said, the ones nothing reaches.
 *
 * Text only, no parser, the same patterns for Java, Kotlin, C#, TypeScript, Python and Go: the
 * identifiers a root file's text names that a model file declares (its basename, or a `class`,
 * `record`, `interface`, `type`, `struct` or `enum` line), then the identifiers inside those, until
 * nothing new is reached. Each model file is read once, so it is bounded by the repo's size, and
 * the order is fixed by the paths alone: the same files give the same answer. The assistant still
 * reads every reached file and cites each fact; this only chooses what it reads first.
 */

/** Code a model class is written in. */
const CODE = /\.(java|kt|kts|scala|groovy|cs|vb|fs|py|rb|go|rs|php|swift|ts|tsx|js|mjs|cjs|dart)$/i;
/** A folder of request, response and message classes. */
const MODEL_DIR = /(^|\/)(models?|dtos?|payloads?|schemas?|pojos?|beans|viewmodels?)\//i;
/** A class named for what it carries. */
const MODEL_NAME = /(dto|request|response|payload|model|body)$/i;
/** `create-listing.dto.ts`, `listing.model.ts`, `listing_schema.py`. */
const MODEL_PART = /[._-](dto|model|schema|payload|request|response)\.[^/.]+$/i;
/**
 * A class that maps a table (JPA, EF, Django, SQLAlchemy, TypeORM): its columns are store facts,
 * so it is never left out, whatever folder it sits in.
 */
const MAPS_TABLE =
  /@Entity\b|@Table\b|@Document\b|\[Table\(|__tablename__|models\.Model\b|@Entity\(|\bgorm\.Model\b/;
/** A name part that says a file serves or calls (NestJS, Angular and the like name files so). */
const ROOT_PART =
  /[._-](controller|resolver|gateway|handlers?|router|routes?|consumer|listener|subscriber|client|publisher|producer|endpoints?)\.[^/.]+$/i;
/** A client or publisher by its name or its folder. */
const CLIENT_NAME = /(client|gateway|publisher|producer|sender|feign|proxy|connector)$/i;
const CLIENT_DIR = /(^|\/)(clients?|gateways?|integrations?|publishers?|producers?|outbound)\//i;

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (path: string) => {
  const b = base(path);
  const dot = b.indexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
};

/**
 * Whether a file is a model class (a DTO, a request, a response, a payload, a schema): code, not
 * a test, in a model folder or named for one. With its text, a class that maps a table isn't.
 */
export function isModelFile(path: string, text?: string): boolean {
  if (!CODE.test(path) || readingRank(path) === 5) return false;
  if (!MODEL_DIR.test(path) && !MODEL_NAME.test(stem(path)) && !MODEL_PART.test(path)) return false;
  return text === undefined || !MAPS_TABLE.test(text);
}

/**
 * What names an entry point for certain: a controller, resource, route, handler, listener or
 * endpoint, by the file's name or folder. The planner ranks more files as entry points
 * (`readingRank` 2: a `main`, an `index`, an `...Api`, which a generated client is named too);
 * those are read first, but only these are never to be swept away as reviewed.
 */
const ENTRY_POINT_NAME =
  /(controller|resource|router|routes?|handlers?|listener|consumer|subscriber|endpoints?|servlet|webhook|resolver)$/i;
const ENTRY_POINT_DIR =
  /(^|\/)(controllers?|routes|routers|handlers|endpoints|listeners|consumers)\//i;
const ENTRY_POINT_PART =
  /[._-](controller|resolver|handlers?|router|routes?|consumer|listener|subscriber|endpoints?)\.[^/.]+$/i;

/**
 * Whether a file is an entry point (a controller, route, handler or listener) in code, not a
 * model and not a test: one a reviewed glob may never stand for (ADR 0169).
 */
export function isEntryPointFile(path: string): boolean {
  if (!CODE.test(path) || readingRank(path) === 5 || isModelFile(path)) return false;
  return (
    ENTRY_POINT_NAME.test(stem(path)) || ENTRY_POINT_DIR.test(path) || ENTRY_POINT_PART.test(path)
  );
}

/**
 * Whether a file is a root of reachability: an entry point (controllers, routes, handlers,
 * listeners) or a client or publisher, in code, and not a model itself.
 */
export function isRootFile(path: string): boolean {
  if (!CODE.test(path) || readingRank(path) === 5 || isModelFile(path)) return false;
  return (
    readingRank(path) === 2 ||
    isEntryPointFile(path) ||
    ROOT_PART.test(path) ||
    CLIENT_NAME.test(stem(path)) ||
    CLIENT_DIR.test(path)
  );
}

const DECLARES =
  /\b(?:class|record|interface|struct|enum|object)\s+([A-Za-z_][A-Za-z0-9_]*)|^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * The type names a model file declares: its basename when it reads as a type's (an upper-case
 * first letter, as Java, Kotlin and C# name files), then each declaration line's, in order.
 */
export function declaredTypes(path: string, text: string): string[] {
  const out: string[] = [];
  const s = stem(path);
  if (/^[A-Z][A-Za-z0-9_]*$/.test(s)) out.push(s);
  for (const m of text.matchAll(DECLARES)) {
    const n = m[1] ?? m[2];
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The identifiers a text names, each once, in the order they first appear. */
function identifiers(text: string): string[] {
  return [...new Set(text.match(IDENT) ?? [])];
}

/** A model file reached, the type names it declares that were named, and where from. */
export interface ReachedModel {
  path: string;
  types: string[];
  /** The file whose text first named it, or the id of the field fact whose type names it. */
  from: string;
}

export interface Reachability {
  /**
   * False when the repo has no entry point, client or fact to start from (a library of models):
   * then every model file is reached and none is left out.
   */
  rooted: boolean;
  /** The entry points and clients read for their types, in order. */
  roots: string[];
  /** The model files reached, in the order they were (the order a read takes them in). */
  reached: ReachedModel[];
  /** The model files nothing reaches, by path. */
  notReached: string[];
  /** Model files in all. */
  models: number;
}

/** Why a model file is left out, as the read plan records it. */
export const NOT_REACHED_WHY =
  "model classes no entry point, call or field fact reaches (ADR 0169): left out of the read; atticus map <repo> --models all reads them";

/**
 * The model files a repo's entry points and calls reach. `paths` are the files the read plans
 * (excluded ones already out); `read` gives a file's text. With `facts` (the repo is read), the
 * files its entries and calls cite are roots first, a model file a kept fact cites is reached
 * (it was read), and the types its field facts name are followed; the entry points and clients
 * no fact cites are still read for their types, so a read that swept its controllers away is put
 * right.
 */
export function reachableModels(o: {
  paths: readonly string[];
  read: (path: string) => string | undefined;
  facts?: readonly Fact[];
  /**
   * ADR 0170: reach from the repo's own entry points only (controllers, routes, handlers,
   * listeners, and what its entry facts cite), not from its outbound clients and calls.
   */
  from?: "entries";
}): Reachability {
  const texts = new Map<string, string>();
  const textOf = (p: string) => {
    if (!texts.has(p)) texts.set(p, o.read(p) ?? "");
    return texts.get(p)!;
  };
  const ordered = readingOrder(o.paths);
  const models = ordered.filter((p) => isModelFile(p, textOf(p))).sort();
  const isModel = new Set(models);
  // A type name to the model files that declare it, by path.
  const byName = new Map<string, string[]>();
  const declared = new Map<string, string[]>();
  for (const p of models) {
    const names = declaredTypes(p, textOf(p));
    declared.set(p, names);
    for (const n of names) byName.set(n, [...(byName.get(n) ?? []), p]);
  }
  const known = new Set(o.paths);
  const roots: string[] = [];
  const addRoot = (p: string) => {
    if (known.has(p) && !isModel.has(p) && !roots.includes(p)) roots.push(p);
  };
  const facts = o.facts ?? [];
  const entries = o.from === "entries";
  const calls = new Set(facts.filter((f) => f.kind === "call").map((f) => f.id));
  for (const f of facts)
    if (f.kind === "entry" || (f.kind === "call" && !entries))
      for (const p of citedFiles(f)) addRoot(p);
  for (const p of ordered) if (entries ? isEntryPointFile(p) : isRootFile(p)) addRoot(p);

  const reached = new Map<string, ReachedModel>();
  const queue: string[] = [];
  const reach = (names: readonly string[], from: string, own: readonly string[] = []) => {
    for (const n of names) {
      if (own.includes(n)) continue;
      for (const p of byName.get(n) ?? []) {
        const r = reached.get(p);
        if (r) {
          if (r.from === from && !r.types.includes(n)) r.types.push(n);
          continue;
        }
        reached.set(p, { path: p, types: [n], from });
        queue.push(p);
      }
    }
  };
  for (const p of roots) reach(identifiers(textOf(p)), p);
  for (const f of facts) {
    // A model file a kept fact cites was read; a field's type names the class it is.
    for (const p of citedFiles(f))
      if (isModel.has(p) && !reached.has(p)) {
        reached.set(p, { path: p, types: [...(declared.get(p) ?? []).slice(0, 1)], from: f.id });
        queue.push(p);
      }
    // ADR 0170: from the entry points only, a field a call owns (an outbound payload) is not followed.
    if (f.kind === "field" && !(entries && calls.has(f.owner)))
      reach(
        identifiers([f.type ?? "", f.transform === "message type" ? f.name : ""].join(" ")),
        f.id,
      );
  }
  const rooted = roots.length > 0 || reached.size > 0;
  if (!rooted)
    return {
      rooted,
      roots,
      reached: models.map((p) => ({ path: p, types: declared.get(p) ?? [], from: "" })),
      notReached: [],
      models: models.length,
    };
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    reach(identifiers(textOf(p)), p, declared.get(p));
  }
  return {
    rooted,
    roots,
    reached: queue.map((p) => reached.get(p)!),
    notReached: models.filter((p) => !reached.has(p)),
    models: models.length,
  };
}
