import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import {
  diffCatalogFiles,
  diffCatalogs,
  endsGone,
  joinedArrowOf,
  looseEndsAt,
  movedArrows,
  pairedArrowsAt,
  readCatalog,
  rekeyedWords,
  sortCatalogRecords,
} from "@maycombhq/scanner";
import { codeLinkerFor, renderMap } from "@maycombhq/verify";
import { recordPath } from "@maycombhq/core";
import { linkChanges } from "../src/map-render-commands.js";

/**
 * The review of cbab428f (ADR 0205 step 4): in the app's server a writer's catalog parses are
 * kept deep-frozen and handed out without a copy, so a reader that changed one would throw. This
 * runs every reader the Apply hands them to (the comparison, the links, the guard's removal
 * words, the map) over frozen records of every kind the invented Forge catalog has, with loose
 * ends, a person's pairing and a rekeyed record added so the guard's branches run, and requires
 * each to give what it gives over copies nobody froze. Invented Forge estate (CLAUDE.md rule 3).
 */
const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "forge-beta26",
  "catalog",
  "generated",
);

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** The fixture's records, with what makes the guard's removal branches run. */
async function catalog(): Promise<CatalogRecord[]> {
  const { records } = await readCatalog(FIXTURE);
  const iface = records.find((r) => r.kind === "Interface")! as CatalogRecord & {
    from: string;
    evidence: { repo?: string; path?: string; line?: number; side?: string }[];
  };
  const caller = iface.evidence.find((e) => e.side === "caller") ?? iface.evidence[0]!;
  const loose = {
    ...structuredClone(records.find((r) => r.kind === "Endpoint")!),
    kind: "Unresolved",
    id: "unresolved-forge-1",
    owner: iface.from,
    unresolvedKind: "http-call",
    raw: "GET /ledger/balance",
    evidence: [structuredClone(caller)],
  } as unknown as CatalogRecord;
  return sortCatalogRecords([...records, loose]);
}

/** The build after a one-repo change: a pairing moved an arrow, a component rekeyed, one gone. */
function after(before: readonly CatalogRecord[]): CatalogRecord[] {
  const out = structuredClone([...before]) as (CatalogRecord & Record<string, unknown>)[];
  const i = out.findIndex((r) => r.kind === "Interface");
  const moved = out[i]! as CatalogRecord & Record<string, unknown>;
  out[i] = {
    ...moved,
    id: `${moved.id}-paired`,
    to: "audit-svc",
    flags: ["joined-by-person"],
  } as never;
  const c = out.findIndex((r) => r.kind === "Component");
  out[c] = { ...out[c]!, id: `${out[c]!.id}-renamed` } as never;
  const gone = out.findIndex((r) => r.kind === "Setting");
  if (gone >= 0) out.splice(gone, 1);
  return sortCatalogRecords(out as CatalogRecord[]);
}

/** Every reader's output over these records. */
function readAll(before: readonly CatalogRecord[], built: readonly CatalogRecord[]) {
  const was = new Map(before.map((r) => [recordPath(r), r] as const));
  const now = new Set(built.map((r) => `${r.kind}/${r.id}`));
  const removed = before.filter((r) => !now.has(`${r.kind}/${r.id}`));
  const added = built.filter((r) => !before.some((x) => x.kind === r.kind && x.id === r.id));
  const at = pairedArrowsAt(added);
  const loose = looseEndsAt(before);
  const ends = new Map([["portal-bff", ["forge-portal-bff"]]]);
  const changed = [
    ...new Set([...removed.map(recordPath), ...added.map(recordPath), ...was.keys()]),
  ].sort();
  const repos = [
    ...new Set(
      before.flatMap((r) => (r.kind === "Component" ? [(r as { repo?: string }).repo ?? ""] : [])),
    ),
  ];
  return {
    whole: diffCatalogs([...before], [...built]),
    files: diffCatalogFiles(
      { records: before, files: new Map([...was].map(([p, r]) => [p, { record: r }])) },
      built,
      changed,
    ),
    links: repos.map((repo) => linkChanges(repo, undefined, before, built)),
    moved: [...movedArrows(removed, added, before)],
    rekeyed: [...rekeyedWords(before, built)],
    joined: removed.map((r) => joinedArrowOf(r, at, loose)),
    gone: removed.map((r) => endsGone(r, ends, new Set(["forge-ledger"]))),
    maps: repos.map((repo) =>
      renderMap({
        repo,
        records: before,
        flows: [],
        paths: { map: `map/${repo}`, questions: "questions", specs: `specs/${repo}` },
        codeLink: codeLinkerFor({ dir: `workspace/${repo}` }),
      }),
    ),
  };
}

describe("the readers of a writer's kept catalog parses treat them as read-only (ADR 0205 step 4)", () => {
  it("gives over deep-frozen records what it gives over copies, and never throws", async () => {
    const records = await catalog();
    const built = after(records);
    const want = readAll(structuredClone(records), structuredClone(built));
    // As the server hands them out: the read's records frozen, every level; the build's not.
    const frozen = deepFreeze(structuredClone(records));
    expect(Object.isFrozen(frozen[0]!.evidence)).toBe(true);
    const got = readAll(frozen, structuredClone(built));
    expect(got).toEqual(want);
    // Each branch ran: the comparison saw changes, the guard's words had something to say.
    expect(want.whole.removed.length + want.whole.added.length).toBeGreaterThan(0);
    expect(want.links.some((l) => l.added.length + l.removed.length > 0)).toBe(true);
    expect(Object.keys(want.maps[0]!).length).toBeGreaterThan(0);
    expect(want.rekeyed.length, "a rekeyed record said").toBeGreaterThan(0);
    expect(want.moved.length, "a moved arrow said").toBeGreaterThan(0);
    // And the other way: the build's records frozen as the next read will hand them out.
    const both = readAll(frozen, deepFreeze(structuredClone(built)));
    expect(both).toEqual(want);
  });
});
