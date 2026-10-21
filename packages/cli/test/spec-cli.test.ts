import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  listQuestions,
  parseRecord,
  readRepoSpec,
  readSpecFindings,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { specCheck, specDraft } from "../src/spec-commands.js";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/specs");
const T1 = new Date("2026-10-21T12:00:00Z");
const T2 = new Date("2026-10-21T13:00:00Z");
const T3 = new Date("2026-10-21T14:00:00Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the fixture catalog, and the fixture repo as a folder beside it. */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), "atticus-spec-cli-"));
  const root = join(base, "meta");
  const repo = join(base, "forge-orders");
  await cp(join(SPECS, "repos", "forge-orders"), repo, { recursive: true });
  for (const r of parse(await readFile(join(SPECS, "catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const file = join(root, "catalog", "generated", recordPath(p.record));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  }
  await mkdir(join(root, "org-pack"), { recursive: true });
  return { root, repo };
}

const ANSWER = readFileSync(join(SPECS, "answers", "forge-orders.yaml"), "utf8");
// The get-order respond step sends a field nothing before it names: a finding for the critic.
const WITH_FINDING = ANSWER.replace(
  "        what: 200 with the order\n        data: { returns: [id, sku, quantity] }",
  "        what: 200 with the order\n        data: { returns: [id, sku, quantity], sends: [colour] }",
);

describe("atticus spec draft and atticus spec check (ADR 0079)", () => {
  it("drafts, checks, hands findings back on a redraft, and asks a person when one comes back", async () => {
    const { root, repo } = await setup();
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return WITH_FINDING;
      },
      { now: () => T1 },
    );
    const d1 = io();
    expect(await specDraft(root, repo, {}, { runtime, now: T1 }, d1.io)).toBe(0);
    expect(d1.out).toEqual([
      "Wrote 2 flows in specs/forge-orders/ (template default@1):",
      "  forge-orders.get-order: A client reads an order, or cancels it (3 steps, 2 confirmed by the check, stands for 1 more)",
      "  forge-orders.place-order: A client places an order (5 steps, 3 confirmed by the check)",
      expect.stringMatching(/^1 question for a person, in questions\/:$/),
      expect.stringMatching(
        /^ {2}q-[0-9a-f]{12} Does cancelling an order also release the stock it reserved\?$/,
      ),
      "Next: atticus spec check forge-orders, then review specs/forge-orders/ in a pull request.",
    ]);
    const spec = await readRepoSpec(root, "forge-orders");
    expect(spec.problems).toEqual([]);
    expect(spec.header).toMatchObject({
      repo: "forge-orders",
      template: "default@1",
      templateReviewed: true,
      drafted: { at: T1.toISOString() },
      flows: ["forge-orders.get-order", "forge-orders.place-order"],
    });
    expect(Object.keys(spec.header!.files)).toEqual([
      "src/main/java/forge/orders/OrderController.java",
      "src/main/java/forge/orders/StockClient.java",
    ]);
    expect(spec.header!.questions).toHaveLength(1);

    // The first check: one finding, seen once.
    const c1 = io();
    expect(await specCheck(root, repo, { now: T1 }, c1.io)).toBe(1);
    expect(c1.out[0]).toBe(
      "forge-orders: 2 flows, 8 steps; 3 of 3 triggers in the catalog have a flow; the check confirmed 5 steps on its cited lines.",
    );
    expect(c1.out).toContain(
      "  [field-from-nowhere] forge-orders.get-order step 3 (respond) uses colour, which no earlier step or the trigger names",
    );
    expect((await readSpecFindings(root, "forge-orders"))!.findings.map((f) => f.seen)).toEqual([
      1,
    ]);

    // A redraft is told the finding and drafts get-order again; the assistant gets it wrong again.
    const d2 = io();
    expect(await specDraft(root, repo, {}, { runtime, now: T2 }, d2.io)).toBe(0);
    expect(d2.out[0]).toBe(
      "The last spec check found problems in forge-orders.get-order; they are drafted again.",
    );
    expect(prompts[1]).toContain(
      "The last spec check found these. Fix each in the flows you write:",
    );
    expect(prompts[1]).toContain("which you don't write again: forge-orders.place-order");

    // The same finding after a redraft becomes a question (plan principle 4).
    const c2 = io();
    expect(await specCheck(root, repo, { now: T2 }, c2.io)).toBe(1);
    const f2 = (await readSpecFindings(root, "forge-orders"))!.findings;
    expect(f2.map((f) => f.seen)).toEqual([2]);
    expect(f2[0]!.question).toMatch(/^q-[0-9a-f]{12}$/);
    const asked = (await listQuestions(root, { step: "spec-check" })).questions;
    expect(asked.map((q) => [q.id, q.evidence, q.rerun])).toEqual([
      [
        f2[0]!.question,
        ["src/main/java/forge/orders/OrderController.java:19"],
        "atticus spec draft forge-orders",
      ],
    ]);
    expect(c2.out.at(-2)).toMatch(/came back unchanged after a redraft, so it is now a question/);

    // A changed file marks the flows that cite it stale.
    const file = join(repo, "src", "main", "java", "forge", "orders", "StockClient.java");
    await writeFile(file, (await readFile(file, "utf8")) + "// moved\n");
    const c3 = io();
    expect(await specCheck(root, repo, { json: true, now: T3 }, c3.io)).toBe(1);
    const j = JSON.parse(c3.out.join("\n")) as { findings: { rule: string; target: string }[] };
    expect(j.findings.filter((f) => f.rule === "stale").map((f) => f.target)).toEqual([
      "forge-orders.place-order",
    ]);
  });

  it("says when there is nothing to draft or no spec to check", async () => {
    const { root, repo } = await setup();
    const none = io();
    expect(await specCheck(root, repo, {}, none.io)).toBe(2);
    expect(none.err[0]).toBe(
      "forge-orders has no spec yet. Draft it: atticus spec draft forge-orders",
    );
    const runtime = new MockRuntime(() => ANSWER, { now: () => T1 });
    expect(await specDraft(root, repo, {}, { runtime, now: T1 }, io().io)).toBe(0);
    expect(await specCheck(root, repo, { now: T1 }, io().io)).toBe(0);
    const again = io();
    expect(await specDraft(root, repo, {}, { runtime, now: T2 }, again.io)).toBe(0);
    expect(again.out).toEqual([
      "Every trigger of forge-orders has a flow, no cited file changed and the last check found nothing to fix. Re-run with --force to draft the spec again.",
    ]);
    expect(await specDraft(root, "nowhere-at-all", {}, { runtime }, io().io)).toBe(2);
  });
});
