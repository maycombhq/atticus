import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactsLines } from "@maycombhq/core";
import { dirSource, repairFormSlips, slugFactId, verifyFacts } from "../src/index.js";

/**
 * R6: the reader's slips of form are fixed in code, not refused. A camelCase fact id is slugged
 * (every reference to it rewritten, a collision reported and left as it was), and a flow with no
 * cite takes its entry's line. Nothing the verifier checks against the code is loosened: each
 * repaired fact still goes through `verifyFacts`, its claim on its cited line.
 * On the invented forge-limits service (`fixtures/verify-read/`).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "verify-read");
const repo = dirSource(join(FIX, "repo"));
const lines = () =>
  readFileSync(join(FIX, "forge-limits.facts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const text = (xs: readonly object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
/** The fixture with e-post-check renamed postCheck everywhere it is named. */
const camel = () =>
  lines().map((x) => {
    const y = JSON.parse(JSON.stringify(x).replaceAll('"e-post-check"', '"postCheck"')) as Record<
      string,
      unknown
    >;
    return y;
  });

describe("slugFactId", () => {
  it("makes a lowercase slug of a camelCase or spaced id", () => {
    expect(slugFactId("postCheck")).toBe("post-check");
    expect(slugFactId("e-getAccountById")).toBe("e-get-account-by-id");
    expect(slugFactId("HTTPServerCall")).toBe("http-server-call");
    expect(slugFactId("Post check")).toBe("post-check");
    expect(slugFactId("already-a-slug")).toBe("already-a-slug");
  });
});

describe("repairFormSlips: a camelCase id is slugged (R6)", () => {
  it("slugs the id, rewrites every reference to it, and says so", () => {
    const parsed = parseFactsLines(text(camel()));
    // As read, the entry and every fact naming it are refused by the schema.
    expect(parsed.bad.length).toBeGreaterThan(1);
    const r = repairFormSlips(parsed.facts, parsed.bad);
    expect(r.bad).toEqual([]);
    expect(r.facts.map((f) => f.id)).toContain("post-check");
    expect(r.facts.some((f) => JSON.stringify(f).includes("postCheck"))).toBe(false);
    const flow = r.facts.find((f) => f.kind === "flow")!;
    expect(flow.kind === "flow" && flow.entry).toBe("post-check");
    expect(r.slips.filter((s) => s.code === "id-slugged")).toEqual([
      {
        line: 1,
        code: "id-slugged",
        fact: "post-check",
        message: "line 1: fact id postCheck slugged to post-check, and every reference to it",
      },
    ]);
    expect(r.slips.filter((s) => s.code === "ref-rewritten").length).toBeGreaterThan(0);
  });

  it("reports a slug another fact already has, and leaves both as they were", () => {
    const xs = camel();
    // A second fact whose id is the slug already.
    xs.push({ ...xs[1]!, id: "post-check" });
    const parsed = parseFactsLines(text(xs));
    const r = repairFormSlips(parsed.facts, parsed.bad);
    expect(r.facts.filter((f) => f.id === "post-check")).toHaveLength(1);
    const collision = r.slips.filter((s) => s.code === "id-collision");
    expect(collision).toEqual([
      {
        line: 1,
        code: "id-collision",
        fact: "postCheck",
        message:
          "line 1: fact id postCheck would slug to post-check, which another fact already has; rename one of them",
      },
    ]);
    // The line stays refused, with the collision among its issues.
    const bad = r.bad.find((b) => b.line === 1)!;
    expect(bad.issues.map((i) => i.code)).toContain("id-collision");
  });

  it("reports two ids that slug to the same one, and slugs neither", () => {
    const xs = camel();
    xs.push({ ...xs[1]!, id: "PostCheck" });
    const parsed = parseFactsLines(text(xs));
    const r = repairFormSlips(parsed.facts, parsed.bad);
    expect(r.facts.map((f) => f.id)).not.toContain("post-check");
    expect(r.slips.filter((s) => s.code === "id-collision").map((s) => s.fact)).toEqual([
      "postCheck",
      "PostCheck",
    ]);
  });
});

