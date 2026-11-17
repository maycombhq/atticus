import { isHeaderName } from "./facts-join-prototype.js";
import type { Fact, FactOf } from "./schema/facts.js";

/**
 * A field's place in its payload, built from the facts alone (ADR 0164, addendum of 2026-11-17).
 *
 * A reader writes one field fact per field of each class a payload is made of, each cited on its
 * declaration in the class's own file, by the name the field has there: `depot`, not
 * `receipt.stamps[].depot`. What says where a class sits is the field that holds it: a
 * field whose declared type names the class (`List<Stamp> stamps`). So, per
 * owner and side:
 *
 * - **A class** is the fields cited in one file (the verifier checked each on its line, so the
 *   file is the one thing about membership that is not the reader's choice of words). Where one
 *   file holds several classes, the fields whose id carries a type's name
 *   (`field.stamp.reason`) are that type's.
 * - **A parent** of a class is a field of the same owner and side whose type names it: the
 *   fact's `type`, and where that is left out the type the cited line declares for it. A list
 *   gives `[]`; a wrapper that only passes its value on (`Optional<X>`, `ResponseEntity<X>`) is
 *   no level. A map gives a place nobody can name (its keys are data). A class named inside any
 *   other generic type (`Page<Item>`) is placed through that type's own fields when they are on
 *   record (`Envelope<Order>` with `T content`), and has no place anyone can name when not.
 * - **A path** is the parent's path, then the field's name; through as many levels as the facts
 *   hold, at every place a class is reached from, never round a class that holds itself twice.
 * - **An envelope mapping** (`mappedTo` a field, `transform: envelope …`, ADR 0164 §2) places
 *   one field under another, as before; where the field's class is itself held, by type, by a
 *   field under that envelope, the type's path is the place (`data.customer.name`).
 * - **A dotted name** (`receipt.depot_token`) is the reader's own path: where it starts with the
 *   end of its class's place it is not prefixed again. It places itself only, never its siblings.
 * - **Roots**: every class no field points at that holds another class is a root (a body and
 *   an error body, a base class and the class that extends it): its fields are top-level.
 *
 * A field whose place isn't sure carries `unplaced`, the reason in words. Two kinds. A doubt that
 * only says *where* (a class nothing points at beside classes that hold others; classes that
 * only hold each other) matters only to a difference that depends on where: the check ignores
 * it when the other side has that name nowhere, or once. A doubt that `decides` (a map; a
 * generic type whose shape isn't on record; an envelope mapping and a type that name different
 * parents; a dotted name that doesn't fit its class's place; more places than are compared)
 * leaves any difference on the field unconfirmed.
 *
 * Pure: the same fields give the same places whatever order they come in. No file is read.
 */

type Field = FactOf<"field">;

/** One place a field has on the wire. */
export interface FieldPlace {
  /** The path from the payload's root: `receipt.stamps[].depot`. */
  name: string;
  /** The ids of the fields that hold it, from the root down. */
  via: string[];
  /** Why the place isn't sure, in words. */
  unplaced?: string;
  /** The doubt holds whatever the other side has: any difference on the field is unconfirmed. */
  decides?: true;
  /** The place is a second turn round a class that holds itself. */
  again?: true;
  /**
   * The path starts at a class nothing holds that holds others, and nothing on the way is in
   * doubt: built, not just written. `root` is that class (its file).
   */
  sure?: true;
  root?: string;
}

/** A class whose place in a payload isn't on record. */
export interface LooseClass {
  owner: string;
  side: string;
  /** The class as its file names it. */
  class: string;
  file: string;
  /** Its fields' ids. */
  fields: string[];
  why: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\]/g, "")
    .replace(/[^a-z0-9]/g, "");

/** A transform that says the field travels inside the field it is mapped to. */
const ENVELOPE = /\b(envelope|wrap(s|ped|per)?|inside|nested)\b/i;

/** The class a file is named for: `Stamp.java`, `parcel-item.dto.ts`. */
const classOfFile = (file: string) => (file.split("/").pop() ?? file).split(".")[0] ?? file;

