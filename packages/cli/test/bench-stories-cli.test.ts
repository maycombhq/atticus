import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
