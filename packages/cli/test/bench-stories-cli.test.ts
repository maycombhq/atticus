import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { BenchStory } from "@maycombhq/evals";
import { main } from "../src/main.js";

/**
 * atticus bench stories --draft <file> (Phase B's first ticket): a drafted story scored against
 * its reference in bench/stories. Reads the repo's bench folder; no clone, no network.
 */

const BENCH = join(__dirname, "..", "..", "..", "bench");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** An invented, thin draft of the microchip story: one step, one invented field. */
const DRAFT = `schemaVersion: 1
story: petclinic-pet-microchip
title: Microchips on pets
repos: [spring-petclinic-rest]
steps:
  - id: api
    repo: spring-petclinic-rest
    what: PetFields gets microchip
    at: "src/main/resources/openapi.yml:2170"
criteria:
  - id: c1
    step: api
    given: the API
    when: a pet is added with a chip
    then: the response has microchip and chipVendor
    fields: [microchip, chipVendor]
    errors:
      - { field: microchip, rule: format, status: 400, when: not 15 digits, then: answers 400 }
`;

describe("atticus bench stories", () => {
  it("scores a draft against its reference story and fails on an invented field", async () => {
    const top = await mkdtemp(join(tmpdir(), "atticus-bench-stories-"));
    const draft = join(top, "draft.yaml");
    await writeFile(draft, DRAFT);
    const args = [
      "bench",
      "stories",
      "--draft",
      draft,
      "--bench",
      BENCH,
      "--cache",
      join(top, "c"),
    ];
    const r = io();
    // An invented field is a hard failure: exit 1.
    expect(await main([...args, "--json"], r.io), r.err.join("\n")).toBe(1);
    const s = JSON.parse(r.out.join("\n"));
    expect(s.story).toBe("petclinic-pet-microchip");
    expect(s.steps).toMatchObject({ found: 1, total: 8 });
    expect(s.errors).toMatchObject({ found: 1, total: 5 });
    expect(s.invented).toEqual(["chipVendor"]);

    const t = io();
    expect(await main(args, t.io)).toBe(1);
    const text = t.out.join("\n");
    expect(text).toMatch(/Changed steps\s+1 of 8/);
    expect(text).toMatch(/Invented fields\s+chipVendor/);
    expect(text).toMatch(/Rubric sections\s+4 of 17/);

    // A field the repo's facts know is not invented.
    const facts = join(top, "facts.jsonl");
    await writeFile(
      facts,
      JSON.stringify({
        kind: "field",
        id: "f1",
        repo: "spring-petclinic-rest",
        commit: "afc8fc1",
        owner: "f1",
        name: "chipVendor",
        cite: { file: "a.java", line: 1, value: "chipVendor" },
      }) + "\n",
    );
    const k = io();
    expect(await main([...args, "--facts", facts, "--json"], k.io), k.err.join("\n")).toBe(0);
    expect(JSON.parse(k.out.join("\n")).invented).toEqual([]);
  });

  it("says what is wrong with a draft it can't score", async () => {
    const top = await mkdtemp(join(tmpdir(), "atticus-bench-stories-"));
    const r = io();
    expect(await main(["bench", "stories", "--bench", BENCH], r.io)).toBe(2);
    expect(r.err.join("\n")).toMatch(/--draft/);
    const other = join(top, "other.yaml");
    await writeFile(other, DRAFT.replace("petclinic-pet-microchip", "no-such-story"));
    const r2 = io();
    expect(await main(["bench", "stories", "--draft", other, "--bench", BENCH], r2.io)).toBe(2);
    expect(r2.err.join("\n")).toMatch(/no reference story no-such-story/);
  });
});

/**
 * atticus bench stories --change <change> --story <id> (B-stories-bench): the stories the stories
 * stage drafted for a change, read from its folder, converted to a BenchStory and scored. The
 * invented Forge fraud check (fixtures/stages/), scored against an invented reference story in
 * fixtures/stages/stories-bench/bench/.
 */
const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const STAGES = join(FIXTURES, "stages");
const SB = join(STAGES, "stories-bench");

