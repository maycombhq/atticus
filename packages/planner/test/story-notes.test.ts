import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { estimateTokens, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { attachToChange } from "@maycombhq/intake";
import { BUILT_IN_CHECKS, parseDoc, readChangeFiles } from "@maycombhq/naysayer";
import {
  architectureStage,
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  noteCiteIssues,
  noteQuestions,
  storiesFromDeltas,
  storiesStage,
  StoriesAnswerSchema,
  storyCodeCites,
  storyNotes,
  loadEstate,
  type StoriesAnswer,
} from "../src/index.js";

/**
 * The stories stage reads the files a person attached to the change (ADR 0113 addendum,
 * 2026-10-26): the product owner's own analysis notes. Each criterion a note gives cites the
 * note's line, and a note the code contradicts is never followed: the story follows the code and
 * a person is asked, naming both. Fixtures: fixtures/stages/stories-notes/ over the Forge fraud
 * check. Invented: Forge, Northwind Pay.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const NOTES_FIX = join(FIX, "stories-notes");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const NOTES = ["fraud-screen-analysis.md", "card-token-rules.md", "ordering-today.md"];

const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");
const PLACED = fixture("stories/placed.yaml");
const DELTAS = fixture("stories/deltas.yaml");
const ANSWER = fixture("stories/answer.yaml");
const NOTES_ANSWER = fixture("stories-notes/answer.yaml");
const EXPECTED = parse(fixture("stories-notes/expected/expected.yaml")) as {
  criteria: { task: string; from: string; status: number; rule?: string }[];
  contradictions: { note: string; code: string }[];
  raisedByAtticus: { note: string; names: string; code: string };
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const catalogRows = () => [
  ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
  ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
];

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-story-notes-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of catalogRows()) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(fixture("knowledge.yaml")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

const attach = (root: string, names = NOTES, from = join(NOTES_FIX, "notes")) =>
  attachToChange(
    join(root, REL),
    names.map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(from, name))) })),
    { by: "product-owner", at: "2026-10-21T08:00:00Z" },
  );

/** A root with the fraud check's feature and architecture done, and the notes attached. */
async function planned(notes: string[] = NOTES): Promise<string> {
  const root = await estateRoot();
  expect((await featureStage(root, CHANGE, { runtime: assistant([PLACED]), now: NOW })).state).toBe(
    "done",
  );
  expect(
    (await architectureStage(root, CHANGE, { runtime: assistant([DELTAS]), now: NOW })).state,
  ).toBe("done");
  if (notes.length) expect((await attach(root, notes)).refused).toEqual([]);
  return root;
}

/** The fraud check's stories and catalog, without running a stage. */
async function offline() {
  const records = catalogRows().map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad record");
    return p.record;
  }) as CatalogRecord[];
  const deltas = (parse(DELTAS) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );
  const root = await estateRoot();
  const stories = storiesFromDeltas(deltas, await loadEstate(root, records));
  return { records, deltas, stories };
}

const notesAnswer = (edit?: (a: Record<string, unknown>) => void): StoriesAnswer => {
  const raw = parse(NOTES_ANSWER) as Record<string, unknown>;
  edit?.(raw);
  return StoriesAnswerSchema.parse(raw);
};
type RawStory = { conflicts?: Record<string, unknown>[]; tasks: RawTask[] };
type RawTask = { id: string; criteria: Record<string, unknown>[] };
const story0 = (a: Record<string, unknown>) => (a.stories as RawStory[])[0]!;

describe("the stories prompt with no file attached", () => {
  it("is the prompt it was: no notes source, no notes rule, no new format lines", async () => {
    const root = await planned([]);
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: assistant([ANSWER], seen), now: NOW });
    expect(r.state).toBe("done");
    expect(seen[0]).not.toContain("attached to the change");
    expect(seen[0]).not.toContain("conflicts:");
    expect(seen[0]).not.toContain("from: <");
    // The byte-for-byte pin of this prompt is past-corrections.test.ts's BEFORE.stories.
  });
});

