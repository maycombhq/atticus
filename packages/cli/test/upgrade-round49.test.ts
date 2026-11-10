import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { QUESTION_SCHEMA_VERSION } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { doctorChecks } from "../src/doctor.js";
import { main } from "../src/main.js";
import { uiRoutes } from "../src/ui-api.js";
import { MIGRATIONS, STAMP_FILE, upgradeCheck, upgradeCommand } from "../src/upgrade.js";
import { VERSION } from "../src/version.js";

// Review round 49 (upgrade).

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const RECORD_V1 = [
  "schemaVersion: 1",
  "kind: System",
  "id: ledger",
  "status: current",
  "confidence: asserted",
  "name: Ledger",
  "boundary: internal",
  "evidence:",
  "  - source: manual",
  "    by: ari",
  "",
].join("\n");

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-r49-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  const f = join(root, "catalog/generated/system/ledger.yaml");
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, RECORD_V1);
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

const doctorUpgrade = async (root: string) =>
  (
    await doctorChecks(root, {
      openspecVersion: async () => "1.14.0",
      portFree: async () => true,
    })
  ).find((c) => c.id === "upgrade");

describe("a stamp this Atticus can't read (round 49)", () => {
  async function stamped(text: string): Promise<string> {
    const root = await metarepo();
    await mkdir(join(root, ".atticus"), { recursive: true });
    await writeFile(join(root, STAMP_FILE), text);
    return root;
  }
  const NEWER = [
    "schemaVersion: 3",
    "atticus: 9.0.0",
    "upgradedAt: 2027-01-01T00:00:00Z",
    "upgradedBy: pat",
    "migrations: [catalog-schema-v2]",
  ];

  it("a newer stamp with a field this one doesn't know is still newer (m3)", async () => {
    const text = [...NEWER, "upgradedWith: { channel: stable }", ""].join("\n");
    const root = await stamped(text);
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.newer).toBe(true);
    const r = io();
    expect(await upgradeCommand(root, {}, r.io, "1.0.0")).toBe(1);
    expect(r.err[0]).toMatch(/upgraded by Atticus 9\.0\.0; this is 1\.0\.0\. Install 9\.0\.0/);
    expect(await readFile(join(root, STAMP_FILE), "utf8")).toBe(text);
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toBe(
      RECORD_V1,
    );
    expect(await doctorUpgrade(root)).toMatchObject({ status: "fail" });
  }, 30_000);

  it("a stamp at a higher schema version is still newer (m4)", async () => {
    const text = [...NEWER.map((l) => l.replace("schemaVersion: 3", "schemaVersion: 9")), ""].join(
      "\n",
    );
    const root = await stamped(text);
    expect((await upgradeCheck(root, "1.0.0")).newer).toBe(true);
    expect(await upgradeCommand(root, {}, io().io, "1.0.0")).toBe(1);
    expect(await readFile(join(root, STAMP_FILE), "utf8")).toBe(text);
  });

  it("a stamp that names no Atticus is refused, never overwritten, and doctor fails", async () => {
    const text = "schemaVersion: 9\nwrittenBy: someone\n";
    const root = await stamped(text);
    const r = io();
    expect(await upgradeCommand(root, {}, r.io, "1.0.0")).toBe(1);
    expect(r.err.join("\n")).toMatch(/upgraded by a newer or unknown Atticus/);
    expect(r.err.join("\n")).toMatch(/Install it/);
    expect(await readFile(join(root, STAMP_FILE), "utf8")).toBe(text);
    const d = await doctorUpgrade(root);
    expect(d).toMatchObject({ status: "fail" });
    expect(d!.detail).toMatch(/newer or unknown Atticus/);
  }, 30_000);

  it("an older stamp with a field this one doesn't know is refused too", async () => {
    const text = [
      ...NEWER.map((l) => l.replace("9.0.0", "0.1.0")),
      "upgradedWith: { channel: stable }",
      "",
    ].join("\n");
    const root = await stamped(text);
    expect(await upgradeCommand(root, {}, io().io, "1.0.0")).toBe(1);
    expect(await readFile(join(root, STAMP_FILE), "utf8")).toBe(text);
  });
});

