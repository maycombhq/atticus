import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  answerQuestion,
  interfaceId,
  listQuestions,
  loadOrgPack,
  parseFacts,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
  type FactsJoinResult,
} from "@maycombhq/core";
import {
  estateRepos,
  factsSnapshotWrites,
  mergeEstate,
  readCatalog,
  writeCatalog,
} from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { joinLines, linkChanges, linkLines, mapRenderCommand } from "../src/map-render-commands.js";
import { writeReadPlan } from "../src/map-parts.js";
import { confirmed, seedReadersSlots } from "./seed-slots.js";
import { verifyCommand as verifyCommandRaw } from "../src/verify-commands.js";

// ADR 0195 (CS2): the first --write over a repo the readers read replaces its readers' records
// with its facts', a large removal a person confirms with the count listed: so do these tests.
const verifyCommand: typeof verifyCommandRaw = (root, repo, o, out) =>
  o.write
    ? confirmed(
        (x, allowRemovals) =>
          verifyCommandRaw(
            root,
            repo,
            { ...o, ...(allowRemovals !== undefined ? { allowRemovals } : {}) },
            x,
          ),
        out,
      )
    : verifyCommandRaw(root, repo, o, out);

/**
 * atticus verify <repo> --write and atticus map render <repo> (ADR 0124, A3b), end to end on an
 * invented two-repo Forge metarepo: the facts become the catalog everything downstream reads,
 * the flows go to specs/<repo>/, a call with no target becomes a question, and the map is
 * rendered under map/<repo>/. The written catalog, flows and map are golden files under
 * packages/verify/test/fixtures/map/ (UPDATE_GOLDEN=1 rewrites them after a review).
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const GOLDEN = join(VERIFY, "map");
const update = process.env.UPDATE_GOLDEN === "1";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

async function metarepo(facts?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atticus-map-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  // The catalog as a reader scan wrote it, before the assistant's facts: since ADR 0195 (CS2)
  // the readers' records are each repo's readers slot, and the build makes the catalog.
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    facts ?? readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  return root;
}

const write = (root: string, o = io()) =>
  verifyCommand(
    root,
    "forge-ledger",
    { commit: "0123abc", dir: join(root, "workspace", "forge-ledger"), write: true },
    o.io,
  );

const files = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), "utf8");
  };
  walk(dir, "");
  return out;
};

const stream = (records: CatalogRecord[]) => records.map(serializeRecord).join("---\n");

function golden(rel: string, text: string) {
  const path = join(GOLDEN, ...rel.split("/"));
  if (update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  expect(text, rel).toBe(readFileSync(path, "utf8"));
}

describe("atticus verify <repo> --write says what it wrote in a few lines", () => {
  it("counts the records by kind and the flows, and lists each only with --verbose", async () => {
    const root = await metarepo();
    const o = io();
    const code = await write(root, o);
    expect(code, o.err.join("\n")).toBe(0);
    const at = o.out.findIndex((l) => l.startsWith("Wrote the catalog for forge-ledger:"));
    expect(at).toBeGreaterThanOrEqual(0);
    const records = o.out[at + 1]!;
    // One line of counts by kind: + added, ~ changed, - removed.
    expect(records).toMatch(/^ {2}Records: [A-Z][A-Za-z]+ [+~-]\d+/);
    expect(records).toContain("Column +");
    expect(o.out[at + 2]).toBe("  Flows: 1 in specs/forge-ledger/.");
    expect(o.out[at + 3]).toBe(
      "  atticus verify forge-ledger --write --verbose lists each record and flow.",
    );
    // No record or flow file is listed one by one.
    expect(o.out.filter((l) => /^ {2}[+~-] [A-Z]/.test(l))).toEqual([]);
    expect(o.out.filter((l) => l.includes("specs/forge-ledger/ledger-api."))).toEqual([]);

    const v = io();
    const again = await metarepo();
    expect(
      await verifyCommand(
        again,
        "forge-ledger",
        {
          commit: "0123abc",
          dir: join(again, "workspace", "forge-ledger"),
          write: true,
          verbose: true,
        },
        v.io,
      ),
    ).toBe(0);
    expect(v.out.filter((l) => /^ {4}\+ Column\//.test(l)).length).toBeGreaterThan(0);
    expect(v.out).toContain("    specs/forge-ledger/ledger-api.post-a-ledger-entry.yaml");
    expect(v.out.some((l) => l.includes("--verbose lists"))).toBe(false);
  });

  it("gives the changes and the flows in full with --json", async () => {
    const root = await metarepo();
    const o = io();
    expect(
      await verifyCommand(
        root,
        "forge-ledger",
        {
          commit: "0123abc",
          dir: join(root, "workspace", "forge-ledger"),
          write: true,
          json: true,
        },
        o.io,
      ),
    ).toBe(0);
    const j = JSON.parse(o.out.join("\n")) as {
      written: {
        flows: string[];
        changes: { added: { kind: string; id: string }[]; byKind: Record<string, unknown> };
      };
    };
    expect(j.written.flows).toEqual(["specs/forge-ledger/ledger-api.post-a-ledger-entry.yaml"]);
    expect(j.written.changes.added.some((r) => r.kind === "Column")).toBe(true);
    expect(j.written.changes.byKind.Column).toMatchObject({ added: expect.any(Number) });
  });
});

describe("joinLines: what the estate join did for a write", () => {
  const end = (repo: string, fact: string, component: string, at: string) => ({
    repo,
    fact,
    component,
    at,
  });
  it("says how many calls were joined by method and path, inferred, and lists them with --verbose", () => {
    const join = {
      joins: [
        {
          call: end("forge-notes", "c-note", "forge-notes-web", "web/src/notes/notes-api.ts:5"),
          entry: end("forge-notes", "e-get-note", "forge-notes", "api/NoteController.java:14"),
          how: "path",
          inferred: { within: "repo", named: "notes-service" },
          callType: "rest",
          method: "GET",
          path: "/api/notes/{noteId}",
          interface: "if-74464cae7902572b",
        },
        {
          call: end("forge-notes", "c-tags", "forge-notes-web", "web/src/notes/notes-api.ts:9"),
          entry: end("forge-archive", "e-tags", "forge-archive", "src/TagController.java:18"),
          how: "path",
          inferred: { within: "estate" },
          callType: "rest",
          method: "GET",
          path: "/api/tags",
          interface: "if-0000000000000001",
        },
      ],
      asks: [],
      misses: [],
      lineage: [],
      gaps: [],
    } satisfies FactsJoinResult;
    const head = [
      "Joined across repos: 1 of forge-notes's calls to the entries that serve them, 0 calls of other repos into forge-notes, each citing both ends.",
      "Joined by method and path, inferred: 2 of forge-notes's calls name no target the estate has, so each joined the one entry that serves it (1 in forge-notes itself, 1 in another repo).",
    ];
    expect(joinLines("forge-notes", join)).toEqual(head);
    expect(joinLines("forge-notes", join, [], { verbose: true })).toEqual([
      ...head,
      "  web/src/notes/notes-api.ts:5 GET /api/notes/{noteId} (named notes-service) → forge-notes",
      "  web/src/notes/notes-api.ts:9 GET /api/tags → forge-archive (forge-archive)",
    ]);
  });
});

/**
 * J2: a write says what it did to the links between components, for review in the pull request:
 * the calls joined (and of those, inferred), asked, left outside and not joined, and each
 * Interface added, removed or changed in confidence, with how its callee was found.
 */
