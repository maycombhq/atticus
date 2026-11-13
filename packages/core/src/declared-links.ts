import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { writeFileIfUnchanged } from "./fs.js";
import { changedLines, eolOf, inEol, lfOnly, type LineChange } from "./manifest-edit.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { DeclaredCall, Profile } from "./schema/orgpack.js";
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
  | { kind: "call"; system: string; route: string };

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
  o: { by: string; at: string; preview?: boolean },
): Promise<{
  rel: string;
  changes: LineChange[];
  written: boolean;
  /** Beta.28: the file's bytes this write started from (what a take-back puts back). */
  before: string;
  /** The bytes it wrote (what a take-back expects to find). */
  wrote?: string;
}> {
  const found = await systemNode(root, d.system);
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
  const value = d.kind === "topic" ? d.topic.trim() : d.route.trim();
  const has = list.items.some((x) =>
    d.kind === "topic"
      ? isScalar(x) && String(x.value) === value
      : isMap(x) && x.get("route") === value,
  );
  if (has)
    throw new DeclareError("exists", `${rel} already has ${value} under ${d.system}'s ${field}.`);
  const item =
    d.kind === "topic"
      ? doc.createNode(value)
      : doc.createNode(DeclaredCall.parse({ route: value }));
  item.comment = declaredComment(o.by, o.at, d.kind === "topic" ? d.side : undefined);
  list.add(item);
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
  const check = Profile.safeParse(doc.toJS());
  if (!check.success)
    throw new DeclareError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const changes = changedLines(text, after);
  if (o.preview) return { rel, changes, written: false, before: raw };
  const wrote = inEol(after, eol);
  await writeFileIfUnchanged(path, raw, wrote);
  return { rel, changes, written: true, before: raw, wrote };
}

/**
 * Undo: remove a declared topic or call from the system's list, exactly that one. Beta.28 (the
 * review of Edit the map): only that item's lines go (and the list's key when it was the last),
 * every other byte of the profile as it was: its comments, its flow lists, its version.
 */
export async function undeclareLink(
  root: string,
  d: { kind: "topic" | "call"; system: string; value: string },
): Promise<{ rel: string; changes: LineChange[]; before: string; wrote: string }> {
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
  const after = withoutItem(
    text,
    list.items[i] as { range?: [number, number, number] | null },
    list.items.length === 1,
  );
  const check = after === undefined ? undefined : Profile.safeParse(parseDocument(after).toJS());
  if (after === undefined || !check?.success)
    throw new DeclareError(
      "invalid",
      `${rel}: the declaration of ${d.value} isn't laid out as Declare writes it, so Atticus leaves the file alone: remove it there by hand.`,
    );
  const wrote = inEol(after, eol);
  await writeFileIfUnchanged(path, raw, wrote);
  return { rel, changes: changedLines(text, after), before: raw, wrote };
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
  if (last && first > 0 && /^\s*(topics|calls):\s*$/.test(lines[first - 1]!)) from = first - 1;
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
