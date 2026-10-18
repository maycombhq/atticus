import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canAdvance, changeStore, newChange } from "../src/index.js";
import { FEATURE_OWNERS, forgeMetarepo } from "./helpers.js";

/**
 * ADR 0039: the built-in drift, hand-up and trace gates are "read by the lifecycle like any
 * gate". Their open blocking findings and gaps stop the hand-offs of the Build, QA and Go/no-go
 * phases, though gates.yaml doesn't list them.
 */

const ID = "add-transfer-limit";

async function inState(state: "define" | "design" | "plan" | "build" | "qa" | "release-ready") {
  const root = await forgeMetarepo();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["portal", "ledger"],
    now: "2026-10-19T09:00:00Z",
  });
  const store = changeStore(root);
  const c = await store.read(ID);
  if (state !== "define")
    await store.write({
      ...c,
      state,
      history: [...c.history, { from: "define", to: state, at: "2026-10-19T11:00:00Z", by: "ari" }],
    });
  return root;
}

async function finding(
  root: string,
  gate: string,
  o: { id: string; round?: number; severity?: "blocking" | "gap"; state?: string },
): Promise<void> {
  const round = o.round ?? 1;
  const dir = join(root, "openspec/changes", ID, "review", gate, String(round));
  await mkdir(dir, { recursive: true });
  const gap = o.severity === "gap";
  const state = o.state ?? "open";
  await writeFile(
    join(dir, `${o.id}.yaml`),
    [
      "schemaVersion: 1",
      `id: ${o.id}`,
      `kind: ${gap ? "knowledge-gap" : "issue"}`,
      `change: ${ID}`,
      `gate: ${gate}`,
      `round: ${round}`,
      `rule: ${gate}-rule`,
      "layer: org",
      "lens: delivery",
      `severity: ${o.severity ?? "blocking"}`,
      "artifact: stories.md",
      "locator:",
      "  heading: Stories",
      "summary: Story s1 has no test.",
      "why: Every story needs a test.",
      "fix:",
      "  text: Generate the tests.",
      "evidence:",
      "  - source: artifact",
      "    path: stories.md",
      ...(gap ? ["question:", "  text: Who owns this?", "  owner: team-lead"] : []),
      "waivable: false",
      `state: ${state}`,
      ...(state === "open"
        ? []
        : [
            "resolution:",
            "  action: not-relevant",
            "  by: dev",
            "  at: 2026-10-19T10:00:00Z",
            "  reason: Not ours.",
          ]),
      "createdAt: 2026-10-19T09:30:00Z",
      "",
    ].join("\n"),
  );
}

const codes = async (root: string) =>
  (await canAdvance(ID, root)).reasons.filter(
    (r) => r.code === "blocking-finding" || r.code === "open-gap",
  );

describe("built-in gates in the lifecycle", () => {
  it("an open blocking trace finding stops the Build, QA and Go/no-go hand-offs", async () => {
    for (const state of ["build", "qa", "release-ready"] as const) {
      const root = await inState(state);
      expect(await codes(root), state).toEqual([]);
      await finding(root, "trace", { id: "story-without-test-s1" });
      const r = await codes(root);
      expect(
        r.map((x) => x.code),
        state,
      ).toEqual(["blocking-finding"]);
      expect(r[0]!.message).toBe(
        "Blocking finding story-without-test-s1 on the trace gate (round 1): Story s1 has no test.",
      );
    }
  });

  it("the drift and hand-up gates stop them too, and an open gap counts like a blocking finding", async () => {
    const root = await inState("build");
    await finding(root, "drift", { id: "drift-1" });
    await finding(root, "hand-up", { id: "lens-1", severity: "gap" });
    const r = await codes(root);
    expect(r.map((x) => [x.code, x.message.match(/on the (\S+) gate/)![1]])).toEqual([
      ["blocking-finding", "drift"],
      ["open-gap", "hand-up"],
    ]);
  });

  it("only the newest round counts, and a finding a person has resolved does not block", async () => {
    const root = await inState("build");
    await finding(root, "trace", { id: "story-without-test-s1", round: 1 });
    await finding(root, "trace", { id: "story-without-test-s1", round: 2, state: "dismissed" });
    expect(await codes(root)).toEqual([]);
    await finding(root, "trace", { id: "story-without-test-s2", round: 3 });
    expect((await codes(root)).map((x) => x.message)).toEqual([
      "Blocking finding story-without-test-s2 on the trace gate (round 3): Story s1 has no test.",
    ]);
  });

  it("do not hold back the earlier phases, which they are not about", async () => {
    for (const state of ["define", "design", "plan"] as const) {
      const root = await inState(state);
      await finding(root, "trace", { id: "story-without-test-s1" });
      expect(await codes(root), state).toEqual([]);
    }
  });
  it("a round whose AI lens is still waiting for its hand-off answer stops the hand-off", async () => {
    const root = await inState("build");
    const meta = join(root, "openspec/changes", ID, "review", "hand-up", "1", "meta");
    await mkdir(meta, { recursive: true });
    const write = (state: string) =>
      writeFile(
        join(meta, "round.yaml"),
        [
          `change: ${ID}`,
          "gate: hand-up",
          "round: 1",
          "createdAt: 2026-10-19T09:30:00Z",
          "findings: []",
          "lenses:",
          "  - lens: code-and-test",
          "    agent: code-and-test-critic",
          `    state: ${state}`,
          "    runId: r-0001",
          "    rules: []",
          "    artifacts: []",
          "",
        ].join("\n"),
      );
    const waiting = async () =>
      (await canAdvance(ID, root)).reasons.filter((r) => r.code === "lens-waiting");
    await write("waiting");
    expect((await waiting()).map((r) => r.message)).toEqual([
      "The code-and-test lens on the hand-up gate (round 1) is waiting for its hand-off answer (atticus handoff done r-0001).",
    ]);
    await write("ran");
    expect(await waiting()).toEqual([]);
  });
});
