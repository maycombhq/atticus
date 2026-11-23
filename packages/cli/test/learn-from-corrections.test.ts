import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { ReadingRulesFile } from "@maycombhq/core";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";
import { learnFromCorrections, type LearnDeps } from "../src/learn-corrections.js";
import { effectiveRules } from "../src/reading-rules.js";
import {
  AT,
  callFact,
  CAPTURE,
  correctionsEstate,
  FILE,
  GW,
  LINES,
  pairLine,
} from "./corrections-estate.js";

/**
 * ADR 0208 (WP-03), Learn from my corrections: the person's pairings since the last run go to
 * the assistant with their cited lines; it drafts reading rules; each is tried by re-reading only
 * the files it names; a rule whose re-read reproduces the corrections and moves no arrow a person
 * touched is written active with its proof, any other stays a draft saying why. The assistant is
 * a recorded stand-in (an AcpStepRunner that writes what a session would): no network.
 */

const RULES = "org-pack/reading-rules/types/spring-boot.yaml";
const RULE =
  "A call's path is never the field that holds it: follow the field to the constant it is set from, and write that constant's value as the path.";
const KEY = "path-from-constant";
const ID = (line: number) => `forge-billing ${FILE}:${line}`;

let root: string;
beforeEach(async () => {
  root = await correctionsEstate("atticus-learn-");
});

const capture = (fact: string, line: number, value: string) =>
  pairLine(fact, line, value, {
    repo: GW,
    entry: CAPTURE,
    path: "/partners/northwind/charges/{chargeId}/capture",
  });

