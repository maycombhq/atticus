import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  Api,
  DEFAULT_CHANGE_TYPES,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
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
        "Next: hand the cleared requirements to the spec writer: /define-change shipped-orders-event. Then a person runs atticus change handoff shipped-orders-event --approve.",
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

/** Every file under a folder with its bytes' hash, so "nothing was written" is checked whole. */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const f = join(e.parentPath, e.name);
      out[f] = createHash("sha256")
        .update(await readFile(f))
        .digest("hex");
    }
  return out;
}

describe("the door check: what counts as in the map, and what it leaves on disk", () => {
  const cites = (evidence: string) =>
    [
      "# Shipped-orders event",
      "",
      "## QA",
      "",
      ...HEADER,
      `| Who else is touched? | ${evidence} | qa-naysayer | pat | Checked | answered |`,
      "",
    ].join("\n");

  it(
    "--check writes nothing: the whole tree is byte for byte what it was, pass or refuse",
    async () => {
      const { root, file } = await withFile(requirements());
      const before = await tree(root);
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, capture().io)).toBe(0);
      expect(await tree(root)).toEqual(before);
      await writeFile(file, cites("forge-nowhere"));
      const again = await tree(root);
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, capture().io)).toBe(1);
      expect(await tree(root)).toEqual(again);
    },
    T,
  );

  it(
    "takes what the personas' map tools return: an open change, an owner, a topic by its name",
    async () => {
      const { root, file } = await withFile(
        cites(
          "`beta-two`; `team-ledger`, `transfers.completed`; `/transfers`; `topic.payments-initiated`",
        ),
      );
      expect(
        await changeNew(root, { title: "Beta two", type: "feature", by: "pat" }, capture().io, {
          now: NOW,
        }),
      ).toBe(0);
      const c = capture();
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, c.io)).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out).toEqual([
        `${file} passes: 1 question (1 answered, 0 accepted), 5 ids in the map, 0 planned.`,
      ]);
      // A change that isn't there, a team nobody names and a name no record has are still refused.
      await writeFile(file, cites("`beta-nine`; `team-nobody`; `orders.shipped`"));
      const r = capture();
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, r.io)).toBe(1);
      expect(r.err[0]).toBe(`Refused: 3 problems in ${file}.`);
    },
    T,
  );

  it(
    "refuses a name two records have, and says to use the id",
    async () => {
      const { root, file } = await withFile(cites("`transfers.completed`"));
      const twin = parseRecord({
        schemaVersion: 1,
        status: "current",
        kind: "Endpoint",
        id: "topic.transfers-completed-v2",
        confidence: "verified",
        component: "ledger-api",
        endpointType: "event-topic",
        pathOrTopic: "transfers.completed",
        evidence: [{ source: "manual", by: "pat" }],
      });
      if (!twin.ok) throw new Error("bad fixture record");
      await writeFile(
        join(root, "catalog/generated", recordPath(twin.record)),
        serializeRecord(twin.record),
      );
      const c = capture();
      expect(await changeNew(root, { from: file, check: true, by: "pat" }, c.io)).toBe(1);
      expect(c.err).toEqual([
        `Refused: 1 problem in ${file}.`,
        `requirements.unknown-id: ${file}:7: the evidence names transfers.completed, which matches several records of the map (topic.transfers-completed, topic.transfers-completed-v2). Name the id of the one meant.`,
      ]);
    },
    T,
  );

  it(
    "says in JSON too when the file can't be read",
    async () => {
      const root = await forgeRoot();
      const file = join(root, "nowhere.md");
      const c = capture();
      expect(await changeNew(root, { from: file, check: true, json: true, by: "pat" }, c.io)).toBe(
        1,
      );
      expect(c.err[0]).toMatch(/^Can't read /);
      const said = JSON.parse(c.out.join("\n")) as {
        ok: boolean;
        reasons: { code: string; line: number; role: string; message: string }[];
      };
      expect(said.ok).toBe(false);
      expect(said.reasons).toHaveLength(1);
      expect(said.reasons[0]).toMatchObject({ code: "requirements.unreadable", line: 0, role: "" });
      expect(said.reasons[0]!.message).toBe(c.err[0]);
    },
    T,
  );

  it(
    "never writes over a requirements.md that is in the folder: refused when it differs, kept when it is the same",
    async () => {
      const { root, file } = await withFile(requirements());
      const dir = join(root, "openspec/changes/new-portal");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "proposal.md"), "# A new portal\n");
      await writeFile(join(dir, "requirements.md"), "# Its own requirements\n");
      const before = await tree(root);
      const c = capture();
      expect(await changeNew(root, { from: file, id: "new-portal", by: "pat" }, c.io)).toBe(1);
      expect(c.err).toEqual([
        `openspec/changes/new-portal/requirements.md is there already and differs from ${file}. Make the two the same, or pass another --id. Nothing was written.`,
      ]);
      expect(await tree(root)).toEqual(before);
      await writeFile(join(dir, "requirements.md"), await readFile(file));
      const k = capture();
      expect(
        await changeNew(root, { from: file, id: "new-portal", by: "pat" }, k.io, { now: NOW }),
      ).toBe(0);
      expect(k.out[0]).toBe(`Created new-portal (quick, from ${file}). It is in plan.`);
      expect(existsSync(join(dir, "brief.md"))).toBe(false);
    },
    T,
  );

  it(
    "names the shape when the organisation's own type quick doesn't have it",
    async () => {
      const { root, file } = await withFile(requirements());
      await writeFile(
        join(root, "org-pack/change-types.yaml"),
        "schemaVersion: 2\ntypes:\n  - id: quick\n    name: Forge quick\n    phases: [define, build]\n    artifacts: [proposal, tasks]\n",
      );
      const c = capture();
      expect(await changeNew(root, { from: file, by: "pat" }, c.io)).toBe(1);
      expect(c.err).toEqual([
        "This org pack's change type quick doesn't have the quick path's shape (its only phase before build is plan; it lists specs, no brief and no stories; it isn't small), and no other type has it. Give a type that shape in change-types.yaml, or pass --type <type>.",
      ]);
    },
    T,
  );
});

