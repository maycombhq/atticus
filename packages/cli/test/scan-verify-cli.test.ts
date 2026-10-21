import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { listQuestions, raiseQuestions, ScanSettings, ScanVerifyProposal } from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { scanCommand } from "../src/scan-commands.js";
import { scanVerify, scanVerifyAccept } from "../src/scan-verify-commands.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scan-verify");
const NOW = new Date("2026-10-21T12:00:00Z");
const T = 180_000;

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};
const quiet = { out: () => {}, err: () => {} };

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
    ].concat(args),
    { cwd, stdio: "pipe" },
  );
}

/** A metarepo with the fixture's org pack, forge-tasks as a base clone, and its first scan. */
async function scanned() {
  const root = await mkdtemp(join(tmpdir(), "atticus-verify-"));
  await cp(join(FX, "metarepo"), root, { recursive: true });
  const dir = join(root, "workspace", "forge-tasks");
  await cp(join(FX, "repos", "forge-tasks"), dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  expect(await scanCommand(root, { noDrift: true }, quiet)).toBe(0);
  return root;
}

async function ids(root: string) {
  const { records } = await readCatalog(join(root, "catalog", "generated"));
  const x = records as unknown as {
    id: string;
    kind: string;
    method?: string;
    name?: string;
    pathOrTopic?: string;
    evidence: { path?: string }[];
  }[];
  return {
    list: x.find((r) => r.kind === "Endpoint" && r.method === "GET")!,
    add: x.find((r) => r.kind === "Endpoint" && r.method === "POST")!.id,
    table: x.find((r) => r.kind === "Table" && r.name === "task")!.id,
    sample: x.find((r) => r.kind !== "Component" && r.evidence[0]?.path === "samples/demo.js")!.id,
  };
}

const answer = (i: Awaited<ReturnType<typeof ids>>) => `missed:
  - kind: entry-point
    method: GET
    name: /tasks-api/tasks/archive
    at: "src/main/java/forge/tasks/ArchiveHandler.java:8"
    says: '"/tasks/archive"'
    why: the Forge web framework routes this method, and no reader reads @ForgeRoute
    fix: { reader: "read @ForgeRoute(method, path) on a method as an HTTP entry point" }
wrong:
  - record: ${i.list.id}
    at: "src/main/resources/application.properties:2"
    says: /tasks-api
    why: the context path puts /tasks-api in front of every entry point
    fix:
      settings:
        prefixes:
          - paths: ["src/main/java/**"]
            prefix: /tasks-api
            why: server.servlet.context-path
            at: "src/main/resources/application.properties:2"
            value: /tasks-api
  - record: ${i.sample}
    at: "samples/demo.js:1"
    says: A sample a developer wrote
    why: samples/ may be a try-out, not the product
    fix:
      question:
        question: Is samples/ part of the product, or a try-out to leave out of the scan?
        options:
          - { label: Leave it out, means: nobody ships it, changes: the scan leaves samples/ out }
          - { label: Product, means: it ships, changes: the scan keeps reading samples/ }
        evidence: ["samples/demo.js:1"]
confirmed: [${i.add}, ${i.table}]
`;

describe("atticus scan verify (ADR 0082)", () => {
  it(
    "writes a proposal, a findings file and questions, never the catalog; --accept merges the settings",
    async () => {
      const root = await scanned();
      const i = await ids(root);
      expect(i.list.pathOrTopic).toBe("/tasks");
      const catalogBefore = (
        await readdir(join(root, "catalog", "generated"), { recursive: true })
      ).sort();
      const runtime = new MockRuntime(() => answer(i), { now: () => NOW });
      const t = io();
      expect(
        await scanVerify(root, "forge-tasks", {}, { runtime, now: NOW }, t.io),
        t.err.join("\n"),
      ).toBe(0);
      expect(t.out[0]).toBe(
        "Checked forge-tasks against its last scan: 1 missed, 2 wrong, 2 confirmed.",
      );
      expect(t.out).toContain(
        "  missed: entry point GET /tasks-api/tasks/archive (src/main/java/forge/tasks/ArchiveHandler.java:8); a reader must change",
      );
      expect(t.out).toContain(
        `  wrong: ${i.list.id} (src/main/resources/application.properties:2); a scan settings entry`,
      );
      expect(t.out).toContain(`  wrong: ${i.sample} (samples/demo.js:1); a question for a person`);
      expect(t.out).toContain(
        "Wrote proposals/scan/forge-tasks.yaml: 1 settings entry to accept, 2 records confirmed.",
      );
      expect(t.out).toContain(
        "Wrote proposals/scan/forge-tasks.findings.md: 1 thing a reader or a scanner plugin must read differently.",
      );
      expect(t.out.at(-1)).toBe(
        "Next: review proposals/scan/forge-tasks.yaml, then atticus scan verify forge-tasks --accept, and atticus scan.",
      );

      const proposal = ScanVerifyProposal.parse(
        parse(await readFile(join(root, "proposals", "scan", "forge-tasks.yaml"), "utf8")),
      );
      expect(proposal.settings.prefixes.map((p) => p.prefix)).toEqual(["/tasks-api"]);
      expect(proposal.missed.map((m) => m.name)).toEqual(["/tasks-api/tasks/archive"]);
      expect(proposal.wrong.find((w) => w.record === i.list.id)).toMatchObject({
        kind: "entry-point",
        method: "GET",
        name: "/tasks",
      });
      expect(proposal.verified.map((v) => v.record)).toEqual([i.add, i.table].sort());
      expect(proposal.verified.find((v) => v.record === i.table)).toMatchObject({
        at: "src/main/resources/db/migration/V1__create_task.sql:1",
        line: expect.stringMatching(/^[0-9a-f]{12}$/),
      });
      const qs = await listQuestions(root, { step: "scan-verify" });
      expect(qs.questions).toHaveLength(1);
      expect(qs.questions[0]).toMatchObject({
        repo: "forge-tasks",
        rerun: "atticus scan verify forge-tasks",
        evidence: ["samples/demo.js:1"],
      });
      expect(proposal.questions).toEqual([qs.questions[0]!.id]);
      const findings = await readFile(
        join(root, "proposals", "scan", "forge-tasks.findings.md"),
        "utf8",
      );
      expect(findings).toContain("# What the scan of forge-tasks reads wrong");
      expect(findings).toContain(
        "- Missed the entry point GET /tasks-api/tasks/archive at src/main/java/forge/tasks/ArchiveHandler.java:8. The Forge web framework routes this method, and no reader reads @ForgeRoute. What must change: Read @ForgeRoute(method, path) on a method as an HTTP entry point.",
      );
      // The catalog is the scan's alone.
      expect(
        (await readdir(join(root, "catalog", "generated"), { recursive: true })).sort(),
      ).toEqual(catalogBefore);

      // Run again: the settings entry is merged, not repeated; the question isn't asked twice.
      expect(await scanVerify(root, "forge-tasks", {}, { runtime, now: NOW }, io().io)).toBe(0);
      const again = ScanVerifyProposal.parse(
        parse(await readFile(join(root, "proposals", "scan", "forge-tasks.yaml"), "utf8")),
      );
      expect(again.settings.prefixes).toHaveLength(1);
      expect((await listQuestions(root)).questions).toHaveLength(1);

      // A person accepts: the entries go into org-pack/scan, and the next scan uses them.
      const a = io();
      expect(
        await scanVerifyAccept(root, "forge-tasks", { by: "priya.nair", now: NOW }, a.io),
      ).toBe(0);
      expect(a.out).toEqual([
        "Merged 1 entry into org-pack/scan/forge-tasks.yaml: 1 prefix. Review it in a pull request, then run atticus scan.",
      ]);
      const settings = ScanSettings.parse(
        parse(await readFile(join(root, "org-pack", "scan", "forge-tasks.yaml"), "utf8")),
      );
      expect(settings.prefixes[0]).toMatchObject({
        prefix: "/tasks-api",
        at: "src/main/resources/application.properties:2",
      });
      const after = ScanVerifyProposal.parse(
        parse(await readFile(join(root, "proposals", "scan", "forge-tasks.yaml"), "utf8")),
      );
      expect(after.settings.prefixes).toEqual([]);
      expect(after.accepted).toMatchObject({ by: "priya.nair", entries: 1 });
      const none = io();
      expect(
        await scanVerifyAccept(root, "forge-tasks", { by: "priya.nair", now: NOW }, none.io),
      ).toBe(0);
      expect(none.out).toEqual([
        "Nothing to accept for forge-tasks: the proposal has no settings entries.",
      ]);

      expect(await scanCommand(root, { noDrift: true }, quiet)).toBe(0);
      const rescanned = await ids(root);
      expect(rescanned.list.pathOrTopic).toBe("/tasks-api/tasks");
    },
    T,
  );

  it(
    "hands back a fabricated citation, says what was refused, and needs a scan first",
    async () => {
      const root = await scanned();
      const i = await ids(root);
      const fabricated = answer(i).replace(
        "says: '\"/tasks/archive\"'",
        "says: '\"/tasks/purge\"'",
      );
      const runtime = new MockRuntime(() => fabricated, { now: () => NOW });
      const t = io();
      expect(
        await scanVerify(root, "forge-tasks", { attempts: 2 }, { runtime, now: NOW }, t.io),
      ).toBe(0);
      expect(t.out).toContain("Attempt 1: 1 problem, handed back:");
      expect(t.out).toContain(
        '  - missed.0: src/main/java/forge/tasks/ArchiveHandler.java:8 doesn\'t say ""/tasks/purge""',
      );
      expect(t.out).toContain("Left out, because the last attempt still failed its checks:");
      expect(t.out[0]).toBe(
        "Checked forge-tasks against its last scan: 0 missed, 2 wrong, 2 confirmed.",
      );

      const empty = await mkdtemp(join(tmpdir(), "atticus-verify-empty-"));
      await cp(join(FX, "metarepo"), empty, { recursive: true });
      await cp(join(FX, "repos", "forge-tasks"), join(empty, "workspace", "forge-tasks"), {
        recursive: true,
      });
      const n = io();
      expect(await scanVerify(empty, "forge-tasks", {}, { runtime, now: NOW }, n.io)).toBe(1);
      expect(n.err[0]).toBe(
        "The catalog has nothing from forge-tasks yet: run atticus scan first.",
      );
      const noProposal = io();
      expect(
        await scanVerifyAccept(empty, "forge-tasks", { by: "x", now: NOW }, noProposal.io),
      ).toBe(1);
      expect(noProposal.err[0]).toBe(
        "There is no proposal for forge-tasks yet: run atticus scan verify forge-tasks first.",
      );
    },
    T,
  );

  it(
    "reuses the question scan survey already asked about the same thing, and says so (ADR 0089)",
    async () => {
      const root = await scanned();
      const i = await ids(root);
      const survey = await raiseQuestions(
        root,
        [
          {
            question:
              "Is samples/, the folder of demos, still part of the product, or should it be left out?",
            options: [],
            evidence: ["samples/demo.js:1", "README.md:1"],
            scope: "repo",
          },
        ],
        {
          step: "scan-survey",
          repo: "forge-tasks",
          command: "atticus scan survey forge-tasks",
          rerun: "atticus scan survey forge-tasks --force",
          at: NOW.toISOString(),
        },
      );
      const id = survey.raised[0]!.id;
      const runtime = new MockRuntime(() => answer(i), { now: () => NOW });
      const t = io();
      expect(await scanVerify(root, "forge-tasks", {}, { runtime, now: NOW }, t.io)).toBe(0);
      expect(t.out).toContain(
        `${id} was already asked by atticus scan survey forge-tasks: "Is samples/, the folder of demos, still part of the product, or should it be left out?" This step waits on the same answer instead of asking again.`,
      );
      const all = (await listQuestions(root)).questions;
      expect(all.map((q) => q.id)).toEqual([id]);
      expect(all[0]!.alsoAskedBy).toEqual([
        expect.objectContaining({ step: "scan-verify", rerun: "atticus scan verify forge-tasks" }),
      ]);
      const proposal = ScanVerifyProposal.parse(
        parse(await readFile(join(root, "proposals", "scan", "forge-tasks.yaml"), "utf8")),
      );
      expect(proposal.questions).toEqual([id]);
    },
    T,
  );
});
