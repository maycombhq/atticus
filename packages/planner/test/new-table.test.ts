import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { answerQuestion, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  architectureStage,
  checkDeltas,
  EXPAND_AGENT,
  FlowDelta,
  loadEstate,
  stageEnd,
  storeFacts,
  type StageResult,
} from "../src/index.js";

/**
 * A live run of the architecture stage on a chat app's change that adds a table, retold on the
 * Forge estate (fixtures/stages/pin-table): "pin an order note" adds forge-orders-db.order_pin,
 * which forge-orders.pin-note creates and forge-orders.unpin-note writes. Every flow change that
 * touched the table marked it new and restated part of it, so each draft got a type, a
 * classification, a migration or a retention wrong somewhere; the questions came one per flow
 * change and one per column; and the stop said two different things.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const PIN = join(FIX, "stages/pin-table");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "pin-order-note";
const TABLE = "forge-orders-db.order_pin";
const LEVELS = ["public", "internal", "confidential", "restricted"];
const draft = (name: string) => readFileSync(join(PIN, "drafts", `${name}.yaml`), "utf8");

async function pinRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-pin-table-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(PIN, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(PIN, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  return root;
}

/** A mock assistant: the expander finds nothing new, critics find nothing, drafts in turn. */
function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

async function estateOf(root: string) {
  const ctx = await loadChangeContext(root);
  return loadEstate(root, ctx.records);
}

const placement = (root: string) =>
  readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8").then(
    (t) => parse(t) as Parameters<typeof checkDeltas>[2],
  );

const deltasOf = (name: string) =>
  (parse(draft(name)) as { flows: unknown[] }).flows.map((f) =>
    FlowDelta.parse({ schemaVersion: 2, ...(f as object) }),
  );

async function check(name: string) {
  const root = await pinRoot();
  return checkDeltas(deltasOf(name), await estateOf(root), await placement(root), [], {
    levels: LEVELS,
  });
}

describe("a new table is defined once, by the step that creates it (A5)", () => {
  it("one finding per table for what belongs to the table, one per step for a value written wrong (fixtures/stages/pin-table)", async () => {
    const got = (await check("live")).filter((i) => i.blocking).map((i) => [i.rule, i.target]);
    const expected = parse(
      readFileSync(join(PIN, "expected/live-findings.yaml"), "utf8"),
    ) as string[][];
    expect(got).toEqual(expected);
  });

  it("a step that marks the table new again is one drafting finding naming every such step", async () => {
    const twice = (await check("live")).filter((i) => i.rule === "delta.table-new-twice");
    expect(twice).toHaveLength(1);
    expect(twice[0]!.message).toBe(
      "Table forge-orders-db.order_pin is marked new by change 2 to forge-orders.pin-note, change 2 to forge-orders.unpin-note and change 1 to forge-orders.open-order. Mark it new only on the step that creates it (change 2 to forge-orders.pin-note); every other step names the table without new and only the columns it uses, and takes the columns' types, classification, migration and retention from there.",
    );
  });

  it("a step that writes the table without new or a restatement inherits its definition", async () => {
    const got = await check("answered");
    expect(got.filter((i) => i.blocking)).toEqual([]);
  });

  it("a step that uses a column the creating step doesn't define is handed back, naming that step", async () => {
    const d = deltasOf("answered");
    d[1]!.steps[1]!.store!.columns = ["order_id", "colour"];
    const root = await pinRoot();
    const got = checkDeltas(d, await estateOf(root), await placement(root), [], {
      levels: LEVELS,
    }).filter((i) => i.blocking);
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.unknown-column", "forge-orders.unpin-note#2:colour"],
    ]);
    expect(got[0]!.message).toBe(
      "Change 2 to forge-orders.unpin-note uses column colour of forge-orders-db.order_pin, which change 2 to forge-orders.pin-note creates without it (its columns: order_id, note_id, pinned_by): use one of those, or add colour on that step with its type and classification.",
    );
  });
});

