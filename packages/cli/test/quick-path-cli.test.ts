import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { changeList, changeNew } from "../src/change-commands.js";
import { main } from "../src/main.js";
import { changeSteps, nextSteps, readNextState } from "../src/next-commands.js";
import { uiRoutes } from "../src/ui-api.js";

/**
 * ADR 0201: the quick path on the command line. A requirements file passes the door check and
 * becomes a change with no brief; `next` offers its files, then its hand-off, never a stage; a
 * plain OpenSpec folder is listed as not adopted and adopted as it is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(FORGE, "../forge-change/openspec/changes/add-transfer-limit");
const NOW = "2026-11-18T09:00:00Z";
const T = 60_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** The Forge metarepo: its org pack (no change-types.yaml, so the built-in types) and catalog. */
async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-quick-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  return root;
}

const HEADER = [
  "| Question | Evidence | Asked by | Answered by | Answer | State |",
  "| --- | --- | --- | --- | --- | --- |",
];

/**
 * A requirements file for a new event: it cites a catalog record (`ledger-api`), a manifest repo
 * nobody read into the catalog (`forge-reports-job`) and a topic it plans.
 */
const requirements = (rows: string[] = []) =>
  [
    "# Shipped-orders event",
    "",
    "Orders tell the ledger when they ship.",
    "",
    "## Planned",
    "",
    "- `topic.orders-shipped`: the new topic",
    "",
    "## Application architect",
    "",
    ...HEADER,
    "| Who reads the topic after day 1? | `ledger-api` src/events/Shipped.java:41; `topic.orders-shipped` | application-architect-naysayer | pat | Ledger only | answered |",
    "| Do the reports need it? | forge-reports-job | application-architect-naysayer | sam | Not in this change | accepted |",
    ...rows,
    "",
  ].join("\r\n");

async function withFile(text: string): Promise<{ root: string; file: string }> {
  const root = await forgeRoot();
  const file = join(root, "requirements.md");
  await writeFile(file, text);
  return { root, file };
}

