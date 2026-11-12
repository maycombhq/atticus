import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  cmpText,
  ENTRY_TYPES,
  Fact,
  factsDirOf,
  parseFactsLines,
  serializeFacts,
  SETTING_KINDS,
  writeFileAtomic,
  type CatalogRecord,
} from "@maycombhq/core";
import { readSlots, type BuildSlots } from "./build.js";
import { crossCheckKey, readCrossCheck } from "./crosscheck.js";
import { factsSlotPaths } from "./slots.js";

/**
 * Promote to assert (ADR 0195 point 3, ticket CS3): a person checks the line the built-in readers
 * cite for something the facts don't have, and Atticus writes it as that person's own fact
 * (`by: person`, `verified: none`) with the reader's citation, into the repo's live facts file
 * (`facts/<repo>.jsonl`), an edit to propose (ADR 0190). The fact is in the facts file's own
 * shape (C1's facts contract, ADR 0124, unchanged): nothing here changes a slot or the catalog.
 * The verifier then checks the claim on its line like any other fact, and it reaches the catalog
 * through the next successful `atticus verify <repo> --write`.
 *
 * Only what one fact says whole is promoted, from the reader's record and nothing else: an
 * Endpoint (an entry), an Interface (a call), a Setting (a config fact), a Column whose table the
 * facts already have as a store fact (a field of it), and an event the readers left unresolved (a
 * publish is a call, a subscribe an entry). Anything else is refused with why, and the person
 * dismisses it or has the assistant read the repo again. Files only: the cited line's text is
 * read from the repo's checkout by the caller, and only at the reader's commit.
 */

const posix = (p: string) => p.split(sep).join("/");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** The id of the fact promoting an item writes: the same key, the same id, whoever promotes it. */
export function promotedFactId(key: string): string {
  const kind = (key.split("|")[0] ?? "item").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `person-${kind || "item"}-${sha(key).slice(0, 12)}`;
}

export interface PromoteCite {
  file: string;
  line: number;
  /** What the verifier looks for on the line. */
  value: string;
  /** The line's text at the reader's commit, when the checkout has it. */
  text?: string;
  commit: string;
}

/** What promoting an item writes, or why it can't. */
export interface PromotePlan {
  repo: string;
  key: string;
  can: boolean;
  why?: string;
  /** The live facts file, relative to the root. */
  factsFile: string;
  fact?: string;
  factKind?: string;
  /** The fact's canonical JSON line. */
  line?: string;
  sha256?: string;
  cite?: PromoteCite;
  /** The facts file isn't there: it is started from the snapshot verify last kept. */
  fromSnapshot?: boolean;
  /** The same fact is in the facts file already: nothing to write. */
  already?: boolean;
  /** The facts file's text with the fact, when it is written. */
  next?: string;
}

/** Reads a line of the repo at a commit (1-based), or undefined when it can't. */
export type LineOf = (file: string, line: number, commit: string) => Promise<string | undefined>;

const lastSegment = (ref: string): string => ref.split(".").pop() ?? ref;

/** The evidence a fact cites: a code line of the reader's, else the first with a line. */
function citeOf(group: readonly CatalogRecord[]) {
  const all = group.flatMap((r) =>
    r.evidence.map((e) => ({ e, code: e.source === "code" ? 0 : 1 })),
  );
  all.sort((a, b) => a.code - b.code);
  return all.find((x) => x.e.line !== undefined && x.e.line > 0)?.e;
}