describe("linkChanges: the links a write added or removed (J2)", () => {
  const end = (repo: string, fact: string, component: string, at: string) => ({
    repo,
    fact,
    component,
    at,
  });
  const ids = {
    new: interfaceId("forge-notes-web", "forge-archive", "GET", "/api/tags"),
    kept: interfaceId("forge-notes-web", "forge-notes", "GET", "/api/tags"),
    gone: interfaceId("forge-notes-web", "forge-legacy", "GET", "/api/tags"),
  };
  const iface = (from: string, to: string, extra: object = {}): CatalogRecord => {
    const p = parseRecord({
      kind: "Interface",
      schemaVersion: 2,
      id: interfaceId(from, to, "GET", "/api/tags"),
      status: "current",
      confidence: "verified",
      from,
      to,
      via: "direct",
      method: "GET",
      normalizedPath: "/api/tags",
      sync: "sync",
      direction: "outbound",
      conflicts: [],
      evidence: [{ source: "code", repo: "forge-notes", path: "web/a.ts", line: 1 }],
      ...extra,
    });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  };
  const join = {
    joins: [
      {
        call: end("forge-notes", "c-tags", "forge-notes-web", "web/a.ts:9"),
        entry: end("forge-archive", "e-tags", "forge-archive", "src/Tags.java:18"),
        how: "path",
        inferred: { within: "estate" },
        callType: "rest",
        method: "GET",
        path: "/api/tags",
        interface: ids.new,
      },
      {
        call: end("forge-notes", "c-note", "forge-notes-web", "web/a.ts:5"),
        entry: end("forge-notes", "e-note", "forge-notes", "api/Notes.java:14"),
        how: "named",
        callType: "rest",
        method: "GET",
        path: "/api/notes",
        interface: ids.kept,
      },
      {
        call: end("forge-archive", "c-back", "forge-archive", "src/Back.java:3"),
        entry: end("forge-notes", "e-note", "forge-notes", "api/Notes.java:14"),
        how: "named",
        callType: "rest",
        path: "/api/notes",
        interface: "if-other",
      },
    ],
    asks: [
      {
        call: end("forge-notes", "c-host", "forge-notes-web", "web/a.ts:12"),
        reason: "unknown-host",
        host: "tags.internal",
        question: "Which repo answers on tags.internal?",
        candidates: [],
      },
    ],
    misses: [],
    outside: [
      {
        call: end("forge-notes", "c-pay", "forge-notes-web", "web/a.ts:20"),
        target: "Northwind Pay",
      },
    ],
    lineage: [],
    gaps: [],
  } satisfies FactsJoinResult;
  const before = [
    iface("forge-notes-web", "forge-legacy"),
    iface("forge-notes-web", "forge-notes"),
  ];
  const after = [
    iface("forge-notes-web", "forge-notes", { confidence: "inferred" }),
    iface("forge-notes-web", "forge-archive", {
      confidence: "inferred",
      flags: ["joined-by-path"],
    }),
  ];

  it("counts the repo's calls joined, inferred, asked, outside and not joined", () => {
    const l = linkChanges("forge-notes", join, before, after);
    expect(l.calls).toEqual({ joined: 2, inferred: 1, asked: 1, outside: 1, missed: 0 });
  });

  it("lists each Interface added, removed or changed in confidence, with how it was found", () => {
    const l = linkChanges("forge-notes", join, before, after);
    expect(l.added).toEqual([
      {
        id: ids.new,
        from: "forge-notes-web",
        to: "forge-archive",
        method: "GET",
        path: "/api/tags",
        confidence: "inferred",
        how: "path",
        flags: ["joined-by-path"],
      },
    ]);
    expect(l.removed.map((r) => `${r.id} ${r.confidence}`)).toEqual([`${ids.gone} verified`]);
    expect(l.changed).toEqual([
      {
        id: ids.kept,
        from: "forge-notes-web",
        to: "forge-notes",
        method: "GET",
        path: "/api/tags",
        confidence: "inferred",
        how: "named",
        was: { confidence: "verified" },
      },
    ]);
  });

  it("says it in a few lines, each link with its confidence and how it was found", () => {
    const l = linkChanges("forge-notes", join, before, after);
    expect(linkLines(l, "facts/forge-notes.verify.yaml")).toEqual([
      "  Links: 2 calls joined (1 inferred), 1 asked, 1 outside the estate, 0 not joined; Interfaces +1 -1 ~1 (all under links in facts/forge-notes.verify.yaml).",
      "    + forge-notes-web → forge-archive GET /api/tags (inferred; found by path: joined-by-path)",
      "    - forge-notes-web → forge-legacy GET /api/tags (verified)",
      "    ~ forge-notes-web → forge-notes GET /api/tags (inferred, was verified; found by name)",
    ]);
  });

  it("says a link is verified by another call when this repo's own call to it was found by path", () => {
    // forge-archive's call names forge-notes (cited, verified); forge-notes-web's own call to the
    // same Interface was only found by its path: the link is verified, this call's join a guess.
    const shared = interfaceId("forge-notes-web", "forge-notes", "GET", "/api/tags");
    const j = {
      ...join,
      joins: [
        {
          call: end("forge-notes", "c-tags2", "forge-notes-web", "web/b.ts:4"),
          entry: end("forge-notes", "e-tags", "forge-notes", "api/Tags.java:9"),
          how: "path",
          inferred: { within: "repo" },
          callType: "rest",
          method: "GET",
          path: "/api/tags",
          interface: shared,
        },
        {
          call: end("forge-notes", "c-tags", "forge-notes-web", "web/a.ts:9"),
          entry: end("forge-notes", "e-tags", "forge-notes", "api/Tags.java:9"),
          how: "named",
          callType: "rest",
          method: "GET",
          path: "/api/tags",
          interface: shared,
        },
      ],
      asks: [],
      outside: [],
    } satisfies FactsJoinResult;
    const linked = iface("forge-notes-web", "forge-notes", {
      flags: ["joined-by-name", "joined-by-path"],
    });
    const l = linkChanges("forge-notes", j, [], [linked]);
    expect(l.added[0]).toMatchObject({ confidence: "verified", how: "named" });
    expect(linkLines(l, "r.yaml")[1]).toBe(
      "    + forge-notes-web → forge-notes GET /api/tags (verified; found by name: joined-by-name, joined-by-path)",
    );
    // Only the guessed call is this repo's: the link is verified by the other repo's call.
    const theirs = {
      ...j,
      joins: [
        j.joins[0]!,
        { ...j.joins[1]!, call: end("forge-archive", "c-tags", "forge-archive", "src/T.java:2") },
      ],
    } satisfies FactsJoinResult;
    const l2 = linkChanges("forge-notes", theirs, [], [linked]);
    expect(l2.added[0]).toMatchObject({ how: "path", byOther: true });
    expect(linkLines(l2, "r.yaml")[1]).toBe(
      "    + forge-notes-web → forge-notes GET /api/tags (verified by another call; this one by path: joined-by-path)",
    );
  });

  it("says no link changed when none did", () => {
    const l = linkChanges(
      "forge-notes",
      { ...join, joins: [], asks: [], outside: [] },
      after,
      after,
    );
    expect(linkLines(l, "facts/forge-notes.verify.yaml")).toEqual([
      "  Links: 0 calls joined, 0 asked, 0 outside the estate, 0 not joined; no Interface added or removed.",
    ]);
  });
});