describe("atticus change new --from", () => {
  it(
    "--check passes a closed file, counts what it read and creates nothing",
    async () => {
      const { root, file } = await withFile(requirements());
      const c = capture();
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, c.io)).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out).toEqual([
        `${file} passes: 2 questions (1 answered, 1 accepted), 2 ids in the map, 1 planned.`,
      ]);
      expect(await readdir(join(root, "openspec/changes"))).toEqual([]);
      const j = capture();
      expect(await changeNew(root, { from: file, check: true, json: true, by: "pat" }, j.io)).toBe(
        0,
      );
      expect(JSON.parse(j.out.join("\n"))).toEqual({ ok: true, reasons: [] });
    },
    T,
  );

  it(
    "makes the change: quick, in plan, the file copied byte for byte, no brief",
    async () => {
      const { root, file } = await withFile(requirements());
      const c = capture();
      expect(await changeNew(root, { from: file, by: "pat" }, c.io, { now: NOW })).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out).toEqual([
        `Created shipped-orders-event (quick, from ${file}). It is in plan.`,
        "Next: your personas write its proposal, spec deltas, design and tasks (/define-change shipped-orders-event). Then a person runs atticus change handoff shipped-orders-event --approve.",
      ]);
      const dir = join(root, "openspec/changes/shipped-orders-event");
      expect((await readFile(join(dir, "requirements.md"))).equals(await readFile(file))).toBe(
        true,
      );
      expect((await readdir(dir)).sort()).toEqual([
        ".openspec.yaml",
        "change.yaml",
        "requirements.md",
      ]);
      const change = parse(await readFile(join(dir, "change.yaml"), "utf8")) as {
        type: string;
        state: string;
        title: string;
      };
      expect(change).toMatchObject({
        type: "quick",
        state: "plan",
        title: "Shipped-orders event",
      });
    },
    T,
  );

  it(
    "takes a title, an id and a type of its own through main",
    async () => {
      const { root, file } = await withFile(requirements());
      const c = capture();
      const code = await main(
        [
          "change",
          "new",
          "Tell the ledger",
          "--from",
          file,
          "--id",
          "tell-ledger",
          "--by",
          "pat",
          "--root",
          root,
        ],
        c.io,
      );
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(c.out[0]).toBe(`Created tell-ledger (quick, from ${file}). It is in plan.`);
      const j = capture();
      expect(
        await main(["change", "new", "--from", file, "--check", "--json", "--root", root], j.io),
      ).toBe(0);
      expect(JSON.parse(j.out.join("\n"))).toEqual({ ok: true, reasons: [] });
    },
    T,
  );

  it(
    "refuses an open question, an id the map lacks and a five-cell row, each with its reason and line",
    async () => {
      const { root, file } = await withFile(
        requirements([
          "| Who owns the topic? | - | application-architect-naysayer | | | open |",
          "| Who else listens? | forge-audit-trail | qa-naysayer | pat | Nobody | answered |",
          "| Is it retried? | - | qa-naysayer | pat | answered |",
        ]),
      );
      const c = capture();
      expect(await changeNew(root, { from: file, by: "pat" }, c.io)).toBe(1);
      expect(c.out).toEqual([]);
      expect(c.err).toEqual([
        `Refused: 3 problems in ${file}.`,
        `requirements.open-question: ${file}:15: Application architect has an open question: "Who owns the topic?". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`,
        `requirements.unknown-id: ${file}:16: the evidence names forge-audit-trail, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-audit-trail), or list it under Planned.`,
        `requirements.unreadable: ${file}:17: this row of Application architect's questions doesn't read: it has 5 cells, not the six of its header.`,
      ]);
      expect(await readdir(join(root, "openspec/changes"))).toEqual([]);
      const j = capture();
      expect(await changeNew(root, { from: file, check: true, json: true, by: "pat" }, j.io)).toBe(
        1,
      );
      const said = JSON.parse(j.out.join("\n")) as {
        ok: boolean;
        reasons: { code: string; line: number; role: string; message: string }[];
      };
      expect(said.ok).toBe(false);
      expect(said.reasons.map((r) => [r.code, r.line, r.role])).toEqual([
        ["requirements.open-question", 15, "Application architect"],
        ["requirements.unknown-id", 16, "Application architect"],
        ["requirements.unreadable", 17, "Application architect"],
      ]);
    },
    T,
  );

  it(
    "passes a file no persona asked a question in, and says so",
    async () => {
      const { root, file } = await withFile("# A new portal\n\nWhat is wanted.\n");
      const c = capture();
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, c.io)).toBe(0);
      expect(c.out).toEqual([
        `No persona asked a question in ${file}.`,
        `${file} passes: 0 questions (0 answered, 0 accepted), 0 ids in the map, 0 planned.`,
      ]);
    },
    T,
  );

  it(
    "says to upgrade when the org pack has no type of the quick shape",
    async () => {
      const { root, file } = await withFile(requirements());
      await writeFile(
        join(root, "org-pack/change-types.yaml"),
        "schemaVersion: 2\ntypes:\n  - id: feature\n    name: New feature\n    phases: [define, plan, build]\n    artifacts: [proposal, tasks]\n",
      );
      const c = capture();
      expect(await changeNew(root, { from: file, by: "pat" }, c.io)).toBe(1);
      expect(c.err).toEqual([
        "This org pack has no change type quick: run atticus upgrade, or pass --type <type>.",
      ]);
      expect(await readdir(join(root, "openspec/changes"))).toEqual([]);
      // --check and --json belong to --from.
      const u = capture();
      expect(
        await changeNew(root, { title: "X", type: "feature", check: true, by: "pat" }, u.io),
      ).toBe(2);
    },
    T,
  );
});