/** The fact a reader's record is, in the facts file's shape (without the common fields), or why not. */
function factBody(
  r: CatalogRecord,
  storeFacts: readonly Fact[],
): { body: Rec; value: string; alt?: string } | { why: string } {
  const x = r as unknown as Rec;
  switch (r.kind) {
    case "Endpoint": {
      const t = str(x.endpointType);
      const path = str(x.pathOrTopic);
      if (!t || !(ENTRY_TYPES as readonly string[]).includes(t) || !path)
        return { why: `an Endpoint of type ${t ?? "none"} isn't an entry fact` };
      return {
        body: {
          kind: "entry",
          entryType: t,
          ...(str(x.method) ? { method: str(x.method) } : {}),
          path,
          ...(str(x.component) ? { component: str(x.component) } : {}),
        },
        value: path,
      };
    }
    case "Interface": {
      const via = str(x.via);
      const callType =
        via === "direct" || via === "gateway" || via === "mesh"
          ? "rest"
          : via === "event-bus" || via === "pubsub"
            ? "event-topic"
            : via === "mq"
              ? "mq-queue"
              : via === "sftp"
                ? "sftp"
                : via === "webhook"
                  ? "webhook"
                  : undefined;
      const path = str(x.normalizedPath);
      if (!callType || !path) return { why: `an Interface via ${via ?? "none"} isn't a call fact` };
      return {
        body: {
          kind: "call",
          callType,
          ...(str(x.method) ? { method: str(x.method) } : {}),
          path,
          ...(str(x.to) ? { to: str(x.to) } : {}),
          ...(str(x.from) ? { component: str(x.from) } : {}),
          ...(x.sync === "sync" || x.sync === "async" ? { sync: x.sync } : {}),
        },
        value: path,
      };
    }
    case "Setting": {
      const key = str(x.key);
      const v = str(x.valueOrRef);
      if (!key) return { why: "a Setting with no key isn't a config fact" };
      const ref = v !== undefined && /^(env:|vault:|secret:|ref:|\$\{|\{\{)/.test(v);
      const kind = str(x.settingKind);
      return {
        body: {
          kind: "config",
          ...(kind && (SETTING_KINDS as readonly string[]).includes(kind)
            ? { settingKind: kind }
            : {}),
          key,
          ...(v !== undefined ? (ref ? { source: v } : { value: v }) : {}),
          ...(str(x.target) ? { target: str(x.target) } : {}),
          ...(str(x.env) ? { env: str(x.env) } : {}),
          ...(str(x.component) ? { component: str(x.component) } : {}),
        },
        value: key,
        alt: lastSegment(key),
      };
    }
    case "Column": {
      const table = lastSegment(str(x.table) ?? "");
      const name = str(x.name);
      const owner = storeFacts
        .filter((f) => f.kind === "store" && f.name === table)
        .sort((a, b) => cmpText(a.id, b.id))[0];
      if (!name) return { why: "a Column with no name isn't a field fact" };
      if (!owner)
        return {
          why: `a field fact belongs to a store fact, and the facts have none for the table ${table}: ask your assistant to read the repo again`,
        };
      return {
        body: {
          kind: "field",
          owner: owner.id,
          side: "column",
          name,
          ...(str(x.type) ? { type: str(x.type) } : {}),
          ...(x.nullable === false ? { required: true } : {}),
        },
        value: name,
      };
    }
    case "Unresolved": {
      const raw = str(x.raw);
      const owner = str(x.owner);
      if (raw && x.unresolvedKind === "event-publish")
        return {
          body: {
            kind: "call",
            callType: "event-topic",
            path: raw,
            sync: "async",
            ...(owner ? { component: owner } : {}),
          },
          value: raw,
        };
      if (raw && x.unresolvedKind === "event-subscribe")
        return {
          body: {
            kind: "entry",
            entryType: "event-topic",
            path: raw,
            ...(owner ? { component: owner } : {}),
          },
          value: raw,
        };
      return { why: `an unresolved ${str(x.unresolvedKind) ?? "item"} isn't one fact` };
    }
    default:
      return {
        why: `a ${r.kind} isn't one fact the readers' record says whole (an Endpoint, an Interface, a Setting, a Column, an event are)`,
      };
  }
}

async function readText(p: string): Promise<string | undefined> {
  return readFile(p, "utf8").then(
    (t) => t.replace(/\r\n?/g, "\n"),
    () => undefined,
  );
}

/** The facts the repo has now: the live facts file, else the snapshot verify last kept. */
async function factsNow(
  root: string,
  repo: string,
): Promise<{ text: string | undefined; facts: Fact[]; snapshot?: string }> {
  const live = await readText(join(factsDirOf(root), `${repo}.jsonl`));
  if (live !== undefined) return { text: live, facts: parseFactsLines(live).facts };
  const snap = await readText(factsSlotPaths(root, repo).facts);
  return { text: undefined, facts: snap ? parseFactsLines(snap).facts : [], snapshot: snap };
}

/**
 * What promoting the item `key` of `repo` writes (nothing is written here). Refused, with why,
 * unless the repo is compared, the item is one the readers found and the facts don't have, and
 * its record is one fact whole.
 */
export async function planPromote(
  root: string,
  repo: string,
  key: string,
  o: { lineOf?: LineOf; slots?: BuildSlots } = {},
): Promise<PromotePlan> {
  const factsFile = posix(relative(root, join(factsDirOf(root), `${repo}.jsonl`)));
  const no = (why: string): PromotePlan => ({ repo, key, can: false, why, factsFile });
  const slots = o.slots ?? (await readSlots(root));
  const view = await readCrossCheck(root, { repo, slots });
  const r = view.repos[0];
  if (!r) return no(`${repo} isn't a repo the manifests list`);
  if (r.state !== "compared") return no(`${repo} isn't compared (${r.state})`);
  const item = r.items.find((i) => i.key === key);
  if (!item || item.state !== "readers-only")
    return no(
      `${key} isn't an item the readers found that the facts don't have (atticus catalog crosscheck ${repo} lists them)`,
    );
  const slot = slots.readers.get(repo);
  if (!slot || "problem" in slot) return no(`${repo}'s readers slot doesn't read`);
  const group = slot.slot.records
    .filter((x) => crossCheckKey(x) === key)
    .sort((a, b) => cmpText(a.id, b.id));
  const rec = group.find((x) => x.evidence.some((e) => e.source === "code")) ?? group[0];
  const ev = citeOf(rec ? [rec, ...group.filter((g) => g !== rec)] : group);
  if (!rec || !ev?.path || !ev.line)
    return no(`the readers cite no line for ${key}, so there is nothing to check it on`);
  const commit = ev.commit ?? slot.slot.commit;
  if (!/^[0-9a-f]{7,64}$/.test(commit))
    return no(`the readers' commit (${commit}) isn't one a fact can be of`);
  const now = await factsNow(root, repo);
  const made = factBody(rec, now.facts);
  if ("why" in made) return no(`${made.why}. Dismiss it, or ask your assistant to read ${repo}`);
  const text = await o.lineOf?.(ev.path, ev.line, commit);
  const value =
    text !== undefined && !text.includes(made.value) && made.alt && text.includes(made.alt)
      ? made.alt
      : made.value;
  const quote = text?.trim();
  const id = promotedFactId(key);
  const parsed = Fact.safeParse({
    ...made.body,
    id,
    repo,
    commit,
    cite: {
      file: ev.path,
      line: ev.line,
      value,
      ...(quote && quote.length <= 200 ? { quote } : {}),
    },
    verified: "none",
    by: "person",
    conf: "declared",
  });
  if (!parsed.success)
    return no(
      `it isn't a fact the facts file takes: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  const line = serializeFacts([parsed.data]).trimEnd();
  const cite: PromoteCite = {
    file: ev.path,
    line: ev.line,
    value,
    ...(text !== undefined ? { text } : {}),
    commit,
  };
  const base: PromotePlan = {
    repo,
    key,
    can: true,
    factsFile,
    fact: id,
    factKind: parsed.data.kind,
    line,
    sha256: sha(line),
    cite,
  };
  const same = now.facts.find((f) => f.id === id);
  if (same) {
    // A promoted fact the verifier has since kept (verified: line) is the same claim.
    if (serializeFacts([{ ...same, verified: "none" }]).trimEnd() === line)
      return { ...base, already: true };
    return {
      ...no(`${factsFile} has a fact ${id} already, with another claim: put it right by hand`),
      fact: id,
    };
  }
  const start = now.text ?? now.snapshot ?? "";
  const next = `${start}${start && !start.endsWith("\n") ? "\n" : ""}${line}\n`;
  return { ...base, ...(now.text === undefined ? { fromSnapshot: true } : {}), next };
}

/** Write a plan's facts file (an edit to propose); nothing when it can't or is there already. */
export async function writePromote(root: string, plan: PromotePlan): Promise<boolean> {
  if (!plan.can || plan.already || plan.next === undefined) return false;
  await mkdir(factsDirOf(root), { recursive: true });
  await writeFileAtomic(join(factsDirOf(root), `${plan.repo}.jsonl`), plan.next);
  return true;
}

export interface PromotedState {
  fact: string;
  /** `written`: in the facts file, not verified yet; `verified`: kept on its line; `rejected`. */
  state: "written" | "verified" | "rejected";
  file: string;
  line: number;
  message?: string;
}

/**
 * Where each promoted fact of `keys` stands: in the facts file (verified on its line, or not yet)
 * or in `<repo>.rejected.jsonl` with why. Keys never promoted are left out.
 */
export async function promotedStates(
  root: string,
  repo: string,
  keys: readonly string[],
): Promise<Map<string, PromotedState>> {
  const out = new Map<string, PromotedState>();
  if (!keys.length) return out;
  const ids = new Map(keys.map((k) => [promotedFactId(k), k]));
  const live = await readText(join(factsDirOf(root), `${repo}.jsonl`));
  for (const f of live ? parseFactsLines(live).facts : []) {
    const key = ids.get(f.id);
    if (!key || f.by !== "person") continue;
    out.set(key, {
      fact: f.id,
      state: f.verified === "line" ? "verified" : "written",
      file: f.cite.file,
      line: f.cite.line,
    });
  }
  const rejected = await readText(join(factsDirOf(root), `${repo}.rejected.jsonl`));
  for (const l of (rejected ?? "").split("\n")) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as {
        code?: string;
        message?: string;
        fact?: { id?: string; cite?: { file?: string; line?: number } };
      };
      const key = j.fact?.id ? ids.get(j.fact.id) : undefined;
      if (!key || out.has(key)) continue;
      out.set(key, {
        fact: j.fact!.id!,
        state: "rejected",
        file: j.fact?.cite?.file ?? "",
        line: j.fact?.cite?.line ?? 0,
        message: `${j.code ? `${j.code}: ` : ""}${j.message ?? ""}`,
      });
    } catch {
      // A line that isn't JSON says nothing of a promoted fact.
    }
  }
  return out;
}
