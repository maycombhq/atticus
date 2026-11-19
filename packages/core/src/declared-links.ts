import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { writeFileIfUnchanged } from "./fs.js";
import { changedLines, eolOf, inEol, lfOnly, type LineChange } from "./manifest-edit.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import {
  arrowEndKey,
  DeclaredCall,
  Profile,
  PROFILE_SCHEMA_VERSION,
  type ArrowEnd,
  type DeclaredLink,
} from "./schema/orgpack.js";
import { migrateProfileText } from "./profile-migrate.js";

/**
 * G3 (ADR 0174): what a person declares on the canvas that the code can't show, written to the
 * profile that has the system, comments and order kept, for review. A topic the system publishes
 * or listens on goes under its `topics` (ADR 0162: a publish or listener of the estate with no
 * counterpart lands on it, marked declared); a call it makes to a gateway route goes under its
 * `calls` (A-callers). Who declared it and when is the line's comment. Nothing here is a fact.
 */

export type Declared =
  | { kind: "topic"; system: string; topic: string; side: "publishes" | "listens" }
  | { kind: "call"; system: string; route: string }
  /** ADR 0200: several gateway routes in one write, one line each. */
  | { kind: "call"; system: string; routes: readonly string[] };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a declaration adds, each once, in a fixed order: the one topic or route, or (ADR 0200)
 * the routes sorted, whatever order they were picked in.
 */
function valuesOf(d: Declared): string[] {
  if (d.kind === "topic") return [d.topic.trim()];
  if (!("routes" in d)) return [d.route.trim()];
  return [...new Set(d.routes.map((r) => r.trim()))].sort(cmp);
}

export interface DeclaredOnFile {
  kind: "topic" | "call";
  system: string;
  /** The topic, or the route. */
  value: string;
  /** publishes or listens, for a topic declared from the canvas. */
  side?: "publishes" | "listens";
  /** Who declared it and when, from its comment; none for a line a person wrote by hand. */
  by?: string;
  at?: string;
}

export class DeclareError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "exists",
    message: string,
  ) {
    super(message);
  }
}

async function profilesOf(root: string): Promise<{ path: string; rel: string }[]> {
  const dir = join(orgPackDirOf(root), "profiles");
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const prefix = isAdopted(root) ? ".atticus/org-pack" : "org-pack";
  return names
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort()
    .map((n) => ({
      path: join(dir, n, "profile.yaml"),
      rel: `${prefix}/profiles/${n}/profile.yaml`,
    }));
}

async function systemNode(
  root: string,
  system: string,
): Promise<
  | {
      path: string;
      rel: string;
      raw: string;
      text: string;
      eol: "\r\n" | "\n";
      doc: Document;
      node: YAMLMap;
    }
  | undefined