describe("every classification is checked against the org pack's levels, wherever it is written (A6)", () => {
  it("in a delta whose flow isn't in the specs, and on a step that only restates the table", async () => {
    const got = (await check("live")).filter((i) => i.rule === "delta.bad-classification");
    expect(got.map((i) => i.message)).toEqual([
      "Change 1 to forge-orders.open-order classifies column pinned_by as personal, which isn't one of the org pack's levels: public, internal, confidential or restricted. Write one of those words exactly.",
    ]);
    const d = deltasOf("answered");
    d[1]!.steps[1]!.store!.classification = { order_id: "personal" };
    const root = await pinRoot();
    const again = checkDeltas(d, await estateOf(root), await placement(root), [], {
      levels: LEVELS,
    }).filter((i) => i.rule === "delta.bad-classification");
    expect(again.map((i) => i.target)).toEqual(["forge-orders.unpin-note#2:order_id"]);
  });
});

describe("the hand-backs say exactly what is allowed (A1)", () => {
  it("the next free migration name in the store's pattern, the column needing a type with the store's types, the levels", async () => {
    const got = await check("live");
    const msg = (rule: string) => got.find((i) => i.rule === rule)!.message;
    expect(msg("delta.bad-migration")).toBe(
      "Change 2 to forge-orders.pin-note names the migration a new migration creating order_pin, which isn't how forge-orders-db's migrations are named (Flyway, the newest V3): name the file V4__<what_it_does>.sql, such as V4__create_order_pin.sql, in src/main/resources/db/migration.",
    );
    expect(msg("delta.no-type")).toBe(
      "Change 2 to forge-orders.pin-note creates table forge-orders-db.order_pin without a type for pinned_by: give it under store.types on that step, written as forge-orders-db's columns are (BIGINT, INT, TIMESTAMP, VARCHAR(40)).",
    );
    expect(msg("delta.sent-not-stored")).toContain(
      "sends pinnedAt to forge-orders-db.order_pin but stores it in no column",
    );
  });

  it("a migration left out is asked for by its next free name", async () => {
    const d = deltasOf("answered");
    delete d[0]!.steps[1]!.store!.migration;
    const root = await pinRoot();
    const got = checkDeltas(d, await estateOf(root), await placement(root), [], {
      levels: LEVELS,
    }).filter((i) => i.blocking);
    expect(got.map((i) => [i.rule, i.target, i.message])).toEqual([
      [
        "delta.no-migration",
        TABLE,
        "Change 2 to forge-orders.pin-note creates table forge-orders-db.order_pin without naming the migration: give store.migration on that step, named as forge-orders-db's migrations are: the next is V4__<what_it_does>.sql, in src/main/resources/db/migration.",
      ],
    ]);
  });

  it("the first draft's prompt carries the levels, up to three migration names with the next one, the types and the rule for what is sent", async () => {
    const root = await pinRoot();
    const prompts: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([draft("answered")], prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    const p = prompts[0]!;
    expect(p).toContain(
      "Classify each column a step adds as one of the org pack's levels, written exactly: public, internal, confidential or restricted.",
    );
    expect(p).toContain(
      "Mark a table new: true only on the one step that creates it; that step gives its columns, types, classification, migration and retention. Every other step that writes or reads it names the table without new and only the columns it uses.",
    );
    expect(p).toContain(
      "Every field a write sends is a column it stores (store.columns) or a key it matches rows by (fields.checks); leave anything else out of sends.",
    );
    expect(p).toContain(
      "- forge-orders-db (repo forge-orders): migrations in src/main/resources/db/migration, the newest V3__add_sku.sql, V2__add_quantity.sql, V1__create_orders.sql; the next is V4__<what_it_does>.sql. Column types as its tables write them: BIGINT, INT, TIMESTAMP, VARCHAR(40).",
    );
  });

  it("storeFacts names at most three migrations", async () => {
    const root = await pinRoot();
    const e = await estateOf(root);
    const text = storeFacts(e, ["forge-orders-db"]);
    expect(text.match(/__\w+\.sql/g)).toHaveLength(3);
  });
});

describe("a question about a table is asked once, for the table (A3)", () => {
  it("one retention question and one classification question listing the columns, however many flow changes touch it; the answers end it", async () => {
    const root = await pinRoot();
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([draft("undecided")]),
      now: NOW,
    });
    expect(r.state).toBe("questions");
    expect(r.questions.map((q) => q.question).sort()).toEqual([
      "How are the new columns note_id and order_id of forge-orders-db.order_pin classified?",
      "How long are the rows of the new table forge-orders-db.order_pin kept?",
    ]);
    const cls = r.questions.find((q) => q.question.startsWith("How are"))!;
    expect(cls.options.map((o) => o.label)).toEqual(LEVELS);
    expect(cls.options[1]!.changes).toBe(
      "The plan classifies forge-orders-db.order_pin.note_id and forge-orders-db.order_pin.order_id as internal",
    );
    for (const q of r.questions)
      await answerQuestion(
        root,
        q.id,
        q.options.length
          ? { option: 2, by: "pat", at: "2026-10-24T10:00:00Z" }
          : { text: "As long as the order", by: "pat", at: "2026-10-24T10:00:00Z" },
      );
    const done = await architectureStage(root, CHANGE, {
      runtime: assistant([draft("answered")]),
      now: NOW,
    });
    expect(done.state).toBe("done");
  });

  it("a retention that came back after a draft had it is one question for the table, in plain words", async () => {
    const root = await pinRoot();
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([
        draft("sends-extra-no-retention"),
        draft("sends-extra"),
        draft("sends-extra-no-retention"),
      ]),
      now: NOW,
    });
    expect(r.state).toBe("questions");
    expect(r.questions.map((q) => q.question)).toEqual([
      "How long are the rows of the new table forge-orders-db.order_pin kept?",
    ]);
  });
});