describe("repairFormSlips: a flow with no cite takes its entry's line (R6)", () => {
  const noCite = () => lines().map((x) => (x.kind === "flow" ? { ...x, cite: undefined } : x));

  it("gives the flow its entry's cite, says so, and the verifier still checks it there", async () => {
    const parsed = parseFactsLines(text(noCite()));
    expect(parsed.bad).toHaveLength(1);
    const r = repairFormSlips(parsed.facts, parsed.bad);
    expect(r.bad).toEqual([]);
    const flow = r.facts.find((f) => f.kind === "flow")!;
    const entry = r.facts.find((f) => f.id === "e-post-check")!;
    expect(flow.cite).toEqual(entry.cite);
    expect(r.slips).toEqual([
      {
        line: parsed.bad[0]!.line,
        code: "flow-cite-from-entry",
        fact: flow.id,
        message: `line ${parsed.bad[0]!.line}: flow ${flow.id} had no cite; it takes its entry e-post-check's line (src/main/java/forge/limits/LimitController.java:18)`,
      },
    ]);
    const v = await verifyFacts({ facts: r.facts, source: repo, commit: "4d1c0de" });
    expect(v.rejected).toEqual([]);
  });

  it("leaves a flow with no cite whose entry isn't a fact as it was", () => {
    const xs = noCite().map((x) => (x.kind === "flow" ? { ...x, entry: "e-gone" } : x));
    const parsed = parseFactsLines(text(xs));
    const r = repairFormSlips(parsed.facts, parsed.bad);
    expect(r.bad).toHaveLength(1);
    expect(r.slips).toEqual([]);
  });

  it("never loosens the line check: a slugged fact whose claim isn't on its line is still rejected", async () => {
    const xs = camel().map((x) =>
      x.id === "postCheck"
        ? { ...x, path: "/limits/nowhere", cite: { ...(x.cite as object), value: "/nowhere" } }
        : x,
    );
    const parsed = parseFactsLines(text(xs));
    const r = repairFormSlips(parsed.facts, parsed.bad);
    const v = await verifyFacts({ facts: r.facts, source: repo, commit: "4d1c0de" });
    expect(v.rejected.map((x) => [x.fact.id, x.code])).toContainEqual([
      "post-check",
      "claim-not-on-line",
    ]);
  });
});

describe("repairFormSlips beside facts already kept (R6, the batch loop)", () => {
  /** The facts the entry's batch kept, its id slugged then; a later batch writes the rest. */
  const split = () => {
    const xs = camel();
    const entry = xs.filter((x) => x.id === "postCheck");
    const rest = xs.filter((x) => x.id !== "postCheck");
    const first = parseFactsLines(text(entry));
    const kept = repairFormSlips(first.facts, first.bad).facts;
    return { kept, rest };
  };

  it("rewrites a reference to an id an earlier batch slugged", () => {
    const { kept, rest } = split();
    expect(kept.map((f) => f.id)).toEqual(["post-check"]);
    const later = parseFactsLines(text(rest));
    const r = repairFormSlips(later.facts, later.bad, kept);
    expect(r.bad).toEqual([]);
    expect(r.facts.some((f) => JSON.stringify(f).includes("postCheck"))).toBe(false);
    expect(r.facts.map((f) => f.id)).not.toContain("post-check");
    expect(r.slips.map((s) => s.code)).toContain("ref-rewritten");
  });

  it("gives a flow with no cite the line of an entry an earlier batch kept", () => {
    const xs = lines();
    const entry = xs.filter((x) => x.id === "e-post-check");
    const flow = xs.filter((x) => x.kind === "flow").map((x) => ({ ...x, cite: undefined }));
    const kept = parseFactsLines(text(entry)).facts;
    const later = parseFactsLines(text(flow));
    const r = repairFormSlips(later.facts, later.bad, kept);
    expect(r.bad).toEqual([]);
    expect(r.facts[0]!.cite).toEqual(kept[0]!.cite);
    expect(r.slips.map((s) => s.code)).toEqual(["flow-cite-from-entry"]);
  });

  it("takes an id that slugs to an earlier batch's fact as that fact written again, not a collision", () => {
    const { kept } = split();
    const again = parseFactsLines(text(camel().filter((x) => x.id === "postCheck")));
    const r = repairFormSlips(again.facts, again.bad, kept);
    expect(r.bad).toEqual([]);
    expect(r.facts.map((f) => f.id)).toEqual(["post-check"]);
    expect(r.slips.map((s) => s.code)).toEqual(["id-slugged"]);
  });
});