/** The person's three corrections: three fields' names paired with the capture route. */
async function threeCorrections() {
  await writeFile(
    join(root, "facts/forge-billing.jsonl"),
    (await readFile(join(root, "facts/forge-billing.jsonl"), "utf8")) +
      [
        callFact("call.post.capture-one", "captureOnePath", 33),
        callFact("call.post.capture-two", "captureTwoPath", 35),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") +
      "\n",
  );
  await writeFile(
    join(root, LINES),
    [
      capture("call.post.capture-charge", 31, "captureChargePath"),
      capture("call.post.capture-one", 33, "captureOnePath"),
      capture("call.post.capture-two", 35, "captureTwoPath"),
    ].join("\n") + "\n",
  );
}

/** A re-read's facts: each line's call, read with `path`. */
const reread = (paths: Record<number, string>, ids: Record<number, string>) =>
  Object.entries(paths)
    .map(([line, path]) => JSON.stringify({ ...callFact(ids[Number(line)]!, path, Number(line)) }))
    .join("\n") + "\n";
const IDS: Record<number, string> = {
  31: "call.post.capture-charge",
  33: "call.post.capture-one",
  35: "call.post.capture-two",
  42: "call.post.charges",
};

/** The stand-in assistant: drafts the rule, then re-reads with what `paths` says. */
function assistant(paths: Record<number, string>, o: { files?: string[] } = {}) {
  const steps: { change: string; line: string; writeRoots: string[] }[] = [];
  const runner: AcpStepRunner = async (s) => {
    steps.push({ change: s.change, line: s.line, writeRoots: s.writeRoots ?? [] });
    if (s.change === "rules-draft") {
      await mkdir(join(root, "org-pack/reading-rules/types"), { recursive: true });
      await writeFile(
        join(root, RULES),
        [
          "schemaVersion: 1",
          "rules:",
          `  - key: ${KEY}`,
          "    status: draft",
          `    rule: ${JSON.stringify(RULE)}`,
          `    files: ${JSON.stringify(o.files ?? ["src/main/java/**/*Client.java"])}`,
          `    example: "${FILE}:31"`,
          "",
        ].join("\n"),
      );
    } else {
      await mkdir(join(root, "facts/.try"), { recursive: true });
      await writeFile(join(root, `facts/.try/forge-billing.${KEY}.jsonl`), reread(paths, IDS));
    }
    return { stopReason: "end_turn", runId: `run-${steps.length}` } as never;
  };
  return { runner, steps };
}

const deps = (runner: AcpStepRunner, more: Partial<LearnDeps> = {}): LearnDeps => ({
  runner,
  by: "pat",
  now: AT,
  ...more,
});
const rulesFile = async () =>
  ReadingRulesFile.parse(parse(await readFile(join(root, RULES), "utf8")));

const CAPTURED = "/charges/{id}/capture";

describe("Learn from my corrections (ADR 0208)", () => {
  it("three corrections of one kind: one rule, written active with its proof, and given to every repo of the type", async () => {
    await threeCorrections();
    const a = assistant({ 31: CAPTURED, 33: CAPTURED, 35: CAPTURED });
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.corrections).toBe(3);
    // The draft is asked with each correction and its cited lines, as data.
    expect(a.steps[0]!.change).toBe("rules-draft");
    expect(a.steps[0]!.line).toContain(ID(31));
    expect(a.steps[0]!.line).toContain("post(captureChargePath, body);");
    // The re-read is of the files the rule names, and only those.
    expect(a.steps[1]!.line).toContain(`- \`${FILE}\``);
    expect(a.steps[1]!.writeRoots).toEqual([join(root, "facts/.try")]);
    expect(r.active).toEqual([{ key: KEY, file: RULES, reproduced: [ID(31), ID(33), ID(35)] }]);
    expect(r.draft).toEqual([]);
    const f = await rulesFile();
    expect(f.schemaVersion).toBe(2);
    expect(f.rules[0]).toMatchObject({
      key: KEY,
      status: "active",
      learned: {
        corrections: [ID(31), ID(33), ID(35)],
        by: "pat",
        run: "run-1",
        proof: { reread: [`forge-billing ${FILE}`], reproduced: [ID(31), ID(33), ID(35)] },
      },
    });
    // Active for the type: a read of another spring-boot repo is given it, with no person's input.
    const other = await effectiveRules(root, "forge-shop-bff");
    expect(other.rules.map((x) => x.key)).toContain(KEY);
    // The re-read's facts are a try: the facts on file are as they were.
    expect(await readFile(join(root, "facts/forge-billing.jsonl"), "utf8")).toContain(
      '"path":"captureOnePath"',
    );
  });

  it("a rule whose re-read doesn't reproduce a correction stays a draft, naming it", async () => {
    await threeCorrections();
    const a = assistant({ 31: CAPTURED, 33: CAPTURED, 35: "/charges" });
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.active).toEqual([]);
    expect(r.draft).toHaveLength(1);
    expect(r.draft[0]!.why).toContain(ID(35));
    const f = await rulesFile();
    expect(f.rules[0]).toMatchObject({ status: "draft", learned: { by: "pat" } });
    expect(f.rules[0]!.learned!.proof).toBeUndefined();
    expect(f.rules[0]!.learned!.why).toContain(ID(35));
  });

  it("a rule that would change a call a person declined stays a draft", async () => {
    await threeCorrections();
    await writeFile(
      join(root, LINES),
      (await readFile(join(root, LINES), "utf8")) +
        JSON.stringify({
          schemaVersion: 2,
          fact: "call.post.charges",
          target: { kind: "call", file: FILE, line: 42, value: "/charges" },
          action: "unlink",
          by: "dee",
          at: "2026-11-08T09:30:00.000Z",
        }) +
        "\n",
    );
    const a = assistant({ 31: CAPTURED, 33: CAPTURED, 35: CAPTURED, 42: "/charges/{id}/x" });
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.active).toEqual([]);
    expect(r.draft[0]!.why).toMatch(new RegExp(`${FILE}:42.*dee`));
  });

  it("a rule that would draw again an arrow a person deleted stays a draft", async () => {
    await threeCorrections();
    // The re-read also moves a call no one corrected onto the box whose arrow was deleted.
    const a = assistant({ 31: CAPTURED, 33: CAPTURED, 35: CAPTURED, 42: CAPTURED });
    const r = await learnFromCorrections(
      root,
      deps(a.runner, {
        deleted: async () => [
          { from: "forge-billing", to: GW, by: "dee", what: "billing-api → partner-gateway" },
        ],
      }),
    );
    expect(r.active).toEqual([]);
    expect(r.draft[0]!.why).toContain("billing-api → partner-gateway");
  });

  it("a rule that names none of the corrected files stays a draft", async () => {
    await threeCorrections();
    const a = assistant({ 31: CAPTURED }, { files: ["src/main/resources/**/*.yml"] });
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.active).toEqual([]);
    expect(r.draft[0]!.why).toMatch(/names none of the corrected files/);
    expect(a.steps.map((s) => s.change)).toEqual(["rules-draft"]);
  });

  it("run again with no new correction: nothing is asked and nothing is written", async () => {
    await threeCorrections();
    const a = assistant({ 31: CAPTURED, 33: CAPTURED, 35: CAPTURED });
    await learnFromCorrections(root, deps(a.runner));
    const before = await readFile(join(root, RULES), "utf8");
    const b = assistant({});
    const r = await learnFromCorrections(root, deps(b.runner));
    expect(r).toMatchObject({ corrections: 0, active: [], draft: [] });
    expect(b.steps).toEqual([]);
    expect(await readFile(join(root, RULES), "utf8")).toBe(before);
  });

  it("learns nothing from the AI's pairings, a spread's lines, or with AI off", async () => {
    await writeFile(
      join(root, LINES),
      [
        pairLine(
          "call.post.capture-charge",
          31,
          "captureChargePath",
          {
            repo: GW,
            entry: CAPTURE,
            path: "/x",
          },
          { run: "r0" },
        ),
        JSON.stringify({
          ...JSON.parse(capture("call.post.charges", 42, "/charges")),
          rule: { from: "link:forge-billing:call.post.capture-charge", match: "/charges/**" },
        }),
      ].join("\n") + "\n",
    );
    const a = assistant({});
    expect((await learnFromCorrections(root, deps(a.runner))).corrections).toBe(0);
    expect(a.steps).toEqual([]);
    await threeCorrections();
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      (await readFile(join(root, "org-pack/runtime.yaml"), "utf8")) + "ai: off\n",
    );
    await expect(learnFromCorrections(root, deps(a.runner))).rejects.toThrow(/AI off/);
  });
});