describe("a person's fix of a stopped stage is never drafted over (P1)", () => {
  const FILE = "target-flows/forge-orders.pin-note.yaml";
  const file = (root: string) => join(root, "openspec/changes", CHANGE, FILE);
  /** A person edits the pin-note target flow: the edit is applied to the file as YAML. */
  type Doc = {
    steps: { fields: { sends: string[] }; store: { classification: Record<string, string> } }[];
  };
  const edit = async (root: string, change: (d: Doc) => void, note = "") => {
    const d = parse(await readFile(file(root), "utf8")) as Doc;
    change(d);
    const { stringify } = await import("yaml");
    await writeFile(file(root), `${note}${stringify(d, { lineWidth: 0 })}`);
  };
  const dropPinnedAt = (d: Doc) => {
    d.steps[1]!.fields.sends = d.steps[1]!.fields.sends.filter((f: string) => f !== "pinnedAt");
  };
  /** The stage stopped on a drafting finding the assistant kept getting wrong. */
  async function stoppedStage() {
    const root = await pinRoot();
    const e = await architectureStage(root, CHANGE, {
      runtime: assistant([draft("sends-extra")]),
      now: NOW,
    }).then(
      () => undefined,
      (x: Error) => x,
    );
    expect(e?.message).toContain("kept getting this wrong");
    return root;
  }
  const counting = (prompts: string[]) => assistant([draft("sends-extra")], prompts);

  it("a person's fix that passes is checked and reviewed as their draft, with no redraft, and the loop says it was theirs", async () => {
    const root = await stoppedStage();
    await edit(root, dropPinnedAt, "# Fixed by pat: pinnedAt isn't stored.\n");
    const prompts: string[] = [];
    const r = await architectureStage(root, CHANGE, { runtime: counting(prompts), now: NOW });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(0);
    expect(prompts).toEqual([]);
    const on = parse(await readFile(file(root), "utf8"));
    expect(on.steps[1].fields.sends).toEqual(["orderId", "noteId", "pinnedBy"]);
    const loop = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "stage/architecture.yaml"), "utf8"),
    );
    expect(loop.byPerson).toEqual([
      {
        iteration: 4,
        at: "2026-10-24T09:00:00Z",
        files: [FILE],
        kept: `openspec/changes/${CHANGE}/stage/architecture-by-person/4/`,
        how: "checked",
      },
    ]);
    // A copy of exactly what the person wrote is kept, comment and all.
    expect(
      await readFile(
        join(root, "openspec/changes", CHANGE, "stage/architecture-by-person/4", FILE),
        "utf8",
      ),
    ).toContain("# Fixed by pat");
  });

  it("a person's fix that still fails stops with what fails, file and line, and leaves their file as it is; --force drafts from it", async () => {
    const root = await stoppedStage();
    await edit(root, (d) => {
      dropPinnedAt(d);
      d.steps[1]!.store.classification.pinned_by = "personal";
    });
    const theirs = await readFile(file(root), "utf8");
    const prompts: string[] = [];
    const e = await architectureStage(root, CHANGE, { runtime: counting(prompts), now: NOW }).then(
      () => undefined,
      (x: Error) => x,
    );
    expect(prompts).toEqual([]);
    expect(e?.message).toContain(
      `The architecture stage checked your edit of openspec/changes/${CHANGE}/${FILE} as its draft, and found a problem; it stopped rather than draft over your work.`,
    );
    expect(e?.message).toMatch(
      new RegExp(
        `classifies column pinned_by as personal.*\\(rule delta\\.bad-classification; at openspec/changes/${CHANGE}/target-flows/forge-orders\\.pin-note\\.yaml:\\d+\\)`,
      ),
    );
    expect(e?.message).toContain(`atticus change architecture ${CHANGE} --force`);
    expect(await readFile(file(root), "utf8")).toBe(theirs);
    // Run again without fixing: it stops again, and still never drafts over the file.
    await architectureStage(root, CHANGE, { runtime: counting(prompts), now: NOW }).catch(
      () => undefined,
    );
    expect(prompts).toEqual([]);
    expect(await readFile(file(root), "utf8")).toBe(theirs);
    // Asked for a redraft, the assistant starts from the person's files.
    await architectureStage(root, CHANGE, {
      runtime: assistant([draft("answered")], prompts),
      now: NOW,
      force: true,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('origin="the stage\'s files as a person edited them"');
    expect(prompts[0]).toContain("pinned_by: personal");
  });
});

