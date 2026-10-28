import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { StepFact } from "../src/commands.js";
import { mapCommand } from "../src/map-commands.js";
import { readPlanProgress } from "../src/map-parts.js";

/**
 * The read ledger of a repo read in parts (ADR 0124 addendum A-ledger). A 13-part read used to
 * leave the person keeping the list by hand: `--estimate` planned the parts and nothing recorded
 * which were done. The plan is now a file beside the facts, and each part's state is read back
 * from the facts the reader wrote. No model, no network.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const rows = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";

/** The Forge ledger with four modules past one session, so it is read in parts. */
function bigRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-read-ledger-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  for (const m of ["accounts", "payments", "reports", "statements"])
    for (let c = 0; c < 10; c++)
      write(
        root,
        `${m}/src/main/java/forge/${m}/Part${c}.java`,
        `package forge.${m};\n\npublic class Part${c} {\n${rows(400, (i) => `  private final int value${i} = ${i}; // ${m}`)}}\n`,
      );
  return root;
}

const io = () => {
  const out: string[] = [];
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(`ERR ${l}`),
      report: (_f: StepFact) => {},
    },
  };
};

/** A reviewed line for every file a part's globs stand for: the part is then accounted for. */
function reviewPart(root: string, paths: readonly string[]) {
  const file = join(root, ".atticus", "facts", `${REPO}.reviewed.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    paths.map((p) => `${JSON.stringify({ path: p, why: "read; no fact to record" })}\n`).join(""),
  );
}

describe("the read ledger of a repo read in parts (A-ledger)", () => {
  it("writes the plan beside the facts, with every part to read and which comes next", async () => {
    const root = bigRepo();
    const o = io();
    expect(await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io)).toBe(0);
    const rel = ".atticus/facts/forge-ledger.read-plan.yaml";
    const plan = parse(await readFile(join(root, rel), "utf8"));
    expect(plan.schemaVersion).toBe(1);
    expect(plan.repo).toBe(REPO);
    expect(plan.commit).toBe(COMMIT);
    expect(plan.session).toBe(150_000);
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.parts[0].part).toBe(1);
    const p = await readPlanProgress(root, REPO, { commit: COMMIT });
    expect(p?.total).toBe(plan.parts.length);
    expect(p?.done).toBe(0);
    expect(p?.next?.part).toBe(1);
    expect(p?.stale).toBe(false);
    // The estimate says where the plan is and which part is next.
    const text = o.out.join("\n");
    expect(text).toContain(`Read plan: ${rel}`);
    expect(text).toMatch(
      new RegExp(
        `part 1 of ${plan.parts.length} is next \\(none of ${plan.parts.length} read yet\\)`,
      ),
    );
    expect(text).toMatch(/ {2}part 1 \(to read, about \d+ tokens, \d+ files\): accounts\/\*\*/);
  });

  it("counts a part done once the facts account for every folder it reads", async () => {
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const before = await readPlanProgress(root, REPO);
    const first = before!.parts[0]!;
    reviewPart(root, first.paths);
    const after = await readPlanProgress(root, REPO);
    expect(after!.parts[0]!.state).toBe("done");
    expect(after!.parts[0]!.covered).toEqual(first.paths);
    expect(after!.parts[0]!.left).toEqual([]);
    expect(after!.done).toBe(1);
    expect(after!.next?.part).toBe(2);
    // The estimate, run again, keeps the same plan and says what is left.
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    const text = o.out.join("\n");
    expect(text).toMatch(
      new RegExp(`part 2 of ${before!.total} is next \\(1 of ${before!.total} read\\)`),
    );
    expect(text).toMatch(/ {2}part 1 \(done, about \d+ tokens/);
    // The plan isn't re-planned at the same commit: a part already read stays part 1.
    const kept = parse(
      await readFile(join(root, ".atticus/facts/forge-ledger.read-plan.yaml"), "utf8"),
    );
    expect(kept.plannedAt).toBe(before!.plannedAt);
    expect(kept.parts[0].paths).toEqual(first.paths);
  });

  it("gives the plan and each part's state as JSON", async () => {
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const p = await readPlanProgress(root, REPO);
    reviewPart(root, p!.parts[0]!.paths);
    const j = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, json: true }, j.io);
    const r = JSON.parse(j.out.join("\n"));
    expect(r.parts.plan).toMatchObject({
      file: ".atticus/facts/forge-ledger.read-plan.yaml",
      total: p!.total,
      done: 1,
      next: 2,
      stale: false,
    });
    expect(r.parts.plan.parts[0]).toMatchObject({ part: 1, state: "done", left: [] });
  });

  it("has no plan for a repo that fits one session", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-read-ledger-small-"));
    cpSync(join(fixtures, "repo"), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    expect(o.out.join("\n")).not.toContain("Read plan:");
    expect(await readPlanProgress(root, REPO)).toBeUndefined();
  });

  it("reads a file too big for a session in line ranges, each done by the lines its facts cite", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-read-ranges-"));
    cpSync(join(fixtures, "repo"), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
    const spec = "oas/Forge_Ledger_1.0.yaml";
    write(
      root,
      spec,
      `openapi: 3.0.1\npaths:\n${rows(24_000, (i) => `  /v1/ledger/entries/${i}/lines/{lineId}/postings/{postingId}: { get: { operationId: getPosting${i} } }`)}`,
    );
    const o = io();
    expect(await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io)).toBe(0);
    const p = (await readPlanProgress(root, REPO))!;
    const ranges = p.parts.flatMap((x) => x.paths).filter((g) => g.startsWith(`${spec}#L`));
    expect(ranges.length).toBeGreaterThan(1);
    expect(o.out.join("\n")).toContain(`${spec}#L1-L`);
    const [first, second] = ranges as [string, string];
    const from = (g: string) => Number(/#L(\d+)-/.exec(g)![1]);
    // A kept fact citing a line in the first range accounts for it, and for no other.
    const facts = join(root, ".atticus", "facts", `${REPO}.jsonl`);
    writeFileSync(
      facts,
      `${JSON.stringify({ kind: "config", id: "k-spec", repo: REPO, commit: COMMIT, settingKind: "config", key: "openapi", value: "3.0.1", cite: { file: spec, line: 1, value: "3.0.1" } })}\n`,
    );
    const once = (await readPlanProgress(root, REPO))!;
    const covered = once.parts.flatMap((x) => x.covered);
    expect(covered).toContain(first);
    expect(covered).not.toContain(second);
    // A range read with nothing in it is reviewed by its own path.
    reviewPart(root, [second]);
    const twice = (await readPlanProgress(root, REPO))!;
    expect(twice.parts.flatMap((x) => x.covered)).toContain(second);
    expect(from(second)).toBeGreaterThan(1);
  });
});
