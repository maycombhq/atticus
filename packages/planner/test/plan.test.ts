import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import { runCritic } from "@maycombhq/naysayer";
import { planStories, readStoryEval, snowDraft, storyBar } from "../src/index.js";
import {
  CHANGE,
  FIXTURES,
  FORGE_CHANGE,
  NOW,
  changeDir,
  forgeChangeRoot,
  read,
} from "./helpers.js";

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });

describe("planning artifacts from the approved design (golden)", () => {
  it("writes stories, the index, tasks and service-desk drafts as the expected files", async () => {
    const root = await forgeChangeRoot();
    const r = await planStories(root, CHANGE, { runtime: await replay(), now: new Date(NOW) });
    expect(r.state).toBe("written");
    expect(r.discarded).toEqual([]);
    expect(r.fallback).toEqual([]);
    expect(r.run).toMatchObject({ agent: "story-writer", runtime: "replay", state: "validated" });
    expect(r.skeleton.stories.map((s) => s.id)).toEqual([
      "s1-daily-transfer-limit",
      "s2-remaining-limit",
      "s3-northwind-pay-velocity-checks",
      "s4-audit-events",
      "s5-limit-change",
    ]);
    expect(r.skeleton.notPlanned).toEqual([
      {
        what: "POST /risk/assess (ledger-api → risk-engine)",
        why: "risk-engine is not in the catalog; the critic raises it, and the hop is planned once the catalog knows it",
        line: 9,
      },
    ]);
    const dir = changeDir(root);
    expect(await read(join(dir, "stories/s1-daily-transfer-limit.md"))).toBe(
      await read(join(FIXTURES, "expected/s1-daily-transfer-limit.md")),
    );
    expect(await read(join(dir, "tasks.md"))).toBe(await read(join(FIXTURES, "expected/tasks.md")));
    expect(await read(join(dir, "stories.md"))).toContain(
      "| s2-remaining-limit | Show how much of today's limit is left | forge-ledger, forge-portal-bff, forge-portal-ui | s1-daily-transfer-limit |",
    );

    const snow = await snowDraft(root, CHANGE);
    expect(snow.drafts.map((d) => [d.need.template.id, d.need.record])).toEqual([
      ["gateway-route", "gw-northwind-v2"],
      ["firewall-rule", "gw-northwind-v2"],
    ]);
    expect(await read(join(dir, "snow.md"))).toBe(await read(join(FIXTURES, "expected/snow.md")));
  });

  it("refuses to replace stories a person wrote, unless forced", async () => {
    const root = await forgeChangeRoot({ plan: true });
    await expect(
      planStories(root, CHANGE, { runtime: await replay(), now: new Date(NOW) }),
    ).rejects.toMatchObject({
      code: "refused",
      message:
        "add-transfer-limit already has planning files a person wrote: stories.md, tasks.md. Re-run with --force to replace them.",
    });
    await expect(snowDraft(root, CHANGE)).rejects.toMatchObject({ code: "refused" });
    const r = await planStories(root, CHANGE, {
      runtime: await replay(),
      now: new Date(NOW),
      force: true,
    });
    expect(r.files).toContain("stories/s5-limit-change.md");
    // The hand-written story files that no longer exist in the plan were removed.
    await expect(readFile(join(changeDir(root), "stories/s3-audit-refusals.md"))).rejects.toThrow();
  });

  it("uses plain prose a person words when there is no AI answer, and discards unknown stories", async () => {
    const root = await forgeChangeRoot();
    const answer = `stories:
  - id: s1-daily-transfer-limit
    title: Refuse transfers over the limit
    asA: Portal customer
    iWant: transfers over my limit refused
    soThat: my account can't be drained
    criteria:
      - { given: a limit of 1000 and 900 sent, when: 200 more is asked, then: it is refused and fraud-engine is told }
  - id: s9-made-up
    title: Something else
    asA: x
    iWant: y
    soThat: z
`;
    const mock = new MockRuntime(() => answer, { now: () => new Date(NOW) });
    const r = await planStories(root, CHANGE, { runtime: mock, now: new Date(NOW) });
    expect(r.discarded).toEqual([{ id: "s9-made-up", reason: "no story in the plan has this id" }]);
    expect(r.fallback).toEqual([
      "s2-remaining-limit",
      "s3-northwind-pay-velocity-checks",
      "s4-audit-events",
      "s5-limit-change",
    ]);
    const s2 = await read(join(changeDir(root), "stories/s2-remaining-limit.md"));
    expect(s2).toContain("# Remaining limit");
    expect(s2).toContain(
      "- Given remaining limit after transfers, when an account with a limit of 1000 has sent 900 today, then GET /accounts/{id}/limit returns limit 1000 and remaining 100. (specs/transfer-limits/spec.md:17)",
    );
    expect(s2).toContain("The story writer gave no prose for this story; a person words it.");
    // The bar sees the invented name in s1's prose.
    const bar = await storyBar(root, CHANGE);
    expect(bar.invented).toEqual(["s1-daily-transfer-limit: fraud-engine"]);
    expect(bar.met).toBe(false);
  });

  it("waits for the person's assistant in hand-off mode and writes nothing yet", async () => {
    const root = await forgeChangeRoot();
    const waiting = {
      kind: "hand-off" as const,
      async prepare(req: never) {
        return {
          runId: "run-1",
          request: req,
          runtime: "hand-off",
          state: "prepared",
          attempt: 1,
          startedAt: NOW,
          errors: [],
        } as never;
      },
      async run() {
        return { runId: "run-1", state: "waiting", errors: [] } as never;
      },
      async result() {
        return { runId: "run-1", state: "waiting", errors: [] } as never;
      },
    };
    const r = await planStories(root, CHANGE, { runtime: waiting, now: new Date(NOW) });
    expect(r).toMatchObject({ state: "waiting", waiting: { runId: "run-1" }, files: [] });
    await expect(readFile(join(changeDir(root), "stories.md"))).rejects.toThrow();
  });

  it("refuses a change whose design isn't approved", async () => {
    const root = await forgeChangeRoot();
    const p = join(changeDir(root), "change.yaml");
    const text = (await read(p))
      .replace("state: plan", "state: design")
      .replace(/ {2}- from: design\n {4}to: plan\n[\s\S]*?reason: Approve design merged\n/, "");
    await writeFile(p, text);
    await expect(planStories(root, CHANGE)).rejects.toMatchObject({
      code: "refused",
      message:
        "add-transfer-limit is design; plan from an approved design (the change must be in plan).",
    });
    // A draft plan from the design as it stands, before it is approved.
    const r = await planStories(root, CHANGE, { draft: true });
    expect(r.state).toBe("written");
    expect(r.skeleton.stories.length).toBeGreaterThan(0);
  });
});