/** The class part of an id: `field.case-note.text` → `casenote`. */
function classOfId(id: string): string | undefined {
  const parts = id.replace(/^field\./, "").split(".");
  if (parts.length < 2) return undefined;
  return norm(parts.slice(0, -1).join("")) || undefined;
}

const LISTS = new Set(
  "List ArrayList LinkedList Set HashSet LinkedHashSet TreeSet SortedSet Collection Iterable Iterator Stream Flux Queue Deque IEnumerable IList ICollection IReadOnlyList IReadOnlyCollection ISet ImmutableList ImmutableArray ImmutableSet Array ReadonlyArray MutableList MutableSet Sequence Seq Vec Slice list set tuple frozenset".split(
    " ",
  ),
);
const MAPS = new Set(
  "Map HashMap LinkedHashMap TreeMap SortedMap ConcurrentHashMap MutableMap Dictionary IDictionary IReadOnlyDictionary ImmutableDictionary Record Dict dict Mapping map".split(
    " ",
  ),
);
/** Wrappers that pass their value on and are no level of a payload. */
const PASS = new Set(
  "Optional Option Maybe Nullable Mono Single CompletableFuture CompletionStage Future Promise Task ValueTask Awaited Lazy Provider Supplier ResponseEntity HttpEntity ActionResult Partial Readonly Required Union Annotated Final Box Rc Arc".split(
    " ",
  ),
);

/** A class a type names, and how the type holds it. */
interface TypeRef {
  ident: string;
  /** `inside`: within a generic type that is no list, wrapper or map (`outer`). */
  kind: "one" | "list" | "map" | "inside";
  outer?: string;
}

/**
 * The identifiers a type names, each with how it is held: alone, in a list (`List<X>`, `X[]`,
 * `[]X`, `list[X]`, `repeated X`), in a map, or inside another generic type. A qualified name
 * counts by its last part; quoted values (an enum's) are left out.
 */