describe("a plain OpenSpec change folder", () => {
  async function plain(): Promise<{ root: string; dir: string }> {
    const root = await forgeRoot();
    const dir = join(root, "openspec/changes/new-portal");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "proposal.md"), "Intro line.\n\n# A new portal for Forge\n\nWhy.\n");
    return { root, dir };
  }

  it(
    "is listed as not adopted, with the command that adopts it",
    async () => {
      const { root } = await plain();
      const c = capture();
      expect(await changeList(root, {}, c.io)).toBe(0);
      expect(c.out).toContain("new-portal  not adopted");
      expect(c.out).toContain(
        "Not adopted: new-portal is an OpenSpec change Atticus doesn't track yet. Adopt it: atticus change new --id new-portal",
      );
      expect(c.out.join("\n")).not.toContain("No changes yet");
      const j = capture();
      expect(await changeList(root, { json: true }, j.io)).toBe(0);
      expect(JSON.parse(j.out.join("\n"))).toEqual([{ id: "new-portal", adopted: false }]);
    },
    T,
  );

  it(
    "is adopted by change new --id: its proposal's title, type quick, change.yaml and nothing else",
    async () => {
      const { root, dir } = await plain();
      const c = capture();
      expect(
        await main(["change", "new", "--id", "new-portal", "--by", "pat", "--root", root], c.io),
      ).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out[0]).toBe('Adopted new-portal (quick, "A new portal for Forge"). It is in plan.');
      expect((await readdir(dir)).sort()).toEqual(["change.yaml", "proposal.md"]);
      expect(await readFile(join(dir, "proposal.md"), "utf8")).toBe(
        "Intro line.\n\n# A new portal for Forge\n\nWhy.\n",
      );
      const l = capture();
      await changeList(root, { json: true }, l.io);
      expect(JSON.parse(l.out.join("\n"))).toMatchObject([
        { id: "new-portal", title: "A new portal for Forge", type: "quick", state: "plan" },
      ]);
    },
    T,
  );

  it(
    "takes the id for a title with no proposal, and behaves as before with a title and a type",
    async () => {
      const root = await forgeRoot();
      const bare = join(root, "openspec/changes/move-billing");
      await mkdir(bare, { recursive: true });
      await writeFile(join(bare, ".openspec.yaml"), "schema: spec-driven\n");
      const c = capture();
      expect(await changeNew(root, { id: "move-billing", by: "pat" }, c.io, { now: NOW })).toBe(0);
      expect(c.out[0]).toBe('Adopted move-billing (quick, "move-billing"). It is in plan.');
      expect(existsSync(join(bare, "brief.md"))).toBe(false);

      const full = join(root, "openspec/changes/cap-transfers");
      await mkdir(full, { recursive: true });
      await writeFile(join(full, ".openspec.yaml"), "schema: spec-driven\n");
      const f = capture();
      expect(
        await changeNew(
          root,
          { title: "Cap transfers", type: "feature", id: "cap-transfers", by: "pat" },
          f.io,
          { now: NOW },
        ),
      ).toBe(0);
      expect(f.out[0]).toMatch(/^Created cap-transfers \(feature, from the .+ template\)/);
      expect(existsSync(join(full, "brief.md"))).toBe(true);
    },
    T,
  );
});