describe("the story bar on the fixture's eval set (M3 exit)", () => {
  it("covers every seeded gap in a story or by the critic, with every story ready and nothing invented", async () => {
    const root = await forgeChangeRoot();
    await planStories(root, CHANGE, { runtime: await replay(), now: new Date(NOW) });
    await snowDraft(root, CHANGE);
    // The critic's deterministic layer on the generated plan (no AI: the gaps it must raise are layer 1).
    const critic = await runCritic(root, CHANGE, { now: NOW });
    expect(critic.round).toBe(1);
    const ev = await readStoryEval(join(FORGE_CHANGE, "expected/stories.yaml"));
    const bar = await storyBar(root, CHANGE, { eval: ev });
    expect(bar.outline).toEqual([]);
    expect(bar.regressions).toEqual([]);
    expect(bar.invented).toEqual([]);
    expect(bar.gaps.filter((g) => !g.covered)).toEqual([]);
    expect(bar.gaps.length).toBe(13);
    expect(bar.stories.filter((s) => !s.ready)).toEqual([]);
    expect(bar.ready).toEqual({ passed: 5, total: 5, rate: 1, min: 0.9 });
    expect(bar.dor.map((d) => d.checks)).toEqual([
      ["who", "traced"],
      ["criteria"],
      ["systems"],
      ["depends"],
    ]);
    expect(bar.met).toBe(true);
  });
});