export function typeRefs(type: string): TypeRef[] {
  const s = type.replace(/(['"`])(?:(?!\1).)*\1/g, " ");
  const mapAll = /\bmap\s*\[[^\]]*\]/.test(s) || /\{\s*\[/.test(s);
  const listAll = /^\s*repeated\s/.test(s);
  const out: TypeRef[] = [];
  const stack: string[] = [];
  let array = false;
  const ident = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/y;
  const closesAt = (i: number) => {
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    return s[j] === "]" ? j : -1;
  };
  const refOf = (name: string, arrayAfter: boolean): TypeRef => {
    const unknown = [...stack]
      .reverse()
      .find((o) => o && !LISTS.has(o) && !MAPS.has(o) && !PASS.has(o));
    if (mapAll || stack.some((o) => MAPS.has(o))) return { ident: name, kind: "map" };
    if (unknown) return { ident: name, kind: "inside", outer: unknown };
    if (listAll || array || arrayAfter || stack.some((o) => LISTS.has(o)))
      return { ident: name, kind: "list" };
    return { ident: name, kind: "one" };
  };
  for (let i = 0; i < s.length;) {
    ident.lastIndex = i;
    const m = ident.exec(s);
    if (m) {
      const name = m[0].split(".").pop()!.trim();
      let j = i + m[0].length;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      const open = s[j] === "<" || (s[j] === "[" && closesAt(j) < 0);
      const arrayAfter = s[j] === "[" && closesAt(j) >= 0;
      out.push(refOf(name, arrayAfter));
      array = false;
      if (open) {
        stack.push(name);
        j++;
      }
      i = j;
      continue;
    }
    const c = s[i]!;
    if (c === "[") {
      const close = closesAt(i);
      if (close >= 0) {
        // `[]X` (Go) holds what follows; `X[]` was taken with its identifier.
        array = true;
        i = close + 1;
        continue;
      }
      stack.push("");
    } else if (c === "<") stack.push("");
    else if (c === ">" || c === "]") stack.pop();
    i++;
  }
  return out;
}

const NOT_A_TYPE =
  /^(private|public|protected|internal|final|static|readonly|val|var|let|const|def|new|return|required|virtual|override|volatile|transient|lateinit|open|abstract|sealed|data|export|declare|this|self|and|or|in|of)$/;

/** The type written just before position `end` of a line: `List<X>`, `X[]`, `a.b.X?`. */
function typeBefore(s: string, end: number): string | undefined {
  let i = end;
  while (i > 0 && /\s/.test(s[i - 1]!)) i--;
  const stop = i;
  // A type stands apart from the name: `view.status` and `foo(status` declare nothing.
  if (stop === end) return undefined;
  for (;;) {
    if (i > 0 && s[i - 1] === "?") i--;
    else if (i > 1 && s[i - 1] === "]" && s[i - 2] === "[") i -= 2;
    else break;
  }
  if (i > 0 && s[i - 1] === ">") {
    let depth = 0;
    while (i > 0) {
      i--;
      if (s[i] === ">") depth++;
      else if (s[i] === "<" && --depth === 0) break;
    }
    if (depth !== 0) return undefined;
  }
  const idEnd = i;
  while (i > 0 && /[\w.]/.test(s[i - 1]!)) i--;
  if (i === idEnd) return undefined;
  const ident = s.slice(i, idEnd);
  if (NOT_A_TYPE.test(ident) || /^\d/.test(ident) || ident.endsWith(".")) return undefined;
  // A call's argument or a string is no declaration: `foo(bar` , `"x" name`.
  return s.slice(i, stop);
}

/** The type written after `name:` (TypeScript, Kotlin, Python, Swift), up to its `=`, `,` or `;`. */
function typeAfterColon(rest: string): string | undefined {
  const m = /^\s*[?!]?\s*:\s*/.exec(rest);
  if (!m) return undefined;
  let depth = 0;
  let i = m[0].length;
  const from = i;
  for (; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "<" || c === "[" || c === "(") depth++;
    else if (c === ">" || c === "]" || c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "=" || c === "," || c === ";" || c === "{")) break;
  }
  const t = rest.slice(from, i).trim();
  return t || undefined;
}

/** The type written after a name with no colon (Go): `Notes []CaseNote`. */
function typeAfterName(rest: string): string | undefined {
  const m = /^[ \t]+((?:\[\s*\]|\*|map\[[^\]]*\])*[A-Za-z_][\w.]*)/.exec(rest);
  return m && !NOT_A_TYPE.test(m[1]!) ? m[1] : undefined;
}

/**
 * The type the cited line declares for the field, when the fact has none: the line's text is the
 * quote, the field the token that reads as its cited value or its name (`depotToken` for
 * `depot_token`). Java, C#, Kotlin, TypeScript, Python and Go forms; anything else gives nothing.
 */
export function declaredTypeOf(f: Pick<Field, "name" | "type" | "cite">): string | undefined {
  if (f.type) return f.type;
  const q = f.cite.quote;
  if (!q) return undefined;
  const want = new Set([norm(f.cite.value), norm(f.name.split(".").pop() ?? f.name)]);
  want.delete("");
  // The line's text with each string's inside blanked, so a name in a string is told apart.
  const code = q.replace(/(["'`])((?:(?!\1).)*)\1/g, (_, d: string, body: string) =>
    d === "`" ? `${d}${body}${d}` : `${d}${" ".repeat(body.length)}${d}`,
  );
  let inString = false;
  for (const m of q.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!want.has(norm(m[0]))) continue;
    if (code.slice(m.index, m.index + m[0].length).trim() === "") {
      inString = true;
      continue;
    }
    const rest = q.slice(m.index + m[0].length);
    const t = typeAfterColon(rest) ?? typeBefore(q, m.index) ?? typeAfterName(rest);
    if (t) return t;
  }
  // The wire name is only in a string (`@JsonProperty("stamps") private List<X> stampLines;`):
  // the declaration it sits on is the last identifier ahead of the line's `=` or `;`.
  if (inString) {
    const end = code.search(/[=;]/);
    const decl = end < 0 ? code : code.slice(0, end);
    const last = [...decl.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].pop();
    if (last && decl.slice(last.index + last[0].length).trim() === "")
      return typeBefore(q, last.index);
  }
  return undefined;
}

interface Group {
  id: string;
  /** The class in words. */
  name: string;
  file: string;
  fields: Field[];
}

interface Edge {
  parent: Field;
  kind: "one" | "list" | "map" | "inside";
  outer?: string;
  /**
   * For a class placed through a generic type's own field (`Result<Customer>`'s `T value`): the
   * field that named the generic type with this class as its argument. Only the places of
   * `parent` that pass through it are this class's.
   */
  holder?: string;
}

/** The levels a path is built through: a spec is read no deeper (intake's own limit is lower). */
const MAX_DEPTH = 10;
/** How far one walk up the parents may go before the classes are too tangled to place. */
const MAX_WALK = 300;
/** The places of one field that are compared; more than these is said, never silent. */
const MAX_PLACES = 64;
/** The steps one payload side may take: beyond these a class is too tangled to place. */
const MAX_STEPS = 50_000;

/** Whether a field is part of a body (not a header, which has no place in one). */
const inBody = (f: Field) => f.side === "message" || !isHeaderName(f.name);

export interface FieldPlaces {
  /** Each field's places, by id; a header's and a field with no class is its own name. */
  of: (f: Field) => FieldPlace[];
  /** The classes whose place isn't on record. */
  loose: () => Omit<LooseClass, "owner" | "side">[];
}

/**
 * The places of the fields of one owner and side (mapping facts between two payloads and a
 * mapper's dropped end left out by the caller).
 */
export function placeFields(input: readonly Field[], side: string): FieldPlaces {
  const fields = [...input].filter(inBody).sort((a, b) => cmp(a.id, b.id));
  const byId = new Map<string, Field>();
  for (const f of fields) if (!byId.has(f.id)) byId.set(f.id, f);

  // ---- classes: by file; a type no file is named for takes the fields whose id names it
  const fileClass = new Map<string, string>();
  for (const f of fields) fileClass.set(f.cite.file, norm(classOfFile(f.cite.file)));
  const filesOfClass = new Map<string, string[]>();
  for (const [file, c] of [...fileClass].sort((a, b) => cmp(a[0], b[0])))
    filesOfClass.set(c, [...(filesOfClass.get(c) ?? []), file]);
  const idClasses = new Set(fields.flatMap((f) => classOfId(f.id) ?? []));
  const refsOf = new Map<string, TypeRef[]>();
  for (const f of fields) refsOf.set(f.id, typeRefs(declaredTypeOf(f) ?? ""));
  const carved = new Map<string, string>();
  for (const f of fields)
    for (const r of refsOf.get(f.id)!) {
      const c = norm(r.ident);
      if (c && !filesOfClass.has(c) && idClasses.has(c) && !carved.has(c)) carved.set(c, r.ident);
    }
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  for (const f of fields) {
    const idc = classOfId(f.id);
    const own = idc && carved.has(idc) && fileClass.get(f.cite.file) !== idc;
    const id = own ? `class:${idc}` : `file:${f.cite.file}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        name: own ? carved.get(idc)! : classOfFile(f.cite.file),
        file: f.cite.file,
        fields: [],
      };
      groups.set(id, g);
    }
    g.fields.push(f);
    groupOf.set(f.id, g);
  }
  /** The class an identifier names: a file's (one file of that name only), else a carved one. */
  const classNamed = (ident: string): Group | undefined => {
    const c = norm(ident);
    const files = filesOfClass.get(c);
    return files?.length === 1
      ? groups.get(`file:${files[0]}`)
      : !files && carved.has(c)
        ? groups.get(`class:${c}`)
        : undefined;
  };

  // ---- parents: by type, and one field under another by an envelope mapping
  const typeParents = new Map<string, Edge[]>();
  const holds = new Set<string>();
  const addEdge = (g: Group, e: Edge) => {
    const list = typeParents.get(g.id) ?? [];
    if (list.some((x) => x.parent.id === e.parent.id && x.holder === e.holder)) return;
    list.push(e);
    typeParents.set(g.id, list);
    const mine = groupOf.get(e.parent.id)!;
    if (g !== mine) holds.add(mine.id);
  };
  /** A generic class's fields declared by a type variable (`T content`, `List<T> items`). */
  const variableFields = (g: Group): Edge[] =>
    g.fields.flatMap((q) => {
      const v = refsOf
        .get(q.id)!
        .find((r) => /^[A-Z][A-Z0-9]?$/.test(r.ident) && !classNamed(r.ident));
      return v && v.kind !== "inside" ? [{ parent: q, kind: v.kind }] : [];
    });
  for (const p of fields)
    for (const r of refsOf.get(p.id)!) {
      const g = classNamed(r.ident);
      if (!g) continue;
      if (r.kind !== "inside") {
        addEdge(g, { parent: p, kind: r.kind });
        continue;
      }
      // Inside a generic type: through that type's own fields when they are on record.
      const outer = classNamed(r.outer!);
      const through = outer && outer !== g ? variableFields(outer) : [];
      // One type variable and one argument class: which is which is plain. With two of either
      // (`Pair<Customer, Account>` with `L left; R right`) nothing on record says.
      const args = refsOf
        .get(p.id)!
        .filter((x) => x.kind === "inside" && x.outer === r.outer && classNamed(x.ident));
      if (through.length === 1 && new Set(args.map((x) => norm(x.ident))).size === 1)
        addEdge(g, { ...through[0]!, holder: p.id });
      else addEdge(g, { parent: p, kind: "inside", outer: r.outer! });
    }
  const envOf = (f: Field): Field | undefined => {
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    return t && t.id !== f.id && ENVELOPE.test(f.transform ?? "") ? t : undefined;
  };
  for (const f of fields) {
    const t = envOf(f);
    if (t && groupOf.get(t.id) !== groupOf.get(f.id)) holds.add(groupOf.get(t.id)!.id);
  }
  const dotted = (f: Field) => f.name.includes(".");
  /** A class's parents from other classes: what makes it reached. */
  const reached = (g: Group) =>
    (typeParents.get(g.id) ?? []).some((e) => groupOf.get(e.parent.id) !== g);

  // ---- the roots, and the classes that hang loose beside them
  // Every unreached class that holds another is a root: a body and an error body, a base class
  // and the class that extends it. One that holds nothing, beside such a root, hangs loose.
  const doubt = new Map<string, string>();
  const tops = [...groups.values()]
    .filter((g) => !reached(g) && g.fields.some((f) => !envOf(f) && !dotted(f)))
    .sort((a, b) => cmp(a.id, b.id));
  if (tops.length > 1 && tops.some((g) => holds.has(g.id)))
    for (const g of tops)
      if (!holds.has(g.id)) doubt.set(g.id, `${g.name} is not reached from the ${side}'s fields`);

  /** `parent` + `name`, a dotted name's start that repeats the parent's end written once. */
  const joinPath = (parent: string, name: string): { name: string; fits: boolean } => {
    const segs = name.split(".");
    if (segs.length === 1) return { name: `${parent}.${name}`, fits: true };
    const ps = parent.split(".").map(norm);
    const ns = segs.map(norm);
    for (let k = Math.min(ps.length, ns.length - 1); k > 0; k--)
      if (ps.slice(-k).join(".") === ns.slice(0, k).join("."))
        return { name: `${parent}.${segs.slice(k).join(".")}`, fits: true };
    return { name, fits: false };
  };

  interface Got {
    places: FieldPlace[];
    /** A cycle cut something: the result holds for this walk only. */
    cut: boolean;
  }
  const memo = new Map<string, FieldPlace[]>();
  let steps = 0;
  let spent = false;
  const decided = (why: string) => ({ unplaced: why, decides: true as const });
  const placesOf = (f: Field, stack: readonly string[]): Got => {
    if (stack.includes(f.id)) return { places: [], cut: true };
    const kept = memo.get(f.id);
    if (kept) return { places: kept, cut: false };
    if (++steps > MAX_STEPS || stack.length > MAX_WALK) {
      spent = true;
      return { places: [], cut: true };
    }
    const g = groupOf.get(f.id)!;
    const env = envOf(f);
    const byType = (typeParents.get(g.id) ?? [])
      .filter((e) => e.parent.id !== f.id)
      .sort((a, b) => cmp(a.parent.id, b.parent.id));
    const next = [...stack, f.id];
    let cut = false;
    /** The places under these parents, at most MAX_PLACES; `more` when some were left out. */
    const under = (edges: readonly Edge[], clash?: string) => {
      const out: FieldPlace[] = [];
      const seen = new Set<string>();
      let more = false;
      for (const e of edges) {
        if (out.length >= MAX_PLACES) {
          more = true;
          break;
        }
        const again = groupOf.get(e.parent.id) === g && e.parent !== env;
        const got = placesOf(e.parent, next);
        cut ||= got.cut;
        for (const q of got.places) {
          // A generic type's field holds this class only where its own holder named it.
          if (e.holder && !q.via.includes(e.holder)) continue;
          if (q.via.length >= MAX_DEPTH) {
            // Deeper than is compared: by its own name, and said.
            if (!seen.has("\u0000deep")) {
              seen.add("\u0000deep");
              out.push({
                name: f.name,
                via: [],
                ...decided(
                  `${g.name} sits more than ${MAX_DEPTH} levels deep, further than is compared`,
                ),
              });
            }
            continue;
          }
          const base = e.kind === "list" && !q.name.endsWith("[]") ? `${q.name}[]` : q.name;
          const j = joinPath(base, f.name);
          const k = norm(j.name.replace(/\./g, "\u0000"));
          if (seen.has(k)) continue;
          if (out.length >= MAX_PLACES) {
            more = true;
            break;
          }
          seen.add(k);
          const why =
            q.unplaced !== undefined
              ? { unplaced: q.unplaced, ...(q.decides ? { decides: true as const } : {}) }
              : clash
                ? decided(clash)
                : e.kind === "map"
                  ? decided(
                      `${g.name} is held in a map (${e.parent.name}), under keys only the data has`,
                    )
                  : e.kind === "inside"
                    ? decided(
                        `${g.name} is held inside ${e.outer}<…> (${e.parent.name}), whose shape isn't on record`,
                      )
                    : !j.fits
                      ? decided(
                          `its name ${f.name} doesn't start where its class ${g.name} sits (${base})`,
                        )
                      : {};
          out.push({
            name: j.name,
            via: [...q.via, e.parent.id],
            ...why,
            ...(again || q.again ? { again: true as const } : {}),
            ...(q.sure && !("unplaced" in why) ? { sure: true as const } : {}),
            ...(q.root ? { root: q.root } : {}),
          });
        }
      }
      // More places than are compared: a doubt about where, like a class nothing points at.
      return more
        ? out.map(({ sure: _sure, ...x }) => ({
            ...x,
            unplaced: x.unplaced ?? `${g.name} is at more places than the ${MAX_PLACES} compared`,
          }))
        : out;
    };
    let out: FieldPlace[];
    if (env && byType.length) {
      // Mapped to the envelope and held, by type, by a field: where that field sits under the
      // envelope the type's path is the place; where it doesn't, the two disagree.
      const typed = under(byType);
      out =
        typed.length && typed.every((x) => x.via.includes(env.id))
          ? typed
          : under(
              [{ parent: env, kind: "one" }],
              `a mapping puts it inside ${env.name} and its class ${g.name} is held by ${[...new Set(byType.map((e) => e.parent.name))].sort(cmp).join(", ")}`,
            );
    } else if (env) out = under([{ parent: env, kind: "one" }]);
    else if (byType.length) out = under(byType);
    else {
      const why = dotted(f) ? undefined : doubt.get(g.id);
      out = [
        {
          name: f.name,
          via: [],
          ...(why ? { unplaced: why } : {}),
          ...(!why && !dotted(f) && holds.has(g.id) ? { sure: true as const, root: g.id } : {}),
        },
      ];
    }
    if (!cut) memo.set(f.id, out);
    return { places: out, cut };
  };

  const of = (f: Field): FieldPlace[] => {
    if (!groupOf.has(f.id) || byId.get(f.id) !== f) return [{ name: f.name, via: [] }];
    const got = placesOf(f, []).places;
    if (got.length) return got;
    const g = groupOf.get(f.id)!;
    return [
      {
        name: f.name,
        via: [],
        ...(spent
          ? decided(`${g.name} is held in too many ways to follow`)
          : // Reached only round a ring of classes that hold each other: no place can be made.
            { unplaced: `${g.name} is reached only from classes it holds itself` }),
      },
    ];
  };
  const loose = () => {
    const out: Omit<LooseClass, "owner" | "side">[] = [];
    for (const g of [...groups.values()].sort((a, b) => cmp(a.id, b.id))) {
      const whys = new Set<string>();
      const ids: string[] = [];
      for (const f of g.fields) {
        const places = of(f);
        if (!places.length || !places.every((p) => p.unplaced)) continue;
        ids.push(f.id);
        whys.add(places[0]!.unplaced!);
      }
      if (ids.length)
        out.push({
          class: g.name,
          file: g.file,
          fields: ids.sort(cmp),
          why: [...whys].sort(cmp)[0]!,
        });
    }
    return out;
  };
  return { of, loose };
}

/**
 * The classes of a repo's payloads whose place isn't on record (for `atticus verify`): per entry
 * or call and side, each class no field of that payload reaches, with why. The fields are those
 * the contract check compares: a mapping between two payloads (a gateway policy's) and the end
 * of a mapper that doesn't travel are left out, as `checkContracts` leaves them.
 */
export function looseFieldClasses(facts: readonly Fact[]): LooseClass[] {
  const kinds = new Map<string, string>();
  for (const f of facts) if (!kinds.has(f.id)) kinds.set(f.id, f.kind);
  const all = facts.filter((f): f is Field => f.kind === "field");
  const byId = new Map<string, Field>();
  for (const f of all) if (!byId.has(f.id)) byId.set(f.id, f);
  const payload = (owner: string) => kinds.get(owner) === "entry" || kinds.get(owner) === "call";
  const sideOf = (f: Field) => f.side ?? "request";
  const out = new Set<string>();
  for (const f of all) {
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    if (!t || !payload(f.owner)) continue;
    if (t.owner !== f.owner) {
      // A mapping between two payloads.
      if (payload(t.owner)) {
        out.add(f.id);
        out.add(t.id);
      }
    } else if (sideOf(t) === sideOf(f) && !ENVELOPE.test(f.transform ?? "")) {
      // A mapper on one payload: outbound the target travels, inbound the source.
      const outbound =
        (kinds.get(f.owner) === "entry" && sideOf(f) === "response") ||
        (kinds.get(f.owner) === "call" && sideOf(f) !== "response");
      out.add(outbound ? f.id : t.id);
    }
  }
  const by = new Map<string, Field[]>();
  for (const f of all) {
    const side = sideOf(f);
    if (side !== "request" && side !== "response" && side !== "message") continue;
    if (!payload(f.owner) || out.has(f.id)) continue;
    if (side === "message" && /^message[- ]type$/i.test((f.transform ?? "").trim())) continue;
    const k = `${f.owner}\u0000${side}`;
    by.set(k, [...(by.get(k) ?? []), f]);
  }
  const loose: LooseClass[] = [];
  for (const [k, list] of [...by].sort((a, b) => cmp(a[0], b[0]))) {
    const [owner, side] = k.split("\u0000") as [string, string];
    for (const l of placeFields(list, side).loose()) loose.push({ owner, side, ...l });
  }
  return loose;
}