describe("what is next for a quick change", () => {
  const STAGES = ["brief", "feature", "architecture", "stories", "small", "draft"];

  it(
    "is quick-define naming the missing files, then the hand-off, and never a stage",
    async () => {
      const { root, file } = await withFile(requirements());
      expect(await changeNew(root, { from: file, by: "pat" }, capture().io, { now: NOW })).toBe(0);
      const id = "shipped-orders-event";
      const dir = join(root, "openspec/changes", id);
      const steps = async () => {
        const s = await readNextState(root);
        const c = s.changes.find((x) => x.id === id)!;
        const own = changeSteps(c);
        // Nowhere in what `atticus next` lists is a stage offered for it.
        const all = nextSteps(s).filter((x) => x.change === id);
        for (const x of [...own, ...all]) expect(STAGES).not.toContain(x.step);
        return { c, own };
      };

      const first = await steps();
      expect(first.c.quick).toEqual({
        missing: ["proposal.md", "a spec delta under specs/", "design.md", "tasks.md"],
      });
      expect(first.own[0]).toMatchObject({
        step: "quick-define",
        command: `atticus change status ${id}`,
        slash: `/define-change ${id}`,
      });
      expect(first.own[0]!.why).toContain(
        "proposal.md, a spec delta under specs/, design.md and tasks.md aren't written yet",
      );
      expect(first.own[0]!.person).toBeUndefined();

      await cp(join(FORGE_CHANGE, "proposal.md"), join(dir, "proposal.md"));
      await cp(join(FORGE_CHANGE, "specs"), join(dir, "specs"), { recursive: true });
      await cp(join(FORGE_CHANGE, "tasks.md"), join(dir, "tasks.md"));
      const second = await steps();
      expect(second.own[0]!.step).toBe("quick-define");
      expect(second.own[0]!.why).toContain("design.md isn't written yet");

      await cp(join(FORGE_CHANGE, "design.md"), join(dir, "design.md"));
      const third = await steps();
      expect(third.c.quick).toEqual({ missing: [] });
      // All four are there: what blocks its gate (as today), else the hand-off, a person's step.
      expect(["handoff", "finding", "answer"]).toContain(third.own[0]!.step);
      if (third.own[0]!.step === "handoff")
        expect(third.own[0]).toMatchObject({
          command: `atticus change handoff ${id} --approve`,
          person: true,
        });
    },
    T,
  );

  it("offers the hand-off with all four files and nothing blocking, and the gate's finding when one blocks", () => {
    const base = { id: "shipped-orders-event", state: "plan", tasks: [], quick: { missing: [] } };
    expect(changeSteps(base)).toMatchObject([
      {
        step: "handoff",
        command: "atticus change handoff shipped-orders-event --approve",
        person: true,
      },
    ]);
    const blocked = changeSteps({
      ...base,
      gate: [{ code: "blocking-finding", finding: "f-1", message: "The design names no rollback" }],
    });
    expect(blocked[0]).toMatchObject({
      step: "finding",
      command: "atticus finding shipped-orders-event f-1 edit-and-apply",
    });
    expect(blocked[0]!.why).toContain("proposal, spec deltas, design and tasks are written");
    expect(blocked[0]!.why).not.toContain("stage is done");
    // A fast-path type or a template brief never turns a quick change back to a stage.
    const odd = changeSteps({
      ...base,
      quick: { missing: ["tasks.md"] },
      fast: true,
      brief: "openspec/changes/shipped-orders-event/brief.md",
      undrafted: true,
    });
    expect(odd.map((s) => s.step)).toEqual(["quick-define"]);
    // Once it is in build, its tasks are next, as for any change.
    expect(
      changeSteps({
        ...base,
        state: "build",
        quick: undefined,
        tasks: [{ id: "t1", repo: "forge-ledger", done: false }],
      })[0]!.step,
    ).toBe("task");
  });
});

describe("the local API's change row (3.18.0)", () => {
  it(
    "says quickPath for a quick change, in the list and on the change, and not for another",
    async () => {
      const { root, file } = await withFile(requirements());
      expect(await changeNew(root, { from: file, by: "pat" }, capture().io, { now: NOW })).toBe(0);
      expect(
        await changeNew(
          root,
          { title: "Cap transfers", type: "feature", by: "pat" },
          capture().io,
          {
            now: NOW,
          },
        ),
      ).toBe(0);
      const s = await startServer({
        root,
        port: 0,
        user: "pat",
        extend: (r, ctx) => uiRoutes(r, ctx),
      });
      try {
        const get = async (path: string) => {
          const res = await fetch(`${s.url}${path}`, { headers: { "X-Atticus-Token": s.token } });
          expect(res.status).toBe(200);
          return res.json() as Promise<unknown>;
        };
        const rows = Api.ChangeSummary.array().parse(await get("/api/changes"));
        expect(rows.map((r) => [r.id, r.quickPath])).toEqual([
          ["cap-transfers", undefined],
          ["shipped-orders-event", true],
        ]);
        const one = (await get("/api/changes/shipped-orders-event")) as { quickPath?: boolean };
        expect(one.quickPath).toBe(true);
        const other = (await get("/api/changes/cap-transfers")) as { quickPath?: boolean };
        expect(other.quickPath).toBeUndefined();
      } finally {
        await s.close();
      }
    },
    T,
  );
});