/** A metarepo with the Forge estate and add-fraud-check drafted to its stories. */
async function draftedMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-bench-change-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const put = async (dir: string, rows: unknown[]) => {
    for (const r of rows) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
      const f = join(root, dir, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  };
  const rows = (f: string) => parse(readFileSync(f, "utf8")) as unknown[];
  await put("catalog/generated", [
    ...rows(join(FIXTURES, "specs", "catalog.yaml")),
    ...rows(join(STAGES, "catalog-extra.yaml")),
  ]);
  await put("knowledge/items", rows(join(STAGES, "knowledge.yaml")));
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  const dir = join(root, "openspec/changes/add-fraud-check");
  const flows = (
    parse(readFileSync(join(STAGES, "stories", "deltas.yaml"), "utf8")) as {
      flows: { flow: string }[];
    }
  ).flows;
  await mkdir(join(dir, "target-flows"), { recursive: true });
  for (const f of flows)
    await writeFile(
      join(dir, "target-flows", `${f.flow}.yaml`),
      stringify({ schemaVersion: 2, ...f }),
    );
  await mkdir(join(dir, "stage"), { recursive: true });
  await cp(join(STAGES, "stories", "answer.yaml"), join(dir, "stage", "stories-answer.yaml"));
  return root;
}

describe("atticus bench stories --change", () => {
  it("converts the change's drafted stories to the golden draft and scores it", async () => {
    const root = await draftedMetarepo();
    const out = join(root, "draft.yaml");
    const args = [
      "bench",
      "stories",
      "--change",
      "add-fraud-check",
      "--story",
      "forge-fraud-check",
      "--root",
      root,
      "--bench",
      join(SB, "bench"),
      "--cache",
      join(root, "no-cache"),
      "--out",
      out,
    ];
    const r = io();
    expect(await main([...args, "--json"], r.io), r.err.join("\n")).toBe(0);
    const want = BenchStory.parse(
      parse(readFileSync(join(SB, "expected", "forge-fraud-check.yaml"), "utf8")),
    );
    const got = BenchStory.parse(parse(await readFile(out, "utf8")));
    // The org pack's own done items aren't the converter's business: the rest is the golden.
    expect({ ...got, definitionOfDone: [] }).toEqual({ ...want, definitionOfDone: [] });
    expect(got.definitionOfDone).toEqual(expect.arrayContaining(want.definitionOfDone!));
    const s = JSON.parse(r.out.join("\n"));
    expect(s.steps).toMatchObject({ found: 3, total: 4, missed: ["checkout"] });
    expect(s.fields).toMatchObject({ found: 5, total: 6, missed: ["cardLast4"] });
    expect(s.errors).toMatchObject({ found: 3, total: 4 });
    expect(s.invented).toEqual([]);
    expect(s.sections).toMatchObject({ present: 17, total: 17 });

    // A change folder's path does as well as its id, and the text names the draft it wrote.
    const t = io();
    const byPath = args.map((a) =>
      a === "add-fraud-check" ? join(root, "openspec/changes/add-fraud-check") : a,
    );
    expect(await main(byPath, t.io), t.err.join("\n")).toBe(0);
    expect(t.out.join("\n")).toMatch(/Story forge-fraud-check/);
    expect(t.out.join("\n")).toMatch(/Changed steps\s+3 of 4/);
    expect(t.out.join("\n")).toContain(`Draft: ${out}`);
  });

  it("says what is missing when the change has no stories yet", async () => {
    const root = await draftedMetarepo();
    const r = io();
    expect(
      await main(
        [
          "bench",
          "stories",
          "--change",
          "bulk-orders",
          "--story",
          "forge-fraud-check",
          "--root",
          root,
          "--bench",
          join(SB, "bench"),
        ],
        r.io,
      ),
    ).toBe(2);
    expect(r.err.join("\n")).toMatch(/bulk-orders has no target flows|no stories/);
    const r2 = io();
    expect(
      await main(["bench", "stories", "--change", "add-fraud-check", "--root", root], r2.io),
    ).toBe(2);
    expect(r2.err.join("\n")).toMatch(/--story/);
  });
});