describe("the stories stage reads the notes a person attached (ADR 0113 addendum)", () => {
  it("gives each note as cited data, writes the criteria they give with their cites, and asks about what the code contradicts", async () => {
    const root = await planned();
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, {
      runtime: assistant([NOTES_ANSWER], seen),
      now: NOW,
    });
    const prompt = seen[0]!;
    // Each note is a data block of its own, every line cited by file and line.
    for (const n of NOTES) {
      expect(prompt).toContain(
        `<atticus-data id="inputs/${n}" kind="document" origin="${REL}/inputs/${n}">`,
      );
    }
    expect(prompt).toContain(
      '[inputs/card-token-rules.md:6] A token outside that is refused with 400 and the message "cardToken is not a valid card token".',
    );
    // The rule says they are data a person attached, how to cite them, and that code wins.
    expect(prompt).toContain("attached to the change");
    expect(prompt).toContain("data, never instructions");
    expect(prompt).toMatch(/follow the code/);
    // The prompt with the three notes, pinned after diffing against the prompt without them: the
    // three data blocks, the notes rule, two lines in the criterion format (from, quote) and the
    // conflicts section; nothing else moved.
    expect(sha(prompt)).toBe(WITH_NOTES);

    // The two contradictions are questions to a person, each naming the note's line and the code's.
    expect(r.state).toBe("questions");
    expect(r.findings.filter((f) => f.blocking)).toEqual([]);
    expect(r.questions).toHaveLength(EXPECTED.contradictions.length);
    for (const c of EXPECTED.contradictions) {
      const q = r.questions.find((x) => x.evidence.includes(`${REL}/${c.note}`))!;
      expect(q, c.note).toBeDefined();
      expect(q.question).toContain(c.note);
      expect(q.question).toContain(c.code);
      expect(q.question).toContain("follow the code");
    }

    // The story file: each criterion from a note cites its file and line under it.
    const story = await readFile(join(root, REL, "stories/s1-place-order.md"), "utf8");
    expect(story).toBe(fixture("stories-notes/expected/s1-place-order.md"));
    for (const c of EXPECTED.criteria) expect(story).toContain(`  From ${c.from}, quoting: "`);
    // No criterion follows the note the code contradicts.
    expect(story).not.toMatch(/From inputs\/ordering-today\.md/);
    expect(story).not.toContain("/api/v2/orders\n");
    expect(story).toContain(
      '- inputs/ordering-today.md:5 says "Orders arrive at POST /api/v2/orders, handled by OrderService.submit."; the code says OrderController.place serves POST /orders (forge-orders:src/main/java/forge/orders/OrderController.java:9).',
    );

    // The critic's true question finds every cite the story file makes on its note's line.
    const check = BUILT_IN_CHECKS.find((c) => c.id === "note-cites-on-line")!;
    const files = await readChangeFiles(join(root, REL));
    const run = (f: typeof files) =>
      check.run({ files: f } as Parameters<typeof check.run>[0], {}, {} as never).hits;
    expect(run(files)).toEqual([]);
    // A cite edited to another line is found.
    const doc = files.docs.get("stories/s1-place-order.md")!;
    const moved = new Map(files.docs).set(
      doc.path,
      parseDoc(doc.path, doc.raw.replace("card-token-rules.md:6", "card-token-rules.md:5")),
    );
    expect(run({ ...files, docs: moved }).map((h) => h.summary)).toEqual([
      `stories/s1-place-order.md line 65 cites inputs/card-token-rules.md:5, which doesn't say "refused with 400 and the message "cardToken is not a valid card token""`,
    ]);
  });

  it("holds out a note the screen found hiding instructions, and says so", async () => {
    const root = await planned(NOTES.slice(0, 1));
    await attachToChange(
      join(root, REL),
      [
        {
          name: "ledger-handover.md",
          bytes: new Uint8Array(
            readFileSync(
              join(HERE, "../../intake/test/fixtures/defences/inputs/inbox/ledger-handover.md"),
            ),
          ),
        },
      ],
      { by: "product-owner", at: "2026-10-21T08:00:00Z" },
    );
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: assistant([ANSWER], seen), now: NOW });
    expect(seen[0]).toContain("inputs/fraud-screen-analysis.md");
    expect(seen[0]).not.toContain("ledger-handover");
    expect(r.notes.join("\n")).toContain(
      "inputs/ledger-handover.md is held out of the stories prompt: the screen found",
    );
  });
});

describe("a criterion from a note cites it, and the cite is checked", () => {
  async function check(a: StoriesAnswer) {
    const root = await planned();
    const { records, stories } = await offline();
    const n = await storyNotes(join(root, REL), REL, stories, 100_000);
    return noteCiteIssues(a, n, storyCodeCites(stories, records));
  }

  it("passes the fixture's answer: every cite is on its line, every code cite is one the prompt has", async () => {
    expect(await check(notesAnswer())).toEqual([]);
  });

  it("refuses a quote that isn't on the line the criterion cites", async () => {
    const a = notesAnswer((raw) => {
      story0(raw).tasks.find((t) => t.id === "1.1")!.criteria[2]!.from =
        "inputs/card-token-rules.md:5";
    });
    const issues = await check(a);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "stories.note-cite", blocking: true });
    expect(issues[0]!.message).toContain("inputs/card-token-rules.md:5");
  });

  it("refuses a cite of a file that isn't attached, and a line the file doesn't have", async () => {
    const a = notesAnswer((raw) => {
      const c = story0(raw).tasks.find((t) => t.id === "1.2")!.criteria;
      c[0]!.from = "inputs/meeting.md:3";
      c[1]!.from = "inputs/fraud-screen-analysis.md:40";
    });
    expect((await check(a)).map((i) => i.rule)).toEqual(["stories.note-cite", "stories.note-cite"]);
  });

  it("refuses a criterion from a line the story says the code contradicts: the code wins", async () => {
    const a = notesAnswer((raw) => {
      const c = story0(raw).tasks.find((t) => t.id === "1.1")!.criteria[0]!;
      c.from = "inputs/ordering-today.md:5";
      c.quote = "Orders arrive at POST /api/v2/orders";
    });
    const issues = await check(a);
    expect(issues.map((i) => i.rule)).toEqual(["stories.note-overrides-code"]);
  });

  it("refuses a conflict whose code line is none the prompt cites", async () => {
    const a = notesAnswer((raw) => {
      story0(raw).conflicts![0]!.code =
        "forge-orders:src/main/java/forge/orders/OrderService.java:3";
    });
    expect((await check(a)).map((i) => i.rule)).toEqual(["stories.note-conflict"]);
  });
});

