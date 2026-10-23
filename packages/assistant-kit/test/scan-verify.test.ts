import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import type { CatalogRecord } from "@maycombhq/core";
import { BUILT_IN_EXTRACTORS } from "@maycombhq/extractors";
import { fsRepo, scanRepo } from "@maycombhq/sdk";
import { checkVerify, recordFact, verifyScan } from "../src/scan-verify.js";

/**
 * The AI verify step (ADR 0082) on fixtures/scan-verify: a Spring service whose context path
 * the scan doesn't know, an entry point routed by a house framework no reader reads, and a
 * sample folder that may or may not be the product.
 */
const TASKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/scan-verify/repos/forge-tasks",
);
const NOW = new Date("2026-10-21T12:00:00Z");
const repo = () => fsRepo("forge-tasks", TASKS, "a".repeat(40));

async function records(): Promise<CatalogRecord[]> {
  return (await scanRepo({ repo: repo(), extractors: BUILT_IN_EXTRACTORS })).records;
}

const ids = (rs: CatalogRecord[]) => {
  const x = rs as unknown as {
    id: string;
    kind: string;
    method?: string;
    pathOrTopic?: string;
    name?: string;
    evidence: { path?: string }[];
  }[];
  return {
    list: x.find((r) => r.kind === "Endpoint" && r.method === "GET")!.id,
    add: x.find((r) => r.kind === "Endpoint" && r.method === "POST")!.id,
    table: x.find((r) => r.kind === "Table" && r.name === "task")!.id,
    sample: x.find((r) => r.evidence[0]?.path === "samples/demo.js")!.id,
  };
};

/** A correct miss (reader), a wrong record (settings), a wrong record (question), a confirm. */
const answer = (i: ReturnType<typeof ids>, o: { fabricate?: boolean } = {}) =>
  [
    "```yaml",
    "missed:",
    "  - kind: entry-point",
    "    method: GET",
    "    name: /tasks-api/tasks/archive",
    '    at: "src/main/java/forge/tasks/ArchiveHandler.java:8"',
    '    says: "path = \\"/tasks/archive\\""',
    "    why: the Forge web framework routes this method; no reader reads @ForgeRoute",
    '    fix: { reader: "read @ForgeRoute(method, path) on a method as an HTTP entry point" }',
    ...(o.fabricate
      ? [
          "  - kind: entry-point",
          "    method: DELETE",
          "    name: /tasks-api/tasks/purge",
          '    at: "src/main/java/forge/tasks/ArchiveHandler.java:8"',
          '    says: "/tasks/purge"',
          "    why: a purge route",
          "    fix: { reader: read it }",
          "  - kind: table",
          "    name: task_audit",
          '    at: "src/main/resources/db/migration/V1__create_task.sql:40"',
          '    says: "CREATE TABLE task_audit"',
          "    why: an audit table",
          "    fix: { reader: read it }",
        ]
      : []),
    "wrong:",
    `  - record: ${i.list}`,
    '    at: "src/main/resources/application.properties:2"',
    "    says: /tasks-api",
    "    why: the context path puts /tasks-api in front of every entry point",
    "    fix:",
    "      settings:",
    "        prefixes:",
    '          - paths: ["src/main/java/**"]',
    "            prefix: /tasks-api",
    "            why: server.servlet.context-path",
    '            at: "src/main/resources/application.properties:2"',
    "            value: /tasks-api",
    `  - record: ${i.sample}`,
    '    at: "samples/demo.js:1"',
    "    says: A sample a developer wrote",
    "    why: samples/ may be a hand-written try-out, not the product",
    "    fix:",
    "      question:",
    "        question: Is samples/ part of the product, or a try-out to leave out of the scan?",
    "        options:",
    "          - { label: Leave it out, means: nobody ships it, changes: the scan leaves samples/ out }",
    "          - { label: Product, means: it ships, changes: the scan keeps reading samples/ }",
    '        evidence: ["samples/demo.js:1"]',
    ...(o.fabricate
      ? [
          "  - record: endpoint-made-up",
          '    at: "pom.xml:1"',
          '    says: "<project>"',
          "    why: made up",
          "    fix: { reader: nothing }",
        ]
      : []),
    // ADR 0112: each confirmation cites the line that shows it.
    "confirmed:",
    `  - record: ${i.add}`,
    '    at: "src/main/java/forge/tasks/TaskController.java:19"',
    '    says: "@PostMapping"',
    `  - record: ${i.table}`,
    '    at: "src/main/resources/db/migration/V1__create_task.sql:1"',
    '    says: "CREATE TABLE task ("',
    ...(o.fabricate
      ? [
          "  - record: table-not-there",
          '    at: "src/main/resources/db/migration/V1__create_task.sql:1"',
          '    says: "CREATE TABLE task ("',
        ]
      : []),
    "```",
  ].join("\n");

