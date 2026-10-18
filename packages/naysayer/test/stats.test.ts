import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, Finding } from "@maycombhq/core";
import { applyPatch, overrideStats, serializeFinding } from "../src/index.js";
import { forgeChangeRoot, write } from "./helpers.js";

function finding(o: {
  change: string;
  id: string;
  rule: string;
  layer?: "constitution" | "org" | "team";
  round?: number;
  state?: "open" | "dismissed" | "waived" | "applied";
  reason?: string;
}): Finding {
  const state = o.state ?? "open";
  const action = { open: undefined, dismissed: "not-relevant", waived: "waive", applied: "apply" }[
    state
  ];
  return Finding.parse({
    schemaVersion: 1,
    id: o.id,
    kind: "issue",
    change: o.change,
    gate: "plan",
    round: o.round ?? 1,
    rule: o.rule,
    layer: o.layer ?? "team",
    lens: "architecture",
    severity: state === "waived" ? "blocking" : "risk",
    artifact: "mappings.md",
    locator: { line: 1 },
    summary: `Finding ${o.rule}.`,
    why: "Because.",
    fix: { text: "Fix it." },
    evidence: [{ source: "artifact", path: "mappings.md", line: 1 }],
    waivable: state === "waived",
    state,
    ...(action
      ? {
          resolution: {
            action,
            by: "ari",
            at: "2026-10-20T09:00:00Z",
            ...(o.reason ? { reason: o.reason } : {}),
          },
        }
      : {}),
    createdAt: "2026-10-20T09:00:00Z",
  });
}

async function put(root: string, dir: string, f: Finding) {
  await write(
    root,
    `openspec/changes/${dir}/review/${f.gate}/${f.round}/${f.id}.yaml`,
    serializeFinding(f),
  );
}

describe("override stats", () => {
  it("reports override rates per rule and suggests a checklist patch after repeated dismissals", async () => {
    const root = await forgeChangeRoot({ change: false });
    const reason = "risk-engine is being removed";
    for (const c of ["c1", "c2", "c3"])
      await put(
        root,
        c,
        finding({
          change: c,
          id: "m",
          rule: "mappings-cover-interfaces",
          state: "dismissed",
          reason: c === "c2" ? "Risk-engine is being removed." : reason,
        }),
      );
    // The same problem carried into round 2 counts once.
    await put(
      root,
      "c1",
      finding({
        change: "c1",
        id: "m",
        rule: "mappings-cover-interfaces",
        round: 2,
        state: "dismissed",
        reason,
      }),
    );
    await put(
      root,
      "c1",
      finding({ change: "c1", id: "t", rule: "tasks-cover-stories", state: "applied" }),
    );
    await put(
      root,
      "archive/2026-10-01-c4",
      finding({ change: "c4", id: "m", rule: "mappings-cover-interfaces", state: "open" }),
    );
    for (const c of ["c1", "c2", "c3"])
      await put(
        root,
        c,
        finding({
          change: c,
          id: "s",
          rule: "constitution.story-acceptance-criteria",
          layer: "constitution",
          state: "dismissed",
          reason: "spikes have no criteria",
        }),
      );
    await put(
      root,
      "c3",
      finding({
        change: "c3",
        id: "w",
        rule: "design-concurrency-handled",
        state: "waived",
        reason: "library handles it",
      }),
    );

    const s = await overrideStats(root);
    expect(s.changes).toBe(4);
    const m = s.rules.find((r) => r.rule === "mappings-cover-interfaces")!;
    expect(m).toMatchObject({ total: 4, open: 1, dismissed: 3, waived: 0, overrideRate: 0.75 });
    expect(m.reasons).toEqual([{ reason: "risk-engine is being removed", count: 3 }]);
    expect(s.rules.find((r) => r.rule === "design-concurrency-handled")).toMatchObject({
      waived: 1,
      overrideRate: 1,
    });
    expect(s.rules.find((r) => r.rule === "tasks-cover-stories")).toMatchObject({
      applied: 1,
      overrideRate: 0,
    });

    expect(s.suggestions.map((x) => [x.rule, x.count, x.file])).toEqual([
      ["constitution.story-acceptance-criteria", 3, undefined],
      ["mappings-cover-interfaces", 3, "org-pack/teams/team-ledger/checklists/ledger-team.yaml"],
    ]);
    expect(s.suggestions[0]!.message).toMatch(/constitution rule; .* can't be relaxed/);
    // The suggestion is a patch a person reviews: it applies cleanly and leaves a valid pack
    // with the rule set to draft. Atticus never applies it itself.
    const file = join(root, s.suggestions[1]!.file!);
    const before = await readFile(file, "utf8");
    const after = applyPatch(before, s.suggestions[1]!.patch!);
    expect(await readFile(file, "utf8")).toBe(before);
    const pack = ChecklistPack.parse(parse(after));
    expect(pack.rules.find((r) => r.id === "mappings-cover-interfaces")?.status).toBe("draft");
    expect(after).toContain('# Review: dismissed 3 times as "risk-engine is being removed".');
  });

  it("is empty with no findings", async () => {
    const root = await forgeChangeRoot({ change: false });
    expect(await overrideStats(root)).toEqual({ changes: 0, rules: [], suggestions: [] });
  });
});