/**
 * The review of 2026-11-18 (blocker): the shape rule must not capture a type that plans another
 * way. Every built-in type, and an organisation's own small, brief-says-small and brief-led
 * types, get the next step they got before the quick path existed; only a type of the quick
 * shape gets `quick-define`, and it is asked only for the files its own artifacts name.
 */
describe("a change keeps the next step it had unless its type is quick", () => {
  const OWN = [
    "  - id: tweak",
    "    name: Tweak",
    "    size: small",
    "    phases: [plan, build]",
    "    artifacts: [brief, proposal, tasks]",
    "  - id: tweak-if-said",
    "    name: Tweak if the brief says",
    "    smallWhenBriefSays: true",
    "    phases: [plan, build]",
    "    artifacts: [proposal, tasks]",
    "  - id: briefed",
    "    name: Briefed",
    "    phases: [plan, build]",
    "    artifacts: [brief, proposal, tasks]",
    "  - id: plain",
    "    name: Plain",
    "    phases: [plan, build]",
    "    artifacts: [proposal, tasks]",
    "  - id: bare",
    "    name: Bare",
    "    phases: [plan]",
    "    artifacts: [proposal]",
    "  - id: spec-led",
    "    name: Spec-led",
    "    phases: [plan, build]",
    "    artifacts: [proposal, specs, tasks]",
    "",
  ].join("\n");

  it(
    "for every built-in type and each organisation shape",
    async () => {
      const root = await forgeRoot();
      await writeFile(
        join(root, "org-pack/change-types.yaml"),
        `${stringify({ schemaVersion: 2, types: DEFAULT_CHANGE_TYPES.types }, { lineWidth: 0 })}${OWN}`,
      );
      const types = [
        ...DEFAULT_CHANGE_TYPES.types.map((t) => t.id),
        "tweak",
        "tweak-if-said",
        "briefed",
        "plain",
        "bare",
        "spec-led",
      ];
      for (const type of types)
        expect(
          await changeNew(root, { title: `A ${type} one`, type, by: "pat" }, capture().io, {
            now: NOW,
          }),
          type,
        ).toBe(0);
      // A brief that says small, where the type lets it.
      const said = join(root, "openspec/changes/a-tweak-if-said-one/brief.md");
      await writeFile(said, `${await readFile(said, "utf8")}\nSize: small\n`);
      const s = await readNextState(root);
      const got = Object.fromEntries(
        s.changes.map((c) => [
          c.id.replace(/^a-|-one$/g, ""),
          [c.state, changeSteps(c)[0]?.step, c.quick ? "quick" : c.fast ? "fast" : "staged"],
        ]),
      );
      expect(got).toEqual({
        // As on release/b30, before the quick path: the state's own stage, or the fast path's step.
        feature: ["define", "brief", "staged"],
        integration: ["define", "brief", "staged"],
        "bug-fix": ["define", "feature", "staged"],
        "emergency-fix": ["build", "handoff", "staged"],
        "config-change": ["define", "feature", "staged"],
        "tech-debt": ["design", "feature", "staged"],
        "small-change": ["plan", "small", "fast"],
        tweak: ["plan", "small", "fast"],
        "tweak-if-said": ["plan", "small", "fast"],
        briefed: ["plan", "stories", "staged"],
        plain: ["plan", "stories", "staged"],
        bare: ["plan", "stories", "staged"],
        // Only a type deliberately shaped like `quick` (it lists specs): the built-in one and
        // an organisation's own.
        quick: ["plan", "quick-define", "quick"],
        "spec-led": ["plan", "quick-define", "quick"],
      });
    },
    T,
  );

  it(
    "asks a quick-shaped type only for the files its artifacts name, and reaches the hand-off",
    async () => {
      const root = await forgeRoot();
      await writeFile(join(root, "org-pack/change-types.yaml"), `schemaVersion: 2\ntypes:\n${OWN}`);
      expect(
        await changeNew(
          root,
          { title: "A spec-led one", type: "spec-led", by: "pat" },
          capture().io,
          {
            now: NOW,
          },
        ),
      ).toBe(0);
      const of = async () => {
        const c = (await readNextState(root)).changes.find((x) => x.id === "a-spec-led-one")!;
        return { quick: c.quick, step: changeSteps(c)[0]! };
      };
      const first = await of();
      // It lists no design, so design.md is never asked for.
      expect(first.quick).toEqual({
        missing: ["proposal.md", "a spec delta under specs/", "tasks.md"],
      });
      expect(first.step.why).toContain(
        "proposal.md, a spec delta under specs/ and tasks.md aren't written yet",
      );
      // No requirements file is there, so none is spoken of; the spec writer is named.
      expect(first.step.why).not.toContain("requirements");
      expect(first.step.why).toContain("to the spec writer: /define-change a-spec-led-one");
      const dir = join(root, "openspec/changes/a-spec-led-one");
      await cp(join(FORGE_CHANGE, "proposal.md"), join(dir, "proposal.md"));
      await cp(join(FORGE_CHANGE, "specs"), join(dir, "specs"), { recursive: true });
      await cp(join(FORGE_CHANGE, "tasks.md"), join(dir, "tasks.md"));
      const now = await of();
      expect(now.quick).toEqual({ missing: [] });
      expect(["handoff", "finding", "answer"]).toContain(now.step.step);
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
      expect(c.out[1]).toBe(
        "Next: atticus change status new-portal says what it still needs. Then a person runs atticus change handoff new-portal --approve.",
      );
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
      expect(first.c.quick?.missing).toEqual([
        "proposal.md",
        "a spec delta under specs/",
        "design.md",
        "tasks.md",
      ]);
      expect(first.own[0]).toMatchObject({
        step: "quick-define",
        command: `atticus change status ${id}`,
        slash: `/define-change ${id}`,
      });
      expect(first.own[0]!.why).toContain(
        "proposal.md, a spec delta under specs/, design.md and tasks.md aren't written yet: hand the cleared requirements to the spec writer: /define-change shipped-orders-event.",
      );
      expect(first.c.quick?.requirements).toBe(true);
      expect(first.own[0]!.person).toBeUndefined();

      await cp(join(FORGE_CHANGE, "proposal.md"), join(dir, "proposal.md"));
      await cp(join(FORGE_CHANGE, "specs"), join(dir, "specs"), { recursive: true });
      await cp(join(FORGE_CHANGE, "tasks.md"), join(dir, "tasks.md"));
      const second = await steps();
      expect(second.own[0]!.step).toBe("quick-define");
      expect(second.own[0]!.why).toContain("design.md isn't written yet");

      await cp(join(FORGE_CHANGE, "design.md"), join(dir, "design.md"));
      const third = await steps();
      expect(third.c.quick?.missing).toEqual([]);
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
    expect(blocked[0]!.why).toContain(
      "shipped-orders-event's files are written, but the plan gate is blocked",
    );
    expect(blocked[0]!.why).not.toContain("stage is done");
    // A template brief or a draft not written never turns a quick change back to a stage.
    const odd = changeSteps({
      ...base,
      quick: { missing: ["tasks.md"] },
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
