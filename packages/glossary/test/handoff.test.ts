import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime, MockRuntime } from "@maycombhq/ai";
import { changesDirOf } from "@maycombhq/core";
import {
  completeGlossaryDefinitions,
  GLOSSARY_CHANGE,
  GLOSSARY_OUTPUT,
  scanGlossary,
} from "../src/index.js";
import { metarepo } from "./helpers.js";

/**
 * The glossary definer in hand-off mode: `glossary scan` prepares the prompt and waits; when
 * `atticus handoff done` has the assistant's answer, `completeGlossaryDefinitions` saves the
 * definitions as proposals exactly as a model run's answer is saved.
 */

const NOW = new Date("2026-10-18T09:00:00Z");
const ANSWER =
  "terms:\n  - id: term.entry\n    definition: One posting to an account.\n    evidence: [ledger-db.entry]\n  - id: term.unknown\n    definition: Not a term it was given.\n    evidence: [ledger-db.entry]\n  - id: term.transfer\n    definition: Money moved out.\n    evidence: [not-a-record]\n";

const proposal = async (root: string, term: string) =>
  parse(
    await readFile(join(root, `catalog/proposals/glossaryterm/${term}.yaml`), "utf8"),
  ) as Record<string, unknown>;

describe("glossary scan in hand-off mode", () => {
  it("waits for the assistant and saves nothing yet", async () => {
    const root = await metarepo();
    const runtime = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const r = await scanGlossary(root, { runtime, now: NOW });
    expect(r.propose?.waiting).toMatch(/^run-\d+-\d+$/);
    expect(r.propose?.proposals).toEqual([]);
    const prompt = await readFile(
      join(root, ".runs", GLOSSARY_CHANGE, r.propose!.waiting!, "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain(`Write the result to openspec/changes/glossary/${GLOSSARY_OUTPUT}.`);
    expect(prompt).toContain("# Glossary definer");
    await expect(
      readFile(join(root, "catalog/proposals/glossaryterm/term.entry.yaml")),
    ).rejects.toThrow();
  });

  it("saves the definitions from the assistant's answer as a model run's would be saved, and applies them", async () => {
    const root = await metarepo();
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const waiting = await scanGlossary(root, { runtime: rt, now: NOW });
    const runId = waiting.propose!.waiting!;

    const out = join(changesDirOf(root), GLOSSARY_CHANGE, GLOSSARY_OUTPUT);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, ANSWER);
    const run = await rt.done(runId);
    expect(run.state).toBe("validated");

    const done = await completeGlossaryDefinitions(root, run, { now: NOW });
    expect(done.propose.proposals.map((p) => [p.term, p.definition, p.evidence])).toEqual([
      ["term.entry", "One posting to an account.", ["ledger-db.entry"]],
    ]);
    expect(done.propose.discarded).toEqual([
      { term: "term.unknown", reason: "term.unknown isn't one of the terms it was given" },
      { term: "term.transfer", reason: "it cites no record that uses the term" },
    ]);
    expect(done.terms.find((t) => t.id === "term.entry")).toMatchObject({
      definition: "One posting to an account.",
      flags: ["ai-proposed"],
    });
    expect(await proposal(root, "term.entry")).toMatchObject({
      term: "term.entry",
      agent: "glossary-definer",
      runId,
      at: "2026-10-18T09:00:00Z",
    });

    // The same proposal the model path saves for the same answer (apart from the run id).
    const other = await metarepo();
    await scanGlossary(other, { runtime: new MockRuntime(() => ANSWER), now: NOW });
    const { runId: _a, ...a } = await proposal(root, "term.entry");
    const { runId: _b, ...b } = await proposal(other, "term.entry");
    void _a;
    void _b;
    expect(a).toEqual(b);
    // The generated term files are written too, and a later scan keeps the proposal.
    expect(done.written).toContain("glossaryterm/term.entry.yaml");
    expect((await scanGlossary(root)).written).toEqual([]);
  });

  it("only takes terms the definer was sent", async () => {
    const root = await metarepo();
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const waiting = await scanGlossary(root, { runtime: rt, now: NOW });
    const runId = waiting.propose!.waiting!;
    const out = join(changesDirOf(root), GLOSSARY_CHANGE, GLOSSARY_OUTPUT);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, "terms: []\n");
    const run = await rt.done(runId);
    // The pack named only some terms; an answer for one it did not name is not taken.
    const trimmed = {
      ...run,
      request: {
        ...run.request,
        pack: {
          ...run.request.pack,
          manifest: {
            ...run.request.pack.manifest,
            sources: run.request.pack.manifest.sources.filter((s) => s.id !== "term.entry"),
          },
        },
      },
      output: ANSWER,
    };
    const done = await completeGlossaryDefinitions(root, trimmed, { now: NOW });
    expect(done.propose.proposals).toEqual([]);
    expect(done.propose.discarded[0]).toEqual({
      term: "term.entry",
      reason: "term.entry isn't one of the terms it was given",
    });
  });
});