describe("a catalog kept where the layout says (round 49)", () => {
  it("lists, backs up and rewrites kb/catalog, not catalog/ (m7)", async () => {
    const root = await metarepo();
    await mkdir(join(root, "kb"), { recursive: true });
    await rename(join(root, "catalog"), join(root, "kb/catalog"));
    await writeFile(
      join(root, "org-pack/sources.yaml"),
      "schemaVersion: 3\nlayout:\n  catalog: kb/catalog\n  openspec: openspec\n",
    );
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "catalog-schema-v2")?.files).toEqual([
      "kb/catalog/generated/system/ledger.yaml",
    ]);
    const r = io();
    expect(
      await upgradeCommand(
        root,
        { by: "pat", now: new Date("2026-11-09T10:00:00Z") },
        r.io,
        "1.0.0",
      ),
    ).toBe(0);
    const backup = join(root, ".atticus/backups/20261109-100000");
    expect(await readFile(join(backup, "kb/catalog/generated/system/ledger.yaml"), "utf8")).toBe(
      RECORD_V1,
    );
    expect(await readFile(join(root, "kb/catalog/generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 5/,
    );
  });

  it("a pending file that isn't there to back up stops the upgrade before anything changes", async () => {
    const root = await metarepo();
    const fake = {
      id: "test-missing-file",
      summary: "A step listing a file that isn't there",
      pending: async () => ["catalog/generated/system/gone.yaml"],
      apply: async () => [],
    };
    MIGRATIONS.push(fake);
    try {
      await expect(upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).rejects.toThrow(
        /Couldn't back up catalog\/generated\/system\/gone\.yaml/,
      );
      expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toBe(
        RECORD_V1,
      );
    } finally {
      MIGRATIONS.splice(MIGRATIONS.indexOf(fake), 1);
    }
  });
});

describe("question files upgrade leaves as they are (round 49)", () => {
  it("says a copy of a question was left, and never writes it over the live one (m9)", async () => {
    const root = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    const v1 = await readFile(join(FIXTURES, "context/questions/q-0f1e2d3c4b5a.yaml"), "utf8");
    // The live copy at the version questions are now (6 since ADR 0191): nothing to upgrade.
    const live = v1.replace("schemaVersion: 1", `schemaVersion: ${QUESTION_SCHEMA_VERSION}`);
    await writeFile(join(root, "questions/q-0f1e2d3c4b5a.yaml"), live);
    await writeFile(join(root, "questions/q-0f1e2d3c4b5a copy.yaml"), v1);
    const check = io();
    await upgradeCommand(root, { check: true }, check.io, "1.0.0");
    expect(check.err.join("\n")).toMatch(/questions\/q-0f1e2d3c4b5a copy\.yaml/);
    const r = io();
    expect(await upgradeCommand(root, { by: "pat" }, r.io, "1.0.0")).toBe(0);
    expect(r.err.join("\n")).toMatch(/questions\/q-0f1e2d3c4b5a copy\.yaml/);
    expect(await readFile(join(root, "questions/q-0f1e2d3c4b5a.yaml"), "utf8")).toBe(live);
  });
});

describe("atticus init --by (round 49)", () => {
  it("records the person given as the one who upgraded", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "atticus-r49-")), "shop");
    expect(await main(["init", dir, "--platform", "shop", "--by", "tester"], io().io)).toBe(0);
    const stamp = parse(await readFile(join(dir, STAMP_FILE), "utf8")) as { upgradedBy: string };
    expect(stamp.upgradedBy).toBe("tester");
  }, 60_000);
});

describe("POST /api/upgrade records this Atticus when no step is pending (round 49)", () => {
  it("runs while the stamp is older than this build, then says there is nothing", async () => {
    const root = await metarepo();
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "0.0.1")).toBe(0);
    expect((await upgradeCheck(root)).pending).toEqual([]);
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx),
    });
    try {
      const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
      const r = await fetch(`${s.url}/api/upgrade`, { method: "POST", headers: h, body: "{}" });
      expect(r.status).toBe(202);
      const { jobId } = (await r.json()) as { jobId: string };
      let job: { state: string; result?: { code: number; lines: string[] } };
      for (;;) {
        job = (await (
          await fetch(`${s.url}/api/jobs/${jobId}`, { headers: h })
        ).json()) as typeof job;
        if (job.state !== "running" && job.state !== "queued") break;
        await new Promise((x) => setTimeout(x, 50));
      }
      expect(job.state, job.result?.lines.join("\n")).toBe("done");
      const stamp = parse(await readFile(join(root, STAMP_FILE), "utf8")) as { atticus: string };
      expect(stamp.atticus).toBe(VERSION);
      const again = await fetch(`${s.url}/api/upgrade`, { method: "POST", headers: h, body: "{}" });
      expect(again.status).toBe(409);
    } finally {
      await s.close();
    }
  }, 60_000);
});

describe("atticus questions show, for a question a newer Atticus wrote (round 49)", () => {
  it("says which, and to install it, never that there is no such question", async () => {
    const { questionsFiles } = await import("../src/question-commands.js");
    const root = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    const v1 = await readFile(join(FIXTURES, "context/questions/q-0f1e2d3c4b5a.yaml"), "utf8");
    await writeFile(
      join(root, "questions/q-0f1e2d3c4b5a.yaml"),
      v1.replace("schemaVersion: 1", "schemaVersion: 9"),
    );
    const t = io();
    expect(await questionsFiles(root, ["questions", "show", "q-0f1e2d3c4b5a"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(
      /questions\/q-0f1e2d3c4b5a\.yaml was written by a newer Atticus \(question version 9\); install it/,
    );
    expect(t.err.join("\n")).not.toMatch(/No question/);
  });
});