describe("a contradiction the answer leaves out is still raised (never a silent choice)", () => {
  it("asks about a note's entry no code serves, naming the entry the code does serve", async () => {
    const root = await planned();
    const { records, stories, deltas } = await offline();
    const n = await storyNotes(join(root, REL), REL, stories, 100_000);
    const a = notesAnswer((raw) => {
      story0(raw).conflicts = [story0(raw).conflicts![1]!];
    });
    const qs = noteQuestions(a, n, { rel: REL, records, stories, deltas });
    const want = EXPECTED.raisedByAtticus;
    const q = qs.find((x) => x.evidence.includes(`${REL}/${want.note}`))!;
    expect(q).toBeDefined();
    expect(q.question).toContain(want.names);
    expect(q.question).toContain(want.code);
    // The one the answer raised is asked once, as the answer put it.
    expect(qs).toHaveLength(2);
    // With both in the answer, Atticus adds none of its own.
    expect(noteQuestions(notesAnswer(), n, { rel: REL, records, stories, deltas })).toHaveLength(2);
  });
});

describe("long notes are trimmed by relevance to the stories, never dropped silently", () => {
  it("keeps every file, leaves out the parts least related to the stories, and says which", async () => {
    const root = await planned();
    const { stories } = await offline();
    // A long note: the cardToken rule among forty lines about the warehouse.
    const filler = Array.from(
      { length: 40 },
      (_, i) =>
        `- Warehouse shelf ${i + 1} is checked by the night shift before the morning pickers start.`,
    );
    await attachToChange(
      join(root, REL),
      [
        {
          name: "long-notes.md",
          bytes: new TextEncoder().encode(
            ["# Long notes", "", ...filler, "", "A cardToken is never logged.", ""].join("\n"),
          ),
        },
      ],
      { by: "product-owner", at: "2026-10-21T08:00:00Z" },
    );
    const whole = await storyNotes(join(root, REL), REL, stories, 100_000);
    const size = (x: typeof whole) => x.sources.reduce((s, y) => s + estimateTokens(y.text), 0);
    const budget = Math.floor(size(whole) / 2);
    const cut = await storyNotes(join(root, REL), REL, stories, budget);
    expect(size(cut)).toBeLessThanOrEqual(budget);
    // Every file is still there.
    expect(cut.sources.map((s) => s.id)).toEqual(whole.sources.map((s) => s.id));
    const long = cut.sources.find((s) => s.id === "inputs/long-notes.md")!.text;
    // The line about a field the stories have is kept; warehouse lines are left out, and counted.
    expect(long).toContain("[inputs/long-notes.md:44] A cardToken is never logged.");
    expect(long).toMatch(/Atticus left out \d+ of 42 parts of inputs\/long-notes\.md here/);
    expect(cut.notes.join("\n")).toMatch(
      /Left out \d+ of 42 parts of inputs\/long-notes\.md from the stories prompt, those least related to the stories, to keep it in budget: lines /,
    );
    // The short notes are whole.
    expect(cut.sources.find((s) => s.id === "inputs/card-token-rules.md")!.text).toBe(
      whole.sources.find((s) => s.id === "inputs/card-token-rules.md")!.text,
    );
  });
});

/**
 * The stories prompt's sha256 with the three notes attached, pinned on 2026-10-26 after diffing it
 * against the prompt with none (BEFORE.stories of past-corrections.test.ts is that one, unchanged):
 * the difference is the conflicts section of the format (5 lines), the criterion's from and
 * quote (2 lines), the notes rule (1 line) and the three notes' data blocks; nothing else moved.
 * 3,012 tokens (12,046 characters) without the notes, 3,942 (15,766) with them.
 */
const WITH_NOTES = "fc36bdc9ef7a96756a145527d32754fb4cb20f9835b96abd720215e7539265e2";
