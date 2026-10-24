import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Finding } from "@maycombhq/core";
import { writeFinding } from "@maycombhq/naysayer";
import { handoffReview } from "../src/handoff-review.js";

/**
 * A hand-off PR that reviews itself (WP7.4): what the change does as a picture (Mermaid, which
 * GitHub and Azure DevOps draw), its estimate, and the findings still open at its gates, in the
 * PR body, so an approver reads one page. Over the invented Forge stage fixtures.
 */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");

async function metarepo(withTargets: boolean) {
  const root = await mkdtemp(join(tmpdir(), "atticus-handoff-review-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  if (withTargets) {
    const target = join(root, "openspec/changes/add-fraud-check/target-flows");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "forge-orders.place-order.yaml"),
      [
        "schemaVersion: 1",
        "flow: forge-orders.place-order",
        "repo: forge-orders",
        "change: modify",
        "why: The order is screened before stock is reserved.",
        "steps:",
        "  - { op: add, after: 1, kind: call-out, what: Northwind Pay screens the order, to: { component: northwind-pay, entry: POST /v1/screenings, new: true } }",
        "",
      ].join("\n"),
    );
  }
  return root;
}

describe("a hand-off PR that reviews itself (WP7.4)", () => {
  it("draws the change as Mermaid, gives its estimate, and says no finding is open", async () => {
    const root = await metarepo(true);
    const md = await handoffReview(root, "add-fraud-check");
    expect(md).toContain("### What it changes");
    expect(md).toContain("```mermaid");
    expect(md).toContain('northwind_pay["+ northwind-pay"]');
    expect(md).toContain("### Estimate");
    expect(md).toContain("### Findings still open");
    expect(md).toMatch(/None open|no gate has been reviewed/i);
  });

  it("says when there are no target flows yet, instead of a picture", async () => {
    const root = await metarepo(false);
    const md = await handoffReview(root, "add-fraud-check");
    expect(md).not.toContain("```mermaid");
    expect(md).toMatch(/No target flows yet/);
  });
});

const finding = (id: string, round: number, state: "open" | "applied" = "open") =>
  Finding.parse({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: "add-fraud-check",
    gate: "design",
    round,
    rule: `review.${id}`,
    layer: "team",
    lens: "architecture",
    severity: "blocking",
    artifact: "design.md",
    locator: { line: 1 },
    summary: `Finding ${id}.`,
    why: "Because.",
    fix: { text: "Fix it." },
    evidence: [{ source: "artifact", path: "design.md", line: 1 }],
    waivable: true,
    state,
    ...(state === "applied"
      ? { resolution: { action: "apply", by: "ari", at: "2026-10-20T09:00:00Z" } }
      : {}),
    createdAt: "2026-10-20T09:00:00Z",
  });

describe("what changed since the last round (WP7.4)", () => {
  it("says, for each gate with two rounds, which findings closed, which are new and how many stay open", async () => {
    const root = await metarepo(true);
    for (const f of [finding("a", 1, "applied"), finding("b", 1), finding("c", 1)])
      await writeFinding(root, f);
    for (const f of [finding("b", 2), finding("d", 2)]) await writeFinding(root, f);
    const md = await handoffReview(root, "add-fraud-check");
    expect(md).toContain("### Since the last round");
    expect(md).toContain(
      "- design gate, round 2 against round 1: 1 closed (`c`), 1 new (`d`), 1 still open.",
    );
  });

  it("says it is the first round when a gate has only one", async () => {
    const root = await metarepo(true);
    await writeFinding(root, finding("b", 1));
    const md = await handoffReview(root, "add-fraud-check");
    expect(md).toContain("- design gate: the first round.");
  });
});
