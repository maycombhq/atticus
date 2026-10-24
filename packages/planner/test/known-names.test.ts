import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { GAP_STEP, gapQuestion, namesInCode } from "@maycombhq/index";
import { codeReaders, gapContext } from "../src/index.js";

/**
 * S1, T2 and U2, from one live run of a chat app's change, retold on the invented Forge Boards
 * repo (fixtures/names-in-code/forge-boards) and change (fixtures/names-in-code/pin-a-note):
 *
 * - S1: "names in code" cited the repo's docs/ plan for classes, and listed classes the code
 *   declares as gaps. A name is in the code when a source file declares it (the outline's
 *   class, interface, record, enum, function and type declarations), cited to that line; a word
 *   in prose, a comment or a use is not a declaration.
 * - T2: the change's own new endpoints, and file names of the repo (a Flyway migration, a
 *   controller's .java file), were asked about as gaps. What the change's target flows add is
 *   known; a file in a repo's tree, or a migration file the catalog records, is found.
 * - U2: a name a person answered about, for this change, came back as a gap. It is known, cited
 *   to the answer.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN = join(HERE, "fixtures/names-in-code");
const CHANGE = "pin-a-note";
const REL = `openspec/changes/${CHANGE}`;
const JAVA = "forge-boards:src/main/java/forge/boards";

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-known-names-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  await cp(join(OWN, "forge-boards"), join(r, "workspace/forge-boards"), { recursive: true });
  await cp(join(OWN, CHANGE), join(r, REL), { recursive: true });
  // A migration the catalog records, of a repo that isn't cloned here.
  const p = parseRecord({
    kind: "Migration",
    schemaVersion: 2,
    id: "forge-legacy-db.v3",
    status: "current",
    confidence: "verified",
    evidence: [
      {
        source: "migration",
        repo: "forge-legacy",
        path: "src/main/resources/db/migration/V3__legacy.sql",
        line: 1,
      },
    ],
    dataStore: "forge-legacy-db",
    version: "3",
    tool: "flyway",
    file: "src/main/resources/db/migration/V3__legacy.sql",
    operations: ["create table legacy_pin"],
  });
  if (!p.ok) throw new Error("bad fixture record");
  const f = join(r, "catalog/generated", recordPath(p.record));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
  return r;
}

async function answer(r: string, name: string, text: string, repo = CHANGE, id = "q-0a1b2c3d4e5f") {
  await mkdir(join(r, "questions"), { recursive: true });
  await writeFile(
    join(r, "questions", `${id}.yaml`),
    stringify({
      schemaVersion: 1,
      id,
      askedBy: {
        step: GAP_STEP,
        command: `atticus change stories ${repo}`,
        at: "2026-10-24T09:00:00Z",
      },
      repo,
      question: gapQuestion(name),
      options: [],
      evidence: [`${REL}/brief.md:3`],
      scope: { level: "repo", id: repo },
      state: "answered",
      rerun: `atticus change stories ${repo}`,
      answer: { text, by: "sam", at: "2026-10-24T10:00:00Z", scope: { level: "repo", id: repo } },
    }),
  );
}

describe("a name the code declares is in the code; prose isn't (S1)", () => {
  it("finds class, record and enum declarations in source files with their lines, and never a word in docs, a comment or a use", async () => {
    const r = await root();
    const got = await namesInCode(
      r,
      [
        "PinBoard",
        "BoardMember",
        "PinKind",
        "ArchiveSweeper",
        "AuthGate",
        "BoardArchiver",
        "BoardService",
      ],
      await codeReaders(),
    );
    expect(Object.fromEntries(got.found)).toEqual({
      PinBoard: `${JAVA}/PinBoard.java:4`,
      BoardMember: `${JAVA}/BoardMember.java:3`,
      PinKind: `${JAVA}/PinKind.java:3`,
    });
    expect(got.repos).toEqual(["forge-boards"]);
  });

  it("without a reader for declarations, no name is found by its words", async () => {
    const r = await root();
    const got = await namesInCode(r, ["PinBoard", "ArchiveSweeper"]);
    expect([...got.found.keys()]).toEqual([]);
  });
});

describe("the change's own names, the repo's files and answered names are not gaps (T2, U2)", () => {
  it("a file in a repo's tree is found by its path", async () => {
    const r = await root();
    const got = await namesInCode(
      r,
      ["V7__boards.sql", "BoardController.java", "Missing.java"],
      await codeReaders(),
    );
    expect(Object.fromEntries(got.found)).toEqual({
      "V7__boards.sql": "forge-boards:src/main/resources/db/migration/V7__boards.sql",
      "BoardController.java": `${JAVA}/BoardController.java`,
    });
  });

  it("lists as gaps only what neither the change's target flows, the code, the catalog's migrations nor an answer has", async () => {
    const r = await root();
    await answer(
      r,
      "PUT /api/boards/{id}/archive",
      "This change adds it: the trigger of the archive flow.",
    );
    // An answer for another change says nothing about this one.
    await answer(r, "AuthGate", "The gateway's filter.", "other-change", "q-1a1b2c3d4e5f");
    const g = await gapContext(r, CHANGE, [
      "PUT /api/boards/{boardId}/notes/{noteId}/pin",
      "DELETE /api/boards/{boardId}/pin",
      "forge-boards.pin-note",
      "Pin a note",
      "forge-boards-db.note_pin",
      "note_pin",
      "pinned_by",
      "forge-board-feed",
      "POST /feed/pins",
      "V7__boards.sql",
      "BoardController.java",
      "PinBoard",
      "V3__legacy.sql",
      "PUT /api/boards/{id}/archive",
      "ArchiveSweeper",
      "AuthGate",
      "BoardService",
      "Northwind Pay",
    ]);
    expect(g.gaps.map((x) => x.name)).toEqual([
      "ArchiveSweeper",
      "AuthGate",
      "BoardService",
      "Northwind Pay",
    ]);
    expect(g.inCode).toEqual([
      { name: "BoardController.java", at: `${JAVA}/BoardController.java` },
      { name: "PinBoard", at: `${JAVA}/PinBoard.java:4` },
      { name: "V7__boards.sql", at: "forge-boards:src/main/resources/db/migration/V7__boards.sql" },
    ]);
    const pin = `${REL}/target-flows/forge-boards.pin-note.yaml`;
    const unpin = `${REL}/target-flows/forge-boards.unpin-note.yaml`;
    expect(g.known).toEqual([
      { name: "DELETE /api/boards/{boardId}/pin", at: `${unpin}:9`, how: "target-flow" },
      { name: "forge-board-feed", at: `${pin}:28`, how: "target-flow" },
      { name: "forge-boards-db.note_pin", at: `${pin}:17`, how: "target-flow" },
      { name: "forge-boards.pin-note", at: `${pin}:2`, how: "target-flow" },
      { name: "note_pin", at: `${pin}:17`, how: "target-flow" },
      { name: "Pin a note", at: `${pin}:5`, how: "target-flow" },
      { name: "pinned_by", at: `${pin}:18`, how: "target-flow" },
      { name: "POST /feed/pins", at: `${pin}:28`, how: "target-flow" },
      { name: "PUT /api/boards/{boardId}/notes/{noteId}/pin", at: `${pin}:9`, how: "target-flow" },
      { name: "PUT /api/boards/{id}/archive", at: "question q-0a1b2c3d4e5f", how: "answer" },
      {
        name: "V3__legacy.sql",
        at: "forge-legacy:src/main/resources/db/migration/V3__legacy.sql",
        how: "migration",
      },
    ]);
    // The model reads what is known and where, as data.
    const known = g.sources.find((s) => s.id === "known-names");
    expect(known?.text).toContain(`- POST /feed/pins: the change's own target flow (${pin}:28)`);
    expect(known?.text).toContain(
      "- PUT /api/boards/{id}/archive: answered (question q-0a1b2c3d4e5f)",
    );
  });

  it("a name answered once never comes back as a gap in that change", async () => {
    const r = await root();
    const first = await gapContext(r, CHANGE, ["AuthGate"]);
    expect(first.gaps.map((x) => x.name)).toEqual(["AuthGate"]);
    await answer(r, "AuthGate", "The gateway's filter, owned by the platform team.");
    for (let i = 0; i < 2; i++) {
      const again = await gapContext(r, CHANGE, ["AuthGate", "authgate"]);
      expect(again.gaps).toEqual([]);
      expect(again.known.map((k) => [k.name, k.at])).toEqual([
        ["authgate", "question q-0a1b2c3d4e5f"],
        ["AuthGate", "question q-0a1b2c3d4e5f"],
      ]);
    }
  });
});