> {
  for (const f of await profilesOf(root)) {
    const raw = await readFile(f.path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    // Compared as LF; written back in the file's own line endings (a Windows checkout's CRLF).
    const eol = eolOf(raw);
    const text = lfOnly(raw);
    const doc = parseDocument(text);
    const seq = doc.get("systems");
    if (!isSeq(seq)) continue;
    const node = seq.items.find((x) => isMap(x) && x.get("id") === system);
    if (isMap(node)) return { ...f, raw, text, eol, doc, node };
  }
  return undefined;
}

const COMMENT = /^\s*(publishes|listens)?\s*,?\s*declared by (.+?) on (\d{4}-\d{2}-\d{2})/;
/** The comment a System added from the canvas carries on its id (the review of beta.28.1, S3). */
const ADDED = /^\s*added from the canvas by (.+?) on (\d{4}-\d{2}-\d{2}) \(#([0-9a-f]{8})\)\s*$/;
/**
 * The re-review of beta.28.1: a short hash of the System as the canvas added it, in its comment,
 * so Undo takes it away only while it is still exactly that (no field a person changed since).
 */
export const addedHash = (s: Record<string, unknown>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(["id", "name", "boundary", "owner", "aliases"].map((k) => [k, s[k] ?? null])),
    )
    .digest("hex")
    .slice(0, 8);
export const addedComment = (by: string, at: string, hash: string) =>
  ` added from the canvas by ${by} on ${at.slice(0, 10)} (#${hash})`;

/** The comment a declaration carries: which side, who and when. */
export const declaredComment = (by: string, at: string, side?: "publishes" | "listens") =>
  ` ${side ? `${side}, ` : ""}declared by ${by} on ${at.slice(0, 10)}`;

/**
 * Write a declaration (or, with `preview`, say the lines it changes). The profile moves to
 * version 2 when a topic needs it; the whole profile is checked before it is written.
 */
export async function declareLink(
  root: string,
  d: Declared,
  o: {
    by: string;
    at: string;
    preview?: boolean;
    /**
     * Beta.28.1 (field report 4): a system no profile has yet, which the canvas draws for a repo
     * the manifest lists with no System of the profiles (the box takes the repo's id, or the
     * manifest's `system`): added to its platform's profile in the same write, so a person
     * declaring a link from that box never has to make the System first.
     */
    create?: { platform: string; name?: string; owner?: string };
  },
): Promise<{
  rel: string;
  changes: LineChange[];
  written: boolean;
  /** Beta.28: the file's bytes this write started from (what a take-back puts back). */
  before: string;
  /** The bytes it wrote (what a take-back expects to find). */
  wrote?: string;
  /** Beta.28.1: the system added to the profile first (`create`), when it had none. */
  created?: string;
}> {
  const found:
    | (NonNullable<Awaited<ReturnType<typeof systemNode>>> & {
        created?: true;
        disk?: string;
      })
    | undefined =
    (await systemNode(root, d.system)) ??
    (await newSystemNode(root, d.system, o.create, { by: o.by, at: o.at }));
  if (!found) throw new DeclareError("not-found", `No system of the profiles is ${d.system}.`);
  const { path, rel, raw, text, eol } = found;
  const doc = parseDocument(d.kind === "topic" ? migrateProfileText(text).text : text);
  const node = (doc.get("systems") as { items: unknown[] }).items.find(
    (x) => isMap(x) && x.get("id") === d.system,
  ) as YAMLMap;
  const field = d.kind === "topic" ? "topics" : "calls";
  let list = node.get(field);
  if (!isSeq(list)) {
    node.set(field, doc.createNode([]));
    list = node.get(field);
  }
  if (!isSeq(list)) throw new DeclareError("invalid", `${rel}: ${d.system} has no ${field} list.`);
  const values = valuesOf(d);
  if (!values.length || values.some((v) => !v))
    throw new DeclareError(
      "invalid",
      d.kind === "topic" ? "Say the topic first." : "Say the route first.",
    );
  const had = values.filter((value) =>
    (list as { items: unknown[] }).items.some((x) =>
      d.kind === "topic"
        ? isScalar(x) && String(x.value) === value
        : isMap(x) && x.get("route") === value,
    ),
  );
  if (had.length)
    throw new DeclareError(
      "exists",
      `${rel} already has ${had.join(", ")} under ${d.system}'s ${field}.`,
    );
  for (const value of values) {
    const item =
      d.kind === "topic"
        ? doc.createNode(value)
        : doc.createNode(DeclaredCall.parse({ route: value }));
    item.comment = declaredComment(o.by, o.at, d.kind === "topic" ? d.side : undefined);
    list.add(item);
  }
  // A profile the library can't write back (several documents, a YAML error) is refused whole.
  if (doc.errors.length)
    throw new DeclareError(
      "invalid",
      `${rel} doesn't read as one YAML document (${doc.errors[0]!.message.split("\n")[0]}): fix it, then declare again. Nothing written.`,
    );
  // Field hunt G5: the lines the declaration doesn't touch stay as the person wrote them.
  const after = keepUntouchedLines(found.created ? found.disk! : text, doc.toString(OPTS));
  const check = Profile.safeParse(doc.toJS());
  if (!check.success)
    throw new DeclareError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  // The re-review of G5: the text itself is checked, as it will be written, not the document.
  const written = strictMeaning(after);
  if (
    written === undefined ||
    !isDeepStrictEqual(written, doc.toJS()) ||
    !Profile.safeParse(written).success
  )
    throw new DeclareError(
      "invalid",
      `${rel}: the profile as it would be written doesn't read back as the same profile (a bug): nothing written.`,
    );
  // Against the file as it is on disk: a system added first is one of the lines it changes.
  const changes = changedLines(found.created ? found.disk! : text, after);
  const created = found.created ? { created: d.system } : {};
  if (o.preview) return { rel, changes, written: false, before: raw, ...created };
  const wrote = inEol(after, eol);
  await writeFileIfUnchanged(path, raw, wrote);
  return { rel, changes, written: true, before: raw, wrote, ...created };
}

/**
 * Beta.28.1 (field hunt G5): `after`, a whole document as the yaml library writes it, with every
 * line it has unchanged from `before` (the file as written, LF) given back as `before` wrote it:
 * a flow list's padding (`[dv, qa, prod]`), its quotes, its spacing. `before` as the library
 * writes it is lined up with `before` line for line (the library keeps the lines and comments of
 * a document it only reads); a line of `after` that is one of those, in order, is that line of
 * `before`. Where the two don't line up (the library joined or split a line), `after` as it is.
 */
export function keepUntouchedLines(written: string, after: string): string {
  // A file without a last newline is lined up as one with it, and written back without it.
  const open = !written.endsWith("\n");
  const before = open ? `${written}\n` : written;
  const norm = rewrite(before);
  if (norm === undefined) return after;
  const o = before.split("\n");
  const n = norm.split("\n");
  const a = after.split("\n");
  if (o.length !== n.length) return after;
  // The lines both share at either end, then the longest common run of the middle.
  let head = 0;
  while (head < n.length && head < a.length && n[head] === a[head]) head++;
  let tail = 0;
  while (
    tail < n.length - head &&
    tail < a.length - head &&
    n[n.length - 1 - tail] === a[a.length - 1 - tail]
  )
    tail++;
  const nm = n.slice(head, n.length - tail);
  const am = a.slice(head, a.length - tail);
  const w = am.length + 1;
  const lcs = new Uint32Array((nm.length + 1) * w);
  for (let i = nm.length - 1; i >= 0; i--)
    for (let j = am.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        nm[i] === am[j]
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const out = o.slice(0, head);
  let i = 0;
  let j = 0;
  while (j < am.length) {
    if (i < nm.length && nm[i] === am[j]) {
      out.push(o[head + i]!);
      i++;
      j++;
    } else if (i < nm.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else out.push(am[j++]!);
  }
  out.push(...o.slice(o.length - tail));
  const joined = out.join("\n");
  const kept = open && joined.endsWith("\n") ? joined.slice(0, -1) : joined;
  // The re-review of G5: lining up by count alone can put a line of a folded scalar where another
  // belongs (a key written twice, a value cut short, a key or a comment moved to another item).
  // What is kept must be, read again and written by the library, exactly `after`, and say what
  // it says read strictly (a key twice is an error); anything else is `after` as it is.
  const meaning = strictMeaning(kept);
  return meaning !== undefined &&
    rewrite(kept) === after &&
    isDeepStrictEqual(meaning, strictMeaning(after))
    ? kept
    : after;
}

const OPTS = { lineWidth: 0, flowCollectionPadding: true } as const;

/** A YAML text as the library writes it again (undefined where it doesn't read). */
function rewrite(text: string): string | undefined {
  try {
    const d = parseDocument(text);
    return d.errors.length ? undefined : d.toString(OPTS);
  } catch {
    return undefined;
  }
}

/** A YAML text's value, read strictly (a duplicate key, an alias to nothing, any error: undefined). */
function strictMeaning(text: string): unknown {
  try {
    const d = parseDocument(text, { uniqueKeys: true });
    return d.errors.length ? undefined : d.toJS();
  } catch {
    return undefined;
  }
}

/**
 * The profile of `create.platform` with the system added at the end of its systems (a product
 * system of the estate, its owner the repo's), as `systemNode` gives one; nothing is written
 * here. Undefined without `create`, or when that platform has no profile folder.
 */
async function newSystemNode(
  root: string,
  system: string,
  create: { platform: string; name?: string; owner?: string } | undefined,
  who: { by: string; at: string },
): Promise<
  | (NonNullable<Awaited<ReturnType<typeof systemNode>>> & { created: true; disk: string })
  | undefined
> {
  if (!create) return undefined;
  const f = (await profilesOf(root)).find((x) =>
    x.rel.endsWith(`/profiles/${create.platform}/profile.yaml`),
  );
  // N4: a platform with no profile yet is no dead end: the person is told the file to add.
  const rel = `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/profiles/${create.platform}/profile.yaml`;
  const raw = f ? await readFile(f.path, "utf8").catch(() => undefined) : undefined;
  if (!f || raw === undefined)
    throw new DeclareError(
      "not-found",
      `${system} is drawn for a repo of the ${create.platform} platform, which has no profile yet: add ${rel} (schemaVersion: 1, platform: ${create.platform}, a name, systems: []), then declare the link again; Atticus adds ${system} to it then.`,
    );
  const eol = eolOf(raw);
  const disk = lfOnly(raw);
  const doc = parseDocument(disk);
  let seq = doc.get("systems");
  if (!isSeq(seq)) {
    doc.set("systems", doc.createNode([]));
    seq = doc.get("systems");
  }
  if (!isSeq(seq)) return undefined;
  // An empty `systems: []` opens out into a block list, as a hand-written profile has.
  if (seq.items.length === 0) seq.flow = false;
  const fields = {
    id: system,
    name: create.name ?? system,
    boundary: "product",
    ...(create.owner ? { owner: create.owner } : {}),
    aliases: [],
  };
  const added = doc.createNode(fields) as YAMLMap;
  // Who added it and when, on its id's line, as a declaration says it (S3), with its hash.
  const id = added.items[0]!.value as { comment?: string | null };
  id.comment = addedComment(who.by, who.at, addedHash(fields));
  seq.add(added);
  if (doc.errors.length)
    throw new DeclareError(
      "invalid",
      `${rel} doesn't read as one YAML document (${doc.errors[0]!.message.split("\n")[0]}): fix it, then declare again. Nothing written.`,
    );
  const text = doc.toString(OPTS);
  const again = parseDocument(text);
  const node = (again.get("systems") as { items: unknown[] }).items.find(
    (x) => isMap(x) && x.get("id") === system,
  );
  if (!isMap(node)) return undefined;
  return { ...f, raw, text, eol, doc: again, node, created: true, disk };
}

/**
 * Undo: remove a declared topic or call from the system's list, exactly that one. Beta.28 (the
 * review of Edit the map): only that item's lines go (and the list's key when it was the last),
 * every other byte of the profile as it was: its comments, its flow lists, its version.
 */
export async function undeclareLink(
  root: string,
  d: { kind: "topic" | "call"; system: string; value: string },
  o: {
    /** A pairing or an answer names the system: a System the canvas added for it stays. */
    inUse?: boolean;
  } = {},
): Promise<{
  rel: string;
  changes: LineChange[];
  before: string;
  wrote: string;
  /** S3: the System the canvas added, taken away with its last declaration. */
  removed?: string;
}> {
  const found = await systemNode(root, d.system);
  if (!found) throw new DeclareError("not-found", `No system of the profiles is ${d.system}.`);
  const { path, rel, raw, text, eol, node } = found;
  const list = node.get(d.kind === "topic" ? "topics" : "calls");
  // Only what a person declared from the canvas (its comment says who and when): a line written
  // by hand in the profile is changed there, never by Undo.
  const i = isSeq(list)
    ? list.items.findIndex(
        (x) =>
          COMMENT.test((x as { comment?: string | null }).comment ?? "") &&
          (d.kind === "topic"
            ? isScalar(x) && String(x.value) === d.value
            : isMap(x) && x.get("route") === d.value),
      )
    : -1;
  if (!isSeq(list) || i < 0)
    throw new DeclareError(
      "not-found",
      `${rel} has no ${d.value} declared from the canvas under ${d.system} (removed already, or written by hand there).`,
    );
  let after = withoutItem(
    text,
    list.items[i] as { range?: [number, number, number] | null },
    list.items.length === 1,
  );
  // S3: a System the canvas added for a declaration goes with its last one, when nothing was
  // written under it since (no topic or call left, no alias, no key it wasn't added with).
  let removed: string | undefined;
  if (after !== undefined && list.items.length === 1 && !o.inUse) {
    const again = parseDocument(after);
    const systems = again.get("systems");
    const at = isSeq(systems)
      ? systems.items.findIndex((x) => isMap(x) && x.get("id") === d.system)
      : -1;
    const sys = isSeq(systems) ? systems.items[at] : undefined;
    if (isSeq(systems) && isMap(sys) && systems.items.length > 1) {
      const idNode = sys.items.find((p) => isScalar(p.key) && p.key.value === "id")?.value as
        { comment?: string | null } | undefined;
      const keys = sys.items.map((p) => (isScalar(p.key) ? String(p.key.value) : ""));
      const aliases = sys.get("aliases");
      const plain =
        keys.every((k) => ["id", "name", "boundary", "owner", "aliases"].includes(k)) &&
        (aliases === undefined || (isSeq(aliases) && aliases.items.length === 0));
      // Exactly as added: its fields hash to its comment's, and no comment but that one in its
      // lines (a person's note is a change too).
      const hash = ADDED.exec(idNode?.comment ?? "")?.[3];
      const [from, , end] = (sys as { range?: [number, number, number] | null }).range ?? [];
      const own = from !== undefined && end !== undefined ? after.slice(from, end) : "";
      const untouched =
        !!hash &&
        addedHash(sys.toJS(again) as Record<string, unknown>) === hash &&
        (own.match(/(^|\s)#(\s|$)/gm) ?? []).length === 1;
      if (untouched && plain) {
        const without = withoutItem(
          after,
          sys as { range?: [number, number, number] | null },
          false,
        );
        if (without !== undefined && Profile.safeParse(parseDocument(without).toJS()).success) {
          after = without;
          removed = d.system;
        }
      }
    }
  }
  const check = after === undefined ? undefined : Profile.safeParse(parseDocument(after).toJS());
  if (after === undefined || !check?.success)
    throw new DeclareError(
      "invalid",
      `${rel}: the declaration of ${d.value} isn't laid out as Declare writes it, so Atticus leaves the file alone: remove it there by hand.`,
    );
  const wrote = inEol(after, eol);
  await writeFileIfUnchanged(path, raw, wrote);
  return {
    rel,
    changes: changedLines(text, after),
    before: raw,
    wrote,
    ...(removed ? { removed } : {}),
  };
}

/**
 * The text without one block-sequence item: from its line's start (its `- ` indicator) through
 * every line indented under it (its own comment, the keys of a map), and the list's key line when
 * it was the only item. Undefined when the item isn't on lines of its own (a flow list).
 */
function withoutItem(
  text: string,
  item: { range?: [number, number, number] | null },
  last: boolean,
): string | undefined {
  const at = item.range?.[0];
  if (at === undefined) return undefined;
  const lines = text.split("\n");
  let pos = 0;
  let first = -1;
  for (let n = 0; n < lines.length; n++) {
    if (at >= pos && at <= pos + lines[n]!.length) {
      first = n;
      break;
    }
    pos += lines[n]!.length + 1;
  }
  if (first < 0) return undefined;
  const dash = /^(\s*)- /.exec(lines[first]!);
  if (!dash) return undefined;
  const col = dash[1]!.length;
  let end = first + 1;
  while (end < lines.length) {
    const l = lines[end]!;
    const indent = /^\s*/.exec(l)![0].length;
    if (l.trim() && indent <= col) break;
    if (!l.trim()) break;
    end++;
  }
  let from = first;
  // The last item: its list's key goes too (`calls:` alone on the line above).
  if (last && first > 0 && /^\s*(topics|calls|links):\s*$/.test(lines[first - 1]!))
    from = first - 1;
  return [...lines.slice(0, from), ...lines.slice(end)].join("\n");
}

/** A system's declarations, with who and when where the canvas wrote them. */
export async function declaredOf(
  root: string,
  system: string,
): Promise<{ rel?: string; list: DeclaredOnFile[] }> {
  const found = await systemNode(root, system);
  if (!found) return { list: [] };
  const out: DeclaredOnFile[] = [];
  const read = (comment: string | null | undefined) => {
    const m = COMMENT.exec(comment ?? "");
    return m
      ? { ...(m[1] ? { side: m[1] as "publishes" | "listens" } : {}), by: m[2]!, at: m[3]! }
      : {};
  };
  const topics = found.node.get("topics");
  if (isSeq(topics))
    for (const x of topics.items)
      if (isScalar(x))
        out.push({ kind: "topic", system, value: String(x.value), ...read(x.comment) });
  const calls = found.node.get("calls");
  if (isSeq(calls))
    for (const x of calls.items)
      if (isMap(x) && typeof x.get("route") === "string")
        out.push({ kind: "call", system, value: String(x.get("route")), ...read(x.comment) });
  return { rel: found.rel, list: out };
}

// ------------------------------------------------------------------ declared arrows (ADR 0204)

/** A declared arrow as a person asks for it: the two ends, why, and whether it is built yet. */
export interface ArrowAsked {
  from: ArrowEnd;
  to: ArrowEnd;
  why: string;
  planned?: boolean;
}

/** One declared arrow as the profiles hold it, with the file it is in. */
export interface DeclaredArrow extends DeclaredLink {
  platform: string;
  /** The profile, relative to the metarepo's org pack: `profiles/<platform>/profile.yaml`. */
  file: string;
}

/** Every declared arrow of the profiles, in the profiles' order then the file's. */
export function declaredArrows(op: {
  profiles: readonly { platform: string; profile?: { links?: readonly DeclaredLink[] } }[];
}): DeclaredArrow[] {
  return op.profiles.flatMap((p) =>
    (p.profile?.links ?? []).map((l) => ({
      ...l,
      platform: p.platform,
      file: `profiles/${p.platform}/profile.yaml`,
    })),
  );
}

const samePair = (x: unknown, from: ArrowEnd, to: ArrowEnd) => {
  if (!isMap(x)) return false;
  const v = x.toJSON() as { from?: ArrowEnd; to?: ArrowEnd };
  return (
    !!v.from &&
    !!v.to &&
    arrowEndKey(v.from) === arrowEndKey(from) &&
    arrowEndKey(v.to) === arrowEndKey(to)
  );
};

async function profileOf(root: string, platform: string) {
  const f = (await profilesOf(root)).find((x) =>
    x.rel.endsWith(`/profiles/${platform}/profile.yaml`),
  );
  const raw = f ? await readFile(f.path, "utf8").catch(() => undefined) : undefined;
  if (!f || raw === undefined)
    throw new DeclareError(
      "not-found",
      `The ${platform} platform has no profile.yaml yet: add it (schemaVersion: 1, platform: ${platform}, a name, systems: []), then declare the arrow again.`,
    );
  return { ...f, raw, eol: eolOf(raw), text: lfOnly(raw) };
}

/** The text as written, checked the way `declareLink` checks it: whole, the same profile. */
function checkedProfile(rel: string, before: string, doc: Document): string {
  if (doc.errors.length)
    throw new DeclareError(
      "invalid",
      `${rel} doesn't read as one YAML document (${doc.errors[0]!.message.split("\n")[0]}): fix it, then declare again. Nothing written.`,
    );
  const after = keepUntouchedLines(before, doc.toString(OPTS));
  const check = Profile.safeParse(doc.toJS());
  if (!check.success)
    throw new DeclareError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const written = strictMeaning(after);
  if (written === undefined || !isDeepStrictEqual(written, doc.toJS()))
    throw new DeclareError(
      "invalid",
      `${rel}: the profile as it would be written doesn't read back as the same profile (a bug): nothing written.`,
    );
  return after;
}

/**
 * ADR 0204 1.4: write a declared arrow as one item of the profile's `links` (or, with `preview`,
 * say the lines it changes), in `platform`'s profile: the caller's, else the callee's (the caller
 * works it out). The profile moves to version 3 (the number only); comments and order are kept,
 * and the write is refused whole if the file changed since it was read, or if the pair is listed.
 */
export async function declareArrow(
  root: string,
  a: ArrowAsked,
  o: {
    by: string;
    at: string;
    platform: string;
    preview?: boolean;
    /**
     * ADR 0204 3.1 (`add-system`): a system only the code names, added to this profile's systems
     * in the same write as the arrow, with who and when on its id (as the canvas adds one).
     */
    addSystem?: { id: string; name: string; boundary: "vendor" | "internal" };
  },
): Promise<{
  rel: string;
  changes: LineChange[];
  written: boolean;
  before: string;
  wrote?: string;
  /** The version the profile was at, when this write raised it (Undo puts it back). */
  raisedFrom?: number;
}> {
  const f = await profileOf(root, o.platform);
  const was = (parseDocument(f.text).toJS() as { schemaVersion?: unknown } | null)?.schemaVersion;
  const migrated = migrateProfileText(f.text, PROFILE_SCHEMA_VERSION);
  const raised = migrated.changed && typeof was === "number" ? { raisedFrom: was } : {};
  const doc = parseDocument(migrated.text);
  if (o.addSystem) {
    let seq = doc.get("systems");
    if (!isSeq(seq)) {
      doc.set("systems", doc.createNode([]));
      seq = doc.get("systems");
    }
    if (!isSeq(seq)) throw new DeclareError("invalid", `${f.rel}: its systems isn't a list.`);
    if (seq.items.some((x) => isMap(x) && x.get("id") === o.addSystem!.id))
      throw new DeclareError("exists", `${f.rel} has the system ${o.addSystem.id} already.`);
    if (seq.items.length === 0) seq.flow = false;
    const fields = { ...o.addSystem, aliases: [] };
    const added = doc.createNode(fields) as YAMLMap;
    (added.items[0]!.value as { comment?: string | null }).comment = addedComment(
      o.by,
      o.at,
      addedHash(fields),
    );
    seq.add(added);
  }
  let list = doc.get("links");
  if (!isSeq(list)) {
    doc.set("links", doc.createNode([]));
    list = doc.get("links");
  }
  if (!isSeq(list)) throw new DeclareError("invalid", `${f.rel}: its links isn't a list.`);
  if (list.items.some((x) => samePair(x, a.from, a.to)))
    throw new DeclareError(
      "exists",
      `${f.rel} already declares ${arrowEndKey(a.from)} → ${arrowEndKey(a.to)}.`,
    );
  const end = (e: ArrowEnd) => {
    const n = doc.createNode(e) as YAMLMap;
    n.flow = true;
    return n;
  };
  const item = doc.createNode({}) as YAMLMap;
  item.set("from", end(a.from));
  item.set("to", end(a.to));
  item.set("why", a.why.trim());
  item.set("by", o.by);
  item.set("at", o.at);
  if (a.planned) item.set("planned", true);
  list.add(item);
  const after = checkedProfile(f.rel, f.text, doc);
  const changes = changedLines(f.text, after);
  if (o.preview) return { rel: f.rel, changes, written: false, before: f.raw, ...raised };
  const wrote = inEol(after, f.eol);
  await writeFileIfUnchanged(f.path, f.raw, wrote);
  return { rel: f.rel, changes, written: true, before: f.raw, wrote, ...raised };
}

/**
 * ADR 0204 1.7 and 2.4: take one declared arrow out of `platform`'s profile (Retire the declared
 * arrow, Undo, Remove it): exactly that item's lines, and the `links:` key when it was the last;
 * every other byte as it was, the version too. `preview` says the lines and writes nothing.
 */
export async function retireArrow(
  root: string,
  a: { from: ArrowEnd; to: ArrowEnd },
  o: {
    platform: string;
    preview?: boolean;
    /**
     * Undo (ADR 0204 2.4): the version the arrow's write raised the profile from, put back on
     * its own line when no arrow is left, so the file is again exactly as it was.
     */
    lowerTo?: number;
  },
): Promise<{
  rel: string;
  changes: LineChange[];
  written: boolean;
  before: string;
  wrote: string;
}> {
  const f = await profileOf(root, o.platform);
  const doc = parseDocument(f.text);
  const list = doc.get("links");
  const i = isSeq(list) ? list.items.findIndex((x) => samePair(x, a.from, a.to)) : -1;
  if (!isSeq(list) || i < 0)
    throw new DeclareError(
      "not-found",
      `${f.rel} declares no arrow ${arrowEndKey(a.from)} → ${arrowEndKey(a.to)} (retired already?).`,
    );
  let after = withoutItem(
    f.text,
    list.items[i] as { range?: [number, number, number] | null },
    list.items.length === 1,
  );
  // The last arrow gone: back to the lowest version the profile needs (2 with topics, else 1),
  // so an older Atticus reads it again; an Undo puts back exactly the version it raised.
  const topics = (doc.toJS() as { systems?: { topics?: unknown[] }[] }).systems?.some(
    (x) => !!x.topics?.length,
  );
  const lowerTo = o.lowerTo ?? (topics ? 2 : 1);
  if (after !== undefined && isSeq(list) && list.items.length === 1)
    after = after.replace(
      new RegExp(`^schemaVersion:[ \\t]*${PROFILE_SCHEMA_VERSION}([ \\t]*(#.*)?)$`, "m"),
      `schemaVersion: ${lowerTo}$1`,
    );
  if (after === undefined || !Profile.safeParse(parseDocument(after).toJS()).success)
    throw new DeclareError(
      "invalid",
      `${f.rel}: that arrow isn't laid out as Connect writes it, so Atticus leaves the file alone: remove it there by hand.`,
    );
  const wrote = inEol(after, f.eol);
  const changes = changedLines(f.text, after);
  if (!o.preview) await writeFileIfUnchanged(f.path, f.raw, wrote);
  return { rel: f.rel, changes, written: !o.preview, before: f.raw, wrote };
}

/**
 * ADR 0204 2.4: Undo of an arrow whose write added a system (`addSystem`): the system goes too,
 * only while it is still exactly as added (its fields hash to its comment's) and nothing else
 * names it in the profile. Else it is left, and said by the caller.
 */
export async function removeAddedSystem(
  root: string,
  o: { platform: string; system: string },
): Promise<{ removed: boolean; rel: string }> {
  const f = await profileOf(root, o.platform);
  const doc = parseDocument(f.text);
  const seq = doc.get("systems");
  const sys = isSeq(seq) ? seq.items.find((x) => isMap(x) && x.get("id") === o.system) : undefined;
  if (!isSeq(seq) || !isMap(sys)) return { removed: false, rel: f.rel };
  const idNode = sys.items.find((p) => isScalar(p.key) && p.key.value === "id")?.value as
    { comment?: string | null } | undefined;
  const hash = ADDED.exec(idNode?.comment ?? "")?.[3];
  const links = (doc.toJS() as { links?: DeclaredLink[] }).links ?? [];
  const named = links.some((l) =>
    [l.from, l.to].some((e) => "system" in e && e.system === o.system),
  );
  if (!hash || addedHash(sys.toJS(doc) as Record<string, unknown>) !== hash || named)
    return { removed: false, rel: f.rel };
  const after = withoutItem(f.text, sys as { range?: [number, number, number] | null }, false);
  if (after === undefined || !Profile.safeParse(parseDocument(after).toJS()).success)
    return { removed: false, rel: f.rel };
  await writeFileIfUnchanged(f.path, f.raw, inEol(after, f.eol));
  return { removed: true, rel: f.rel };
}