const confirmedIds = (r: { answer?: { confirmed: { record: string }[] } }) =>
  r.answer!.confirmed.map((c) => c.record);

describe("atticus scan verify (ADR 0082)", () => {
  it("hands the assistant the scan's records by kind with file:line, the folders and the settings", async () => {
    const rs = await records();
    const i = ids(rs);
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return answer(i);
      },
      { now: () => NOW },
    );
    const r = await verifyScan(repo(), {
      repoId: "forge-tasks",
      runtime,
      records: rs,
      settings: { schemaVersion: 1, repo: "forge-tasks", exclude: [], prefixes: [], clients: [] },
      now: NOW,
    });
    expect(r.status).toBe("checked");
    expect(r.refused).toEqual([]);
    const p = prompts[0]!;
    expect(p).toContain("Entry points the scan recorded");
    expect(p).toMatch(
      new RegExp(
        `${i.list} rest GET /tasks\\s+\\(src/main/java/forge/tasks/TaskController\\.java:\\d+\\)`,
      ),
    );
    expect(p).toContain("Tables the scan recorded");
    expect(p).toMatch(
      new RegExp(
        `${i.table} task\\s+\\(src/main/resources/db/migration/V1__create_task\\.sql:1\\)`,
      ),
    );
    expect(p).toContain("samples/ 1");
    expect(p).toContain("The repo's scan settings, which the last scan applied:\nexclude: []");
    // Each item kept, with its fix.
    expect(r.answer!.missed.map((m) => m.name)).toEqual(["/tasks-api/tasks/archive"]);
    expect(r.answer!.wrong.map((w) => w.record)).toEqual([i.list, i.sample]);
    expect(confirmedIds(r)).toEqual([i.add, i.table]);
  });

  it("refuses a fabricated citation, a record that isn't in the catalog, and hands them back", async () => {
    const rs = await records();
    const i = ids(rs);
    const prompts: string[] = [];
    const replies = [answer(i, { fabricate: true }), answer(i)];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await verifyScan(repo(), { repoId: "forge-tasks", runtime, records: rs, now: NOW });
    expect(r.status).toBe("checked");
    expect(r.attempts[0]!.problems).toEqual([
      'missed.1: src/main/java/forge/tasks/ArchiveHandler.java:8 doesn\'t say "/tasks/purge"',
      "missed.2: src/main/resources/db/migration/V1__create_task.sql has fewer than 40 lines",
      "wrong.2: there is no record endpoint-made-up in the scan of forge-tasks",
      "confirmed.2: there is no record table-not-there in the scan of forge-tasks",
    ]);
    expect(r.attempts[1]!.problems).toEqual([]);
    expect(prompts[1]).toContain('doesn\'t say "/tasks/purge"');
    expect(r.answer!.missed).toHaveLength(1);
  });

  it("keeps what passed and reports what was refused when no attempt is left", async () => {
    const rs = await records();
    const i = ids(rs);
    const runtime = new MockRuntime(() => answer(i, { fabricate: true }), { now: () => NOW });
    const r = await verifyScan(repo(), {
      repoId: "forge-tasks",
      runtime,
      records: rs,
      maxAttempts: 1,
      now: NOW,
    });
    expect(r.status).toBe("checked");
    expect(r.refused).toHaveLength(4);
    expect(r.answer!.missed.map((m) => m.name)).toEqual(["/tasks-api/tasks/archive"]);
    expect(r.answer!.wrong.map((w) => w.record)).toEqual([i.list, i.sample]);
    expect(confirmedIds(r)).toEqual([i.add, i.table]);
  });

  it("checks a settings fix with the scan settings' own checks, and a question's evidence", async () => {
    const rs = await records();
    const i = ids(rs);
    const bad = answer(i)
      .replace("            value: /tasks-api", "            value: /tasks-v2")
      .replace('evidence: ["samples/demo.js:1"]', 'evidence: ["samples/gone.js:1"]');
    const c = await checkVerify(bad, repo(), "forge-tasks", rs);
    expect(c.problems).toEqual([
      "wrong.0.fix.settings.prefixes.0: src/main/resources/application.properties:2 doesn't say /tasks-v2, so the prefix /tasks-api isn't applied",
      "wrong.1.fix.question.evidence.0: samples/gone.js isn't in the repo",
    ]);
    // A missed fact the scan already has is not a miss; a missed entry point must be named on its line.
    const dup = [
      "missed:",
      "  - kind: entry-point",
      "    method: POST",
      "    name: /tasks",
      '    at: "src/main/java/forge/tasks/TaskController.java:19"',
      "    says: PostMapping",
      "    why: x",
      "    fix: { reader: x }",
      "  - kind: table",
      "    name: archive",
      '    at: "src/main/java/forge/tasks/TaskController.java:19"',
      "    says: PostMapping",
      "    why: x",
      "    fix: { reader: x }",
    ].join("\n");
    expect((await checkVerify(dup, repo(), "forge-tasks", rs)).problems).toEqual([
      `missed.0: the scan has it already, as ${i.add}`,
      "missed.1: src/main/java/forge/tasks/TaskController.java:19 doesn't name archive",
    ]);
    expect((await checkVerify("not: [yaml", repo(), "forge-tasks", rs)).problems[0]).toMatch(
      /isn't YAML/,
    );
  });

  it("sends the code around each record's line, numbered, so the model reads it (ADR 0112)", async () => {
    const rs = await records();
    const i = ids(rs);
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return answer(i);
      },
      { now: () => NOW },
    );
    await verifyScan(repo(), { repoId: "forge-tasks", runtime, records: rs, now: NOW });
    const p = prompts[0]!;
    expect(p).toMatch(
      /src\/main\/java\/forge\/tasks\/TaskController\.java lines 1-25 \(cited at [\d, ]+; numbered as in the file\):/,
    );
    expect(p).toContain("19:   @PostMapping");
    expect(p).toContain("1: CREATE TABLE task (");
    expect(p).not.toContain("open every file you need");
    expect(p).toContain("confirmed:\n  - record: <the record's id");
  });

  it("keeps a confirmation only when it cites the line that shows it (ADR 0112)", async () => {
    const rs = await records();
    const i = ids(rs);
    const doc = (confirmed: string[]) => ["confirmed:", ...confirmed].join("\n");
    const c = await checkVerify(
      doc([
        // A bare id, the form before ADR 0112: no line, so not verified.
        `  - ${i.list}`,
        // A line in another file than the record was read from.
        `  - { record: ${i.add}, at: "pom.xml:1", says: "<project>" }`,
        // Not on the line.
        `  - { record: ${i.add}, at: "src/main/java/forge/tasks/TaskController.java:19", says: "@DeleteMapping" }`,
        // Too short to show anything.
        `  - { record: ${i.add}, at: "src/main/java/forge/tasks/TaskController.java:19", says: "Post" }`,
        // On the line, but naming neither the table nor anything of it.
        `  - { record: ${i.table}, at: "src/main/resources/db/migration/V1__create_task.sql:3", says: "VARCHAR(200) NOT NULL" }`,
        // Right.
        `  - { record: ${i.table}, at: "src/main/resources/db/migration/V1__create_task.sql:1", says: "CREATE TABLE task" }`,
      ]),
      repo(),
      "forge-tasks",
      rs,
    );
    expect(c.problems).toEqual([
      `confirmed.0: ${i.list} cites no line; give the line that shows it (record, at and says), or leave it out`,
      `confirmed.1: ${i.add} was read from src/main/java/forge/tasks/TaskController.java, not pom.xml`,
      `confirmed.2: src/main/java/forge/tasks/TaskController.java:19 doesn't say "@DeleteMapping"`,
      `confirmed.3: "Post" is too short to show ${i.add}; quote at least 8 characters of the line`,
      `confirmed.4: "VARCHAR(200) NOT NULL" doesn't name task`,
    ]);
    expect(c.answer!.confirmed).toEqual([
      {
        record: i.table,
        at: "src/main/resources/db/migration/V1__create_task.sql:1",
        says: "CREATE TABLE task",
      },
    ]);
  });

  it("hands back a rubber-stamped confirmation and records only the cited ones", async () => {
    const rs = await records();
    const i = ids(rs);
    const stamp = answer(i).replace(
      /confirmed:[\s\S]*```/,
      `confirmed: [${i.add}, ${i.table}]\n\`\`\``,
    );
    const prompts: string[] = [];
    const replies = [stamp, answer(i)];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await verifyScan(repo(), { repoId: "forge-tasks", runtime, records: rs, now: NOW });
    expect(r.attempts[0]!.problems).toEqual([
      `confirmed.0: ${i.add} cites no line; give the line that shows it (record, at and says), or leave it out`,
      `confirmed.1: ${i.table} cites no line; give the line that shows it (record, at and says), or leave it out`,
    ]);
    expect(prompts[1]).toContain(`confirmed.0: ${i.add} cites no line`);
    expect(confirmedIds(r)).toEqual([i.add, i.table]);
    // With no attempt left, nothing uncited is recorded as confirmed.
    const once = new MockRuntime(() => stamp, { now: () => NOW });
    const r1 = await verifyScan(repo(), {
      repoId: "forge-tasks",
      runtime: once,
      records: rs,
      maxAttempts: 1,
      now: NOW,
    });
    expect(confirmedIds(r1)).toEqual([]);
    expect(r1.refused).toHaveLength(2);
  });

  it("fits the model's limit, and says so before handing off when the records can't (ADR 0112)", async () => {
    const rs = await records();
    const i = ids(rs);
    const packs: AiRequest["pack"][] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        packs.push(req.pack);
        return answer(i);
      },
      { now: () => NOW },
    );
    await verifyScan(repo(), {
      repoId: "forge-tasks",
      runtime,
      records: rs,
      now: NOW,
      maxTokens: 12_078,
    });
    expect(packs[0]!.manifest.budget).toBe(8658);
    expect(packs[0]!.manifest.totalTokens).toBeLessThanOrEqual(8658);
    await expect(
      verifyScan(repo(), {
        repoId: "forge-tasks",
        runtime,
        records: rs,
        now: NOW,
        maxTokens: 1500,
      }),
    ).rejects.toThrow(
      /^atticus scan verify forge-tasks can't fit its smallest useful prompt in the model: it needs about \d+ tokens \(its instructions and 4-records-entry-point, 4-records-call, 4-records-table, 4-records-deployment\), and a model of 1500 tokens leaves 725 for the prompt\./,
    );
  });

  it("says each record's fact in the bench's terms", async () => {
    const rs = await records();
    const i = ids(rs);
    const byId = (id: string) => rs.find((r) => r.id === id)!;
    expect(recordFact(byId(i.list))).toEqual({
      kind: "entry-point",
      method: "GET",
      name: "/tasks",
    });
    expect(recordFact(byId(i.table))).toEqual({ kind: "table", name: "task" });
    expect(recordFact(byId(i.sample)).kind).toBe("call");
  });
});