describe("atticus verify <repo> --write (ADR 0124, A3b)", () => {
  it("writes the catalog, the flows and the map, as the golden files", async () => {
    const root = await metarepo();
    const o = io();
    expect(await write(root, o)).toBe(0);
    expect(o.err).toEqual([]);
    const text = o.out.join("\n");
    expect(text).toMatch(/17 facts kept, 0 rejected/);
    expect(text).toMatch(/Wrote the catalog/);
    expect(text).toMatch(/map\/forge-ledger\/map\.md/);

    const catalog = await readCatalog(join(root, "catalog", "generated"));
    expect(catalog.problems).toEqual([]);
    golden("forge-ledger.catalog.yaml", stream(catalog.records));
    for (const [rel, t] of Object.entries(files(join(root, "specs", "forge-ledger"))))
      golden(`specs/forge-ledger/${rel}`, t);
    const map = files(join(root, "map", "forge-ledger"));
    expect(Object.keys(map)).toEqual([
      "contracts/ledger-api.openapi.yaml",
      "flows/ledger-api.post-a-ledger-entry.md",
      "map.md",
    ]);
    for (const [rel, t] of Object.entries(map)) golden(`expected/forge-ledger/${rel}`, t);

    // What map render read besides the catalog, for the renderer's own golden test.
    const report = parse(readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8"));
    const open = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions;
    golden(
      "inputs.json",
      JSON.stringify(
        {
          trust: {
            accepted: report.accepted,
            rejected: report.rejected,
            ratio: report.coverage.ratio,
            unknown: report.coverage.unknown.length,
            commit: report.commit,
          },
          questions: open.map((q) => ({ id: q.id, question: q.question, evidence: q.evidence })),
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("leaves every other repo's record files exactly as they were", async () => {
    const root = await metarepo();
    const before = files(join(root, "catalog", "generated"));
    expect(await write(root)).toBe(0);
    const after = files(join(root, "catalog", "generated"));
    const notifyOnly = Object.entries(before).filter(
      ([, t]) => t.includes("repo: forge-notify") && !t.includes("repo: forge-ledger"),
    );
    expect(notifyOnly.length).toBeGreaterThan(3);
    for (const [rel, t] of notifyOnly) expect(after[rel], rel).toBe(t);
  });

  it("writing the same facts again changes no file", async () => {
    const root = await metarepo();
    expect(await write(root)).toBe(0);
    const once = {
      ...files(join(root, "catalog")),
      ...files(join(root, "map")),
      ...files(join(root, "specs")),
    };
    const o = io();
    expect(await write(root, o)).toBe(0);
    const twice = {
      ...files(join(root, "catalog")),
      ...files(join(root, "map")),
      ...files(join(root, "specs")),
    };
    expect(twice).toEqual(once);
    expect(o.out.join("\n")).toMatch(/No catalog changes/);
  });

  it("writes nothing to the catalog while a fact is rejected", async () => {
    const root = await metarepo(
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8") +
        readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8"),
    );
    const before = files(join(root, "catalog", "generated"));
    const o = io();
    expect(await write(root, o)).toBe(1);
    expect(o.err.join("\n")).toMatch(/Nothing written: 11 facts were rejected/);
    expect(files(join(root, "catalog", "generated"))).toEqual(before);
    expect(existsSync(join(root, "map"))).toBe(false);
  });

  // Beta.26: a refused --write wrote nothing to the catalog but rewrote the facts file with only
  // the kept facts, stamped verified, so the next scan (or --write) projected the half-read repo.
  it("a refused --write leaves the facts file byte for byte as it was, and says why", async () => {
    const asRead = (
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8") +
      readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8")
    ).replaceAll('"verified":"line"', '"verified":"none"');
    const root = await metarepo(asRead);
    const factsFile = join(root, "facts", "forge-ledger.jsonl");
    const bytes = readFileSync(factsFile);
    const o = io();
    expect(await write(root, o)).toBe(1);
    expect(readFileSync(factsFile).equals(bytes)).toBe(true);
    expect(o.err.join("\n")).toMatch(
      /Nothing written: 11 facts were rejected, so facts\/forge-ledger\.jsonl and the catalog are left as they were/,
    );
    // What to fix is still written, and the verify report.
    expect(readFileSync(join(root, "facts", "forge-ledger.rejected.jsonl"), "utf8")).toMatch(
      /"code":/,
    );
    expect(existsSync(join(root, "facts", "forge-ledger.verify.yaml"))).toBe(true);
    // --json says the same, and leaves the file as it was too.
    const j = io();
    expect(
      await verifyCommand(
        root,
        "forge-ledger",
        {
          commit: "0123abc",
          dir: join(root, "workspace", "forge-ledger"),
          write: true,
          json: true,
        },
        j.io,
      ),
    ).toBe(1);
    expect(readFileSync(factsFile).equals(bytes)).toBe(true);
    // So a scan doesn't take the half-read repo from its facts: they aren't verified yet.
    const { factsForScan } = await import("@maycombhq/scanner");
    const op = await loadOrgPack(join(root, "org-pack"));
    const used = await factsForScan(root, op, "forge-ledger", "0123abc", []);
    expect(used.records).toBeUndefined();
    expect(used.note).toMatch(/aren't verified yet/);
  });

  it("plain verify (no --write) still keeps the kept facts and moves the rejected ones out (A3b)", async () => {
    const root = await metarepo(
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8") +
        readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8"),
    );
    const o = io();
    expect(
      await verifyCommand(
        root,
        "forge-ledger",
        { commit: "0123abc", dir: join(root, "workspace", "forge-ledger") },
        o.io,
      ),
    ).toBe(1);
    const ids = (file: string) =>
      readFileSync(join(root, "facts", file), "utf8")
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as {
              id?: string;
              code?: string;
              fact?: { id: string };
              verified?: string;
            },
        );
    const kept = ids("forge-ledger.jsonl");
    // A fact of another commit stays in the file (round 40); the rest move out.
    const rejected = ids("forge-ledger.rejected.jsonl").flatMap((r) =>
      r.fact && r.code !== "wrong-commit" ? [r.fact.id] : [],
    );
    expect(rejected.length).toBeGreaterThan(5);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.filter((f) => rejected.includes(f.id!))).toEqual([]);
    const other = ids("forge-ledger.rejected.jsonl").flatMap((r) =>
      r.fact && r.code === "wrong-commit" ? [r.fact.id] : [],
    );
    expect(kept.filter((f) => !other.includes(f.id!)).every((f) => f.verified === "line")).toBe(
      true,
    );
  });

  // App-only audit: one rejected fact held the repo; the app's Drop this fact writes the person's
  // correction that it is wrong (as Correct does), and Apply then writes the rest.
  it("writes the rest once a person marks the one rejected fact wrong", async () => {
    const bad = readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8").split("\n")[0]!;
    const root = await metarepo(
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8") + bad + "\n",
    );
    const o = io();
    expect(await write(root, o)).toBe(1);
    expect(o.err.join("\n")).toMatch(/Nothing written: 1 fact was rejected/);
    const f = JSON.parse(bad) as {
      id: string;
      kind: string;
      cite: { file: string; line: number; value: string };
    };
    const { correctionLine, FactCorrection } = await import("@maycombhq/core");
    const c = FactCorrection.parse({
      schemaVersion: 1,
      fact: f.id,
      target: { kind: f.kind, file: f.cite.file, line: f.cite.line, value: f.cite.value },
      action: "wrong",
      reason: "The controller was removed; this fact is stale.",
      by: "pat",
      at: "2026-11-09T09:00:00Z",
    });
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "facts"), { recursive: true });
    appendFileSync(join(root, "facts", "forge-ledger.corrections.jsonl"), correctionLine(c) + "\n");
    const again = io();
    expect(await write(root, again), again.err.join("\n")).toBe(0);
  });

  it("rejects a call-out step that names no call at verify, before anything is written (B-fixes)", async () => {
    // The B-stories-bench run: three flows' call-out steps named no call; the verifier kept them,
    // and --write wrote the catalog, then couldn't write the flows. Now the verifier rejects such
    // a flow, saying what to fix, and --write writes nothing until it is fixed.
    const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"ref":"c-fx-rate",',
      "",
    );
    const root = await metarepo(facts);
    const o = io();
    expect(await write(root, o)).toBe(1);
    const said = [...o.out, ...o.err].join("\n");
    expect(said).toMatch(/w-post-entry/);
    expect(said).toMatch(/step 2 is a call-out that names no fact/);
    expect(said).toMatch(/Nothing written: /);
    expect(existsSync(join(root, "specs", "forge-ledger"))).toBe(false);
  });

  it("without --write, only checks: the catalog and the map aren't touched", async () => {
    const root = await metarepo();
    const before = files(join(root, "catalog", "generated"));
    const o = io();
    const code = await verifyCommand(
      root,
      "forge-ledger",
      { commit: "0123abc", dir: join(root, "workspace", "forge-ledger") },
      o.io,
    );
    expect(code).toBe(0);
    expect(files(join(root, "catalog", "generated"))).toEqual(before);
    expect(existsSync(join(root, "map"))).toBe(false);
    expect(o.out.join("\n")).toMatch(/atticus verify forge-ledger --write/);
  });

  it("asks which repo answers on the host a call names, and joins it once answered (ADR 0088)", async () => {
    const root = await metarepo();
    const o = io();
    expect(await write(root, o)).toBe(0);
    const qs = (await listQuestions(root, { state: "open" })).questions;
    const q = qs.find((x) => x.question === "Which repo answers on notify.internal?")!;
    expect(q).toBeDefined();
    expect(q.rerun).toBe("atticus verify forge-ledger --write");
    expect(o.out.join("\n")).toContain(q.id);
    // J2: the links of the write, in the verify report for the pull request.
    const first = parse(readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8"));
    expect(first.links.calls).toEqual({ joined: 0, inferred: 0, asked: 1, outside: 1, missed: 0 });
    expect(o.out).toContain(
      "  Links: 0 calls joined, 1 asked, 1 outside the estate, 0 not joined; Interfaces +1 (all under links in facts/forge-ledger.verify.yaml).",
    );
    expect(o.out).toContain("    + ledger-api → northwind-fx GET /v1/rates/{} (verified)");
    const n = q.options.findIndex((x) => x.label === "forge-notify") + 1;
    await answerQuestion(root, q.id, { option: n, by: "dana.okafor", at: "2026-10-24T10:00:00Z" });
    const o2 = io();
    expect(await write(root, o2)).toBe(0);
    const second = parse(readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8"));
    // The answer's link is made by the merge from the host (forge-notify has no facts to join).
    expect(second.links.calls).toEqual({ joined: 0, inferred: 0, asked: 0, outside: 1, missed: 0 });
    expect(second.links.added).toEqual([
      expect.objectContaining({
        from: "ledger-api",
        to: "notify-api",
        method: "POST",
        path: "/notify",
        confidence: "verified",
      }),
    ]);
    expect(second.links.removed).toEqual([]);
    expect(o2.out).toContain("    + ledger-api → notify-api POST /notify (verified)");
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    expect(
      catalog.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
      ),
    ).toBe(true);
    const md = readFileSync(join(root, "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain("### notify-api");
    expect(md).not.toContain("Not joined yet");
  });

  it("asks which repo or system answers a call with no host, and reads the answer on the next write", async () => {
    const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"host":"notify.internal",',
      "",
    );
    const root = await metarepo(facts);
    expect(await write(root)).toBe(0);
    const qs = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions;
    const q = qs.find((x) => x.askedBy.step === "facts-targets")!;
    expect(q.question).toBe("Which repo or system answers POST /notify, which ledger-api calls?");
    expect(q.options.map((x) => x.label)).toEqual([
      "notify-api",
      "northwind-fx",
      "Another repo…",
      "None of these",
      "Ignore: not a real call (e.g. CI/CD, a test, a template)",
    ]);
    const md = readFileSync(join(root, "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain(`(../../questions/${q.id}.yaml)`);
    await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-10-24T10:00:00Z" });
    const w2 = io();
    expect(await write(root, w2), w2.err.join("\n")).toBe(0);
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    expect(
      catalog.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
      ),
    ).toBe(true);
  });
});

describe("an answer the code disagrees with opens again (ADR 0162, F8)", () => {
  const NOTIFY_HEAD = `0456def${"0".repeat(33)}`;
  /** forge-ledger's POST /notify asked and answered notify-api (option 1). */
  async function answered() {
    const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"host":"notify.internal",',
      "",
    );
    const root = await metarepo(facts);
    expect(await write(root)).toBe(0);
    const q = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions.find(
      (x) => x.askedBy.step === "facts-targets",
    )!;
    await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-10-24T10:00:00Z" });
    return { root, q };
  }
  /**
   * forge-notify read, serving only GET /status: nothing of it takes POST /notify. With a clone at
   * the facts' commit unless `clone` is false (then estate fresh says no-checkout).
   */
  function notifyRead(root: string, o: { clone?: boolean } = {}) {
    const text = `${JSON.stringify({
      kind: "entry",
      id: "entry.get.status",
      repo: "forge-notify",
      commit: "0456def",
      entryType: "rest",
      method: "GET",
      path: "/status",
      cite: {
        file: "src/Status.java",
        line: 3,
        value: "/status",
        quote: '@GetMapping("/status")',
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    })}\n`;
    writeFileSync(join(root, "facts", "forge-notify.jsonl"), text);
    // ADR 0195 (CS2): forge-notify is read when its verify --write took its facts snapshot; the
    // build joins only facts snapshots, never the assistant's working file.
    const p = parseFacts(text);
    if (!p.ok) throw new Error("bad facts");
    for (const w of factsSnapshotWrites(root, "forge-notify", p.facts, {
      commit: "0456def",
      contracts: null,
    })) {
      mkdirSync(dirname(w.path), { recursive: true });
      writeFileSync(w.path, w.text!);
    }
    if (o.clone === false) return;
    const git = join(root, "workspace", "forge-notify", ".git");
    mkdirSync(git, { recursive: true });
    writeFileSync(join(git, "HEAD"), `${NOTIFY_HEAD}\n`);
  }
  const stateOf = async (root: string, id: string) =>
    (await listQuestions(root, { repo: "forge-ledger" })).questions.find((x) => x.id === id)!;

  it("reopens the targets question once the repo it names is read and no route serves the call", async () => {
    const { root, q } = await answered();
    notifyRead(root);
    const o = io();
    expect(await write(root, o)).toBe(0);
    const again = await stateOf(root, q.id);
    expect(again.state).toBe("open");
    expect(again.answer).toBeUndefined();
    expect(again.reopened?.answer.option).toBe(1);
    expect(again.reopened?.why).toMatch(
      /^notify-api is read now, and no route of it serves the call: ledger-api calls POST \/notify on notify-api, and no entry of notify-api the facts name serves it \(/,
    );
    expect(o.out.some((l) => l.startsWith(`Asked again ${q.id}: notify-api is read now`))).toBe(
      true,
    );
  });

  it("keeps the answer a person gave again after it reopened (review item 2)", async () => {
    const { root, q } = await answered();
    notifyRead(root);
    const w9 = io();
    expect(await write(root, w9), w9.err.join("\n")).toBe(0);
    expect((await stateOf(root, q.id)).state).toBe("open");
    // The person looks and says the same again: it is their word, and it holds.
    await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-10-25T10:00:00Z" });
    const o = io();
    expect(await write(root, o)).toBe(0);
    const kept = await stateOf(root, q.id);
    expect(kept.state).toBe("answered");
    expect(kept.answer?.option).toBe(1);
    expect(kept.reopened?.answer.option).toBe(1);
    expect(o.out.some((l) => l.startsWith(`Asked again ${q.id}`))).toBe(false);
    // Another write leaves it too.
    expect(await write(root)).toBe(0);
    expect((await stateOf(root, q.id)).state).toBe("answered");
  });

  it("takes the same target in the person's own words as the same answer", async () => {
    const { root, q } = await answered();
    notifyRead(root);
    expect(await write(root)).toBe(0);
    await answerQuestion(root, q.id, {
      text: "notify-api",
      by: "dana.okafor",
      at: "2026-10-25T10:00:00Z",
    });
    expect(await write(root)).toBe(0);
    expect((await stateOf(root, q.id)).state).toBe("answered");
  });

  describe("only when the repo named is read whole and fresh (review item 9)", () => {
    it("holds the answer while the repo named has no clone to say its facts are fresh", async () => {
      const { root, q } = await answered();
      notifyRead(root, { clone: false });
      const o = io();
      expect(await write(root, o)).toBe(0);
      expect((await stateOf(root, q.id)).state).toBe("answered");
      expect(o.out.some((l) => l.startsWith(`Asked again ${q.id}`))).toBe(false);
    });

    it("holds the answer while the clone has moved past the facts' commit", async () => {
      const { root, q } = await answered();
      notifyRead(root);
      writeFileSync(
        join(root, "workspace", "forge-notify", ".git", "HEAD"),
        `0999fed${"0".repeat(33)}\n`,
      );
      expect(await write(root)).toBe(0);
      expect((await stateOf(root, q.id)).state).toBe("answered");
    });

    it("holds the answer while parts of the read plan are not read yet", async () => {
      const { root, q } = await answered();
      notifyRead(root);
      await writeReadPlan(root, "forge-notify", {
        commit: NOTIFY_HEAD,
        session: 100_000,
        parts: [
          { paths: ["src/**"], files: 1, tokens: 100 },
          { paths: ["routes/**"], files: 1, tokens: 100 },
        ],
      });
      expect(await write(root)).toBe(0);
      expect((await stateOf(root, q.id)).state).toBe("answered");
    });

    it("holds the answer while a second pass is planned and not read yet", async () => {
      const { root, q } = await answered();
      notifyRead(root);
      const gaps = join(root, "facts", "forge-notify.gaps.md");
      writeFileSync(gaps, "# the gaps pass\n");
      const later = new Date(Date.now() + 60_000);
      utimesSync(gaps, later, later);
      expect(await write(root)).toBe(0);
      expect((await stateOf(root, q.id)).state).toBe("answered");
    });
  });
});

/**
 * ADR 0124 addendum A-uncited. A trial on a 4,900-file repo found that `verify --write` rewrote
 * the assistant's own facts file with the facts stripped of every uncited `auth` — 221 of them —
 * and that a second run therefore said nothing was missing. The facts file keeps what its reader
 * wrote; only the catalog leaves the claim out; and the count is the same on every run.
 */
describe("atticus verify <repo> --write keeps the facts file whole (A-uncited)", () => {
  /** The fixture's facts with the one authCite taken off: an auth resting on no cited line. */
  const uncited = () =>
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      /,"authCite":\{[^}]*\}/,
      "",
    );
  const factsFile = (root: string) => join(root, "facts", "forge-ledger.jsonl");
  const reportOf = (root: string) =>
    parse(readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8")) as {
      authUncited?: { id: string; auth: string; cite: string }[];
    };
  /** The auth the catalog says for the account read: on its Endpoint, and on the Interface to it. */
  const catalogAuths = async (root: string) => {
    const catalog = await readCatalog(join(root, "catalog", "generated"));
    const auth = (kind: string, id: string) => {
      const r = catalog.records.find((x) => x.kind === kind && x.id === id) as unknown as
        { auth?: string } | undefined;
      expect(r, `${kind} ${id}`).toBeDefined();
      return r!.auth;
    };
    return {
      endpoint: auth("Endpoint", "ledger-api.get-account"),
      iface: auth("Interface", "if-3bbb3af22ed63158"),
    };
  };
  const said = (o: ReturnType<typeof io>) => o.out.join("\n");

  it("keeps the uncited auth in the facts file, leaves it out of the catalog, and says so on every run", async () => {
    expect(uncited()).not.toContain("authCite");
    const root = await metarepo(uncited());
    const reviewed = join(root, "facts", "forge-ledger.reviewed.jsonl");
    const reviewedText = `${JSON.stringify({ path: "README.md", why: "a readme holds no fact of what the repo serves" })}\n`;
    writeFileSync(reviewed, reviewedText);

    const first = io();
    expect(await write(root, first)).toBe(0);
    expect(said(first)).toMatch(/1 entry's auth rests on no cited line/);
    // what to do about it, and what was and wasn't kept
    expect(said(first)).toMatch(/give each entry an authCite/);
    expect(said(first)).toContain("kept in facts/forge-ledger.jsonl");
    expect(said(first)).toMatch(/left out of the catalog/);
    expect(reportOf(root).authUncited).toEqual([
      {
        id: "e-get-account",
        auth: "oauth2",
        cite: "src/main/java/forge/ledger/AccountController.java:18",
      },
    ]);
    // the claim is still in the reader's own file, and out of the catalog
    const afterFirst = readFileSync(factsFile(root), "utf8");
    expect(afterFirst).toContain('"auth":"oauth2"');
    expect(afterFirst).not.toContain("authCite");
    expect(await catalogAuths(root)).toEqual({ endpoint: undefined, iface: undefined });

    // Verify again, on the file the write left behind: the same count, not nothing.
    const second = io();
    expect(await write(root, second)).toBe(0);
    expect(said(second)).toMatch(/1 entry's auth rests on no cited line/);
    expect(reportOf(root).authUncited).toHaveLength(1);
    expect(readFileSync(factsFile(root), "utf8")).toBe(afterFirst);
    expect(await catalogAuths(root)).toEqual({ endpoint: undefined, iface: undefined });

    // A third run, in case the second were the stable one.
    expect(await write(root, io())).toBe(0);
    expect(reportOf(root).authUncited).toHaveLength(1);
    expect(readFileSync(factsFile(root), "utf8")).toBe(afterFirst);

    // Nothing else the run writes beside the facts was touched.
    expect(readFileSync(reviewed, "utf8")).toBe(reviewedText);
    expect(existsSync(join(root, "facts", "forge-ledger.rejected.jsonl"))).toBe(false);
  });

  it("puts the auth in the catalog once a line is cited, with nothing else changed", async () => {
    const root = await metarepo();
    expect(await write(root, io())).toBe(0);
    expect(reportOf(root).authUncited).toBeUndefined();
    expect(await catalogAuths(root)).toEqual({ endpoint: "oauth2", iface: "oauth2" });
    expect(readFileSync(factsFile(root), "utf8")).toContain("authCite");
  });
});

describe("the command line", () => {
  it("takes --write as a switch wherever it is, and routes atticus map render", async () => {
    const root = await metarepo();
    const dir = join(root, "workspace", "forge-ledger");
    const o = io();
    const code = await main(
      [
        "verify",
        "--write",
        "forge-ledger",
        "--json",
        "--commit",
        "0123abc",
        "--dir",
        dir,
        "--root",
        root,
        // ADR 0195 (CS2): the facts' read replaces the readers' (one record goes): confirmed.
        "--allow-removals",
        "1",
      ],
      o.io,
    );
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    const json = JSON.parse(o.out.join("\n")) as { accepted: number; written: { map: string[] } };
    expect(json.accepted).toBe(17);
    expect(json.written.map).toContain("map/forge-ledger/map.md");
    const r = io();
    expect(await main(["map", "render", "forge-ledger", "--root", root, "--json"], r.io)).toBe(0);
    expect(JSON.parse(r.out.join("\n")).files).toContain("map/forge-ledger/map.md");
  });

  it("reads --root right after --write (B-stories-bench run: it was taken as --write's value)", async () => {
    const root = await metarepo();
    const dir = join(root, "workspace", "forge-ledger");
    const o = io();
    const args = ["verify", "forge-ledger", "--write", "--root", root];
    // ADR 0195 (CS2): the one removal the facts' read makes is confirmed with its count.
    expect(
      await main([...args, "--commit", "0123abc", "--dir", dir, "--allow-removals", "1"], o.io),
      o.err.join("\n"),
    ).toBe(0);
    expect(o.out.join("\n")).toMatch(/Wrote the catalog for forge-ledger/);
  });
});

describe("atticus map render <repo>", () => {
  it("renders the same bytes from the catalog alone, and removes a page nothing renders any more", async () => {
    const root = await metarepo();
    expect(await write(root)).toBe(0);
    const before = files(join(root, "map", "forge-ledger"));
    writeFileSync(join(root, "map", "forge-ledger", "flows", "gone.md"), "an old flow\n");
    const o = io();
    expect(await mapRenderCommand(root, "forge-ledger", {}, o.io)).toBe(0);
    expect(files(join(root, "map", "forge-ledger"))).toEqual(before);
    expect(o.out.join("\n")).toMatch(/map\/forge-ledger\/map\.md/);
  });

  it("says what to run when the repo has nothing in the catalog yet", async () => {
    const root = await metarepo();
    const o = io();
    expect(await mapRenderCommand(root, "forge-unknown", {}, o.io)).toBe(2);
    expect(o.err.join("\n")).toMatch(/atticus verify forge-unknown --write/);
  });

  it("in a repo adopted in place, writes .atticus/map/ with links relative to the repo's own files", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-map-adopted-"));
    cpSync(join(VERIFY, "repo"), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack", "profiles", "forge"), { recursive: true });
    writeFileSync(
      join(root, ".atticus", "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "schemaVersion: 1\nplatform: forge\nrepos:\n  - { id: forge-ledger, url: ., type: spring-boot, owner: team-ledger, component: ledger-api }\n",
    );
    writeFileSync(
      join(root, ".atticus", "org-pack", "sources.yaml"),
      "schemaVersion: 1\nlayout: { catalog: .atticus/catalog, openspec: .atticus/openspec }\n",
    );
    mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
    writeFileSync(
      join(root, ".atticus", "facts", "forge-ledger.jsonl"),
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
    );
    const o = io();
    expect(
      await verifyCommand(root, "forge-ledger", { commit: "0123abc", write: true }, o.io),
    ).toBe(0);
    const md = readFileSync(join(root, ".atticus", "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain("](../../../src/main/java/forge/ledger/AccountController.java#L18)");
    expect(existsSync(join(root, ".atticus", "specs", "forge-ledger"))).toBe(true);
    expect(existsSync(join(root, ".atticus", "catalog", "generated", "endpoint"))).toBe(true);
  });
});

/**
 * Q1 and J6 end to end: the calls that go the same way are asked once and one answer joins them
 * all; an open question the code now answers retires itself, saying how.
 */
describe("atticus verify <repo> --write asks a call's target once per group (Q1, J6)", () => {
  const NOTIFIER = "src/main/java/forge/ledger/Notifier.java";
  const noHost = () =>
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"host":"notify.internal",',
      "",
    );
  /** Three calls under /notify with no host: the fixture's, and two more on the next lines. */
  async function threeCalls(): Promise<string> {
    const lines = noHost().trimEnd().split("\n");
    const notify = JSON.parse(lines.find((l) => l.includes('"id":"c-notify"'))!) as {
      cite: Record<string, unknown>;
    };
    const more = (id: string, path: string, line: number) =>
      JSON.stringify({
        ...notify,
        id,
        path,
        cite: { ...notify.cite, line, value: path, quote: `client.post("${path}", body);` },
      });
    const root = await metarepo(
      [
        ...lines,
        more("c-notify-batch", "/notify/batch", 10),
        more("c-notify-sms", "/notify/sms", 11),
      ].join("\n") + "\n",
    );
    const file = join(root, "workspace", "forge-ledger", NOTIFIER);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '    client.post("http://notify.internal/notify", body);\n',
        '    client.post("http://notify.internal/notify", body);\n    client.post("/notify/batch", body);\n    client.post("/notify/sms", body);\n',
      ),
    );
    return root;
  }

  it("asks the three /notify calls in one question, and one answer joins all three", async () => {
    const root = await threeCalls();
    const o = io();
    expect(await write(root, o)).toBe(0);
    const qs = (
      await listQuestions(root, { state: "open", repo: "forge-ledger", step: "facts-targets" })
    ).questions;
    expect(qs.map((q) => q.question)).toEqual([
      "Which repo or system answers the calls forge-ledger makes under /notify?",
    ]);
    const q = qs[0]!;
    expect(q.evidence).toEqual([`${NOTIFIER}:9`, `${NOTIFIER}:10`, `${NOTIFIER}:11`]);
    expect(o.out.join("\n")).toContain(`3 calls go the same way`);
    await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-10-30T10:00:00Z" });
    expect(await write(root)).toBe(0);
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    const into = catalog.filter(
      (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
    );
    expect(into.length).toBeGreaterThanOrEqual(3);
    // Nothing more is asked about them.
    expect(
      (await listQuestions(root, { state: "open", repo: "forge-ledger", step: "facts-targets" }))
        .questions,
    ).toEqual([]);
  });

  it("keeps an answered per-call question working, and groups only the calls left", async () => {
    const root = await metarepo(noHost());
    expect(await write(root)).toBe(0);
    const [own] = (await listQuestions(root, { state: "open", step: "facts-targets" })).questions;
    expect(own!.question).toBe(
      "Which repo or system answers POST /notify, which ledger-api calls?",
    );
    await answerQuestion(root, own!.id, {
      option: 1,
      by: "dana.okafor",
      at: "2026-10-30T10:00:00Z",
    });
    // Two more calls under /notify arrive: they are asked together, the answered one isn't.
    const grown = await threeCalls();
    cpSync(join(root, "questions"), join(grown, "questions"), { recursive: true });
    expect(await write(grown)).toBe(0);
    const open = (await listQuestions(grown, { state: "open", step: "facts-targets" })).questions;
    expect(open).toHaveLength(1);
    expect(open[0]!.evidence).toEqual([`${NOTIFIER}:10`, `${NOTIFIER}:11`]);
    expect((await listQuestions(grown, { state: "answered" })).questions.map((q) => q.id)).toEqual([
      own!.id,
    ]);
  });

  it("retires an open question once the call names its target in the code (J6)", async () => {
    const root = await metarepo(noHost());
    expect(await write(root)).toBe(0);
    const [q] = (await listQuestions(root, { state: "open", step: "facts-targets" })).questions;
    writeFileSync(
      join(root, "facts", "forge-ledger.jsonl"),
      noHost().replace('"id":"c-notify",', '"id":"c-notify","to":"notify-api",'),
    );
    const o = io();
    expect(await write(root, o)).toBe(0);
    const after = (await listQuestions(root, { step: "facts-targets" })).questions.find(
      (x) => x.id === q!.id,
    )!;
    expect(after.state).toBe("retired");
    expect(after.retired?.why).toBe("POST /notify now names notify-api in the code");
    expect(o.out.join("\n")).toContain(
      `Retired ${q!.id}: POST /notify now names notify-api in the code.`,
    );
  });

  it("answers by rule: the calls found later under the prefix join too, and nothing is asked (ADR 0153)", async () => {
    const root = await metarepo(noHost());
    expect(await write(root)).toBe(0);
    const [own] = (await listQuestions(root, { state: "open", step: "facts-targets" })).questions;
    await answerQuestion(root, own!.id, {
      option: 1,
      match: "/notify/**",
      by: "dana.okafor",
      at: "2026-10-30T10:00:00Z",
    });
    const grown = await threeCalls();
    cpSync(join(root, "questions"), join(grown, "questions"), { recursive: true });
    expect(await write(grown)).toBe(0);
    expect(
      (await listQuestions(grown, { state: "open", step: "facts-targets" })).questions,
    ).toEqual([]);
    const catalog = (await readCatalog(join(grown, "catalog", "generated"))).records;
    const into = catalog.filter(
      (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
    );
    expect(into.length).toBeGreaterThanOrEqual(3);
  });

  it("retires a call's own open question when its call is asked in a group now (Q1)", async () => {
    const root = await metarepo(noHost());
    expect(await write(root)).toBe(0);
    const [own] = (await listQuestions(root, { state: "open", step: "facts-targets" })).questions;
    const grown = await threeCalls();
    cpSync(join(root, "questions"), join(grown, "questions"), { recursive: true });
    expect(await write(grown)).toBe(0);
    const all = (await listQuestions(grown, { step: "facts-targets" })).questions;
    const group = all.find((x) => x.state === "open")!;
    expect(group.evidence).toHaveLength(3);
    expect(all.find((x) => x.id === own!.id)).toMatchObject({
      state: "retired",
      retired: { replacedBy: [group.id] },
    });
  });
});

/**
 * O1 end to end: a host no repo answers on is answered "an outside system (new)", the system
 * goes into the profile with the host as its alias, and the next write sends the calls to it.
 */
describe("a host question answered with an outside system (O1)", () => {
  it("writes the system into the profile, and the next write sends the call to it", async () => {
    const { questionsFiles } = await import("../src/question-commands.js");
    const root = await metarepo();
    expect(await write(root)).toBe(0);
    const q = (await listQuestions(root, { state: "open" })).questions.find(
      (x) => x.question === "Which repo answers on notify.internal?",
    )!;
    const n = q.options.findIndex((x) => x.label === "An outside system (new): another team's") + 1;
    expect(n).toBeGreaterThan(0);
    const a = io();
    expect(
      await questionsFiles(
        root,
        ["questions", "answer", q.id, "--option", String(n), "--by", "dana.okafor"],
        a.io,
        { now: new Date("2026-10-30T10:00:00Z") },
      ),
    ).toBe(0);
    expect(a.out).toContain(
      "Wrote the system notify-internal (boundary internal, alias notify.internal) into org-pack/profiles/forge/profile.yaml, so the calls to notify.internal go to it; review it in the same pull request, and give it a better name and an owner there if you like.",
    );
    const profile = readFileSync(
      join(root, "org-pack", "profiles", "forge", "profile.yaml"),
      "utf8",
    );
    expect(profile).toContain("id: northwind-fx");
    expect(profile).toContain("id: notify-internal");
    const o = io();
    expect(await write(root, o)).toBe(0);
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    expect(
      catalog.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-internal",
      ),
    ).toBe(true);
    expect(o.out.join("\n")).not.toContain("notify.internal?");
  });
});