describe("one stop, one message (A2)", () => {
  it("says the questions for a person first, then what the assistant kept getting wrong, and what to do in that order", async () => {
    const root = await pinRoot();
    const r: StageResult<unknown> = await architectureStage(root, CHANGE, {
      runtime: assistant([
        draft("sends-extra-no-retention"),
        draft("sends-extra"),
        draft("sends-extra-no-retention"),
      ]),
      now: NOW,
    });
    expect(r.state).toBe("questions");
    // The drafting stop is part of the end, not a note printed before it.
    expect(r.notes.join("\n")).not.toContain("kept getting");
    expect(r.stopped?.findings.map((f) => f.rule)).toEqual(["delta.sent-not-stored"]);
    const end = stageEnd(r, `atticus change architecture ${CHANGE}`);
    expect(end[0]).toBe(
      "The architecture stage stopped after 3 drafts: 1 question for a person to answer, and 1 problem your assistant kept getting wrong.",
    );
    const text = end.join("\n");
    expect(text.match(/stopped/g)).toHaveLength(1);
    expect(text.indexOf("How long are the rows")).toBeLessThan(text.indexOf("pinnedAt"));
    expect(end.at(-1)).toBe(
      `Answer the questions first, then run atticus change architecture ${CHANGE} again: the next draft gets your answers and the problems above. To fix the problems yourself instead, edit openspec/changes/${CHANGE}/target-flows/; Atticus checks your fix before it drafts again.`,
    );
  });

  it("the next draft after the answers is handed the problems the assistant kept getting wrong", async () => {
    const root = await pinRoot();
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([
        draft("sends-extra-no-retention"),
        draft("sends-extra"),
        draft("sends-extra-no-retention"),
      ]),
      now: NOW,
    });
    for (const q of r.questions)
      await answerQuestion(root, q.id, {
        text: "As long as the order",
        by: "pat",
        at: "2026-10-24T10:00:00Z",
      });
    const prompts: string[] = [];
    const done = await architectureStage(root, CHANGE, {
      runtime: assistant([draft("answered")], prompts),
      now: NOW,
    });
    expect(done.state).toBe("done");
    expect(prompts[0]).toContain("sends pinnedAt to forge-orders-db.order_pin");
  });
});
