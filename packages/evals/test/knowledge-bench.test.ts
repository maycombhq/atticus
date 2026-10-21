import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { KNOWLEDGE_SCAN_OUTPUT } from "@maycombhq/knowledge";
import {
  parseKnowledgeReference,
  prepareKnowledgeBench,
  runKnowledgeBench,
  type KnowledgeReference,
} from "../src/index.js";

// ADR 0083: the knowledge bench, run with hand-written assistant answers (MockRuntime).

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "../../../bench/knowledge");
const REF = parseKnowledgeReference(readFileSync(join(BENCH, "reference.yaml"), "utf8"));
const NOW = new Date("2026-10-21T09:00:00Z");
const base = (p: string) => p.split("/").pop()!;

type Item = KnowledgeReference["items"][number] & Record<string, unknown>;

/** The assistant's scan answer, written from the reference's items (its quotes are exact). */
function scanAnswer(items: Item[], o: { conflicts?: unknown[]; extra?: unknown[] } = {}) {
  return stringify({
    items: [
      ...items.map((i) => ({
        kind: i.kind,
        id: i.id,
        title: i.title,
        applies_when: i.applies_when,
        ...(i.rules ? { rules: i.rules } : {}),
        ...(i.lead_time ? { lead_time: i.lead_time } : {}),
        ...(i.handled_by ? { handled_by: i.handled_by } : {}),
        ...(i.catalogue_item ? { catalogue_item: i.catalogue_item } : {}),
        ...(i.inputs ? { inputs: i.inputs } : {}),
        ...(i.steps ? { steps: i.steps } : {}),
        ...(i.status ? { status: i.status } : {}),
        source: { page: base(i.source.page), section: i.source.section, quote: i.source.quote },
        also_on: i.also_on.map((a) => ({ page: base(a.page), section: a.section, quote: a.quote })),
      })),
      ...(o.extra ?? []),
    ],
    conflicts:
      o.conflicts ?? REF.conflicts.map((c) => ({ about: c.about, pages: c.pages, says: c.says })),
    superseded: REF.superseded.map((s) => ({
      old: s.old,
      new: s.new,
      page: s.new,
      quote: s.quote,
    })),
  });
}

/** The assistant's answers to the questions, citing the listed items. */
const askAnswer = (cites: (k: number) => string[]) =>
  stringify({
    answers: REF.questions.map((q, k) => ({ question: k + 1, answer: q.answer, cites: cites(k) })),
  });

let work: string | undefined;
afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

async function run(scan: string, ask: string) {
  work = await mkdtemp(join(tmpdir(), "atticus-kbench-"));
  await prepareKnowledgeBench(BENCH, work);
  const runtime = new MockRuntime((r) => (r.outputPath === KNOWLEDGE_SCAN_OUTPUT ? scan : ask));
  return runKnowledgeBench({ bench: BENCH, work, runtime, now: NOW });
}

describe("the knowledge bench", () => {
  it("reads the reference: 37 items, 2 conflicts, 1 superseded page, 1 injection, 8 questions", () => {
    expect(REF.items).toHaveLength(37);
    expect(REF.conflicts).toHaveLength(2);
    expect(REF.superseded).toHaveLength(1);
    expect(REF.injections).toHaveLength(1);
    expect(REF.questions).toHaveLength(8);
  });

  it("scores a scan that extracts exactly the reference at 100%", async () => {
    const r = await run(
      scanAnswer(REF.items as Item[]),
      askAnswer((k) => REF.questions[k]!.items),
    );
    expect(r.status).toBe("scored");
    if (r.status !== "scored") return;
    expect(r.scanProblems).toEqual([]);
    const s = r.score;
    expect(s.items).toMatchObject({ found: 37, missed: 0, wrong: 0, precision: 1, recall: 1 });
    expect(s.quotes).toMatchObject({ correct: 37, of: 37 });
    expect(s.conflicts).toMatchObject({ flagged: 2, of: 2 });
    expect(s.superseded).toMatchObject({ flagged: 1, of: 1, itemsFromOldPages: [] });
    expect(s.injections).toMatchObject({ flagged: 1, of: 1, followed: [] });
    expect(s.questions).toMatchObject({ correct: 8, of: 8 });
  });

  it("counts what was missed, wrong and miscited", async () => {
    const items = (REF.items as Item[])
      .filter((i) => i.id !== "dns-entry-request" && i.id !== "kiln-ui")
      .map((i) =>
        i.id === "encryption"
          ? {
              ...i,
              source: {
                ...i.source,
                quote: "Everything is encrypted with the strongest cipher we own.",
              },
            }
          : i.id === "file-transfer"
            ? { ...i, kind: "standard" as const }
            : i,
      );
    const fromOldPage = {
      kind: "standard",
      id: "anvil-2-logs",
      title: "Anvil 2 log files",
      applies_when: "An Anvil 2 service writes logs.",
      source: {
        page: "anvil-logging-2023.md",
        section: "Logging",
        quote: "Services write logs to /var/log/anvil/<service>.log, rotated daily.",
      },
    };
    const r = await run(
      scanAnswer(items, {
        extra: [fromOldPage],
        conflicts: [
          {
            about: REF.conflicts[0]!.about,
            pages: REF.conflicts[0]!.pages,
            says: REF.conflicts[0]!.says,
          },
        ],
      }),
      askAnswer((k) => (k === 0 ? ["vendor-partner-gateway"] : REF.questions[k]!.items)),
    );
    expect(r.status).toBe("scored");
    if (r.status !== "scored") return;
    const s = r.score;
    // Missed: the two left out, the one whose quote isn't on its page, and file-transfer (as a
    // standard it is the wrong kind). Wrong: file-transfer as a standard.
    expect(s.items.missedIds.sort()).toEqual([
      "dns-entry-request",
      "encryption",
      "file-transfer",
      "kiln-ui",
    ]);
    expect(s.items.wrongIds).toEqual(["file-transfer"]);
    expect(s.items).toMatchObject({ found: 33, missed: 4, wrong: 1 });
    expect(s.superseded.itemsFromOldPages).toEqual([]);
    expect(r.scanProblems.join("\n")).toMatch(/anvil-2-logs: anvil-logging-2023.md is superseded/);
    expect(r.scanProblems.join("\n")).toMatch(/encryption: quote: the quote is not on the page/);
    expect(s.conflicts).toMatchObject({ flagged: 1, of: 2, missed: ["data-retention"] });
    const q1 = s.questions.results[0]!;
    expect(q1.correct).toBe(false);
    expect(q1.missing).toContain("vendor-onboarding");
    // Question 5 cites encryption, which is no item (refused); question 7 expects
    // file-transfer, which was not found as a pattern.
    expect(s.questions.correct).toBe(5);
  });

  it("waits for a hand-off, with the run to resume", async () => {
    work = await mkdtemp(join(tmpdir(), "atticus-kbench-"));
    await prepareKnowledgeBench(BENCH, work);
    const runtime = new (class extends MockRuntime {
      override async run(id: string) {
        return { ...(await this.result(id)), state: "waiting" as const };
      }
    })(() => "");
    const r = await runKnowledgeBench({ bench: BENCH, work, runtime, now: NOW });
    expect(r).toMatchObject({ status: "waiting", step: "scan" });
  });
});
