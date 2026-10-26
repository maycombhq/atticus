import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, parseReviewed, verifyFacts, type ReviewedEntry } from "../src/index.js";

/**
 * What six readers of a real repo reported about `atticus verify` (ADR 0124 addendum A-read), on
 * the invented forge-limits service (`fixtures/verify-read/`): a controller, a service only flow
 * steps cite, a request with its validation rules, an entity, and a pure `calc/` package.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "verify-read");
const repo = dirSource(join(FIX, "repo"));
const COMMIT = "4d1c0de";
const J = "src/main/java/forge/limits";

const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "forge-limits.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const reviewedLines = (): ReviewedEntry[] => {
  const r = parseReviewed(readFileSync(join(FIX, "forge-limits.reviewed.jsonl"), "utf8"));
  expect(r.bad).toEqual([]);
  return r.entries;
};
const run = (fs: Fact[], reviewed?: ReviewedEntry[]) =>
  verifyFacts({ facts: fs, source: repo, commit: COMMIT, ...(reviewed ? { reviewed } : {}) });
/** The facts with one fact changed. */
const edit = (id: string, f: (x: Fact) => Fact) => facts().map((x) => (x.id === id ? f(x) : x));
const flowEdit = (
  f: (w: Extract<Fact, { kind: "flow" }>) => Partial<Extract<Fact, { kind: "flow" }>>,
) => edit("w-check", (x) => ({ ...x, ...f(x as Extract<Fact, { kind: "flow" }>) }) as Fact);

describe("coverage counts what a flow walks through (A-read, problem 1)", () => {
  it("counts a file only a flow's steps or errors cite as read", async () => {
    const r = await run(facts());
    expect(r.rejected).toEqual([]);
    // LimitService.java holds no entry, call, store, field or setting: only w-check's steps and
    // its error path cite it. It was read.
    expect(r.coverage.read).toEqual(
      [
        `${J}/LimitCheck.java`,
        `${J}/LimitController.java`,
        `${J}/LimitDecision.java`,
        `${J}/LimitRepository.java`,
        `${J}/LimitRequest.java`,
        `${J}/LimitService.java`,
      ].sort(),
    );
    expect(r.coverage.unknown).toEqual([
      `${J}/InvalidAmount.java`,
      `${J}/calc/Rounding.java`,
      `${J}/calc/Tiers.java`,
    ]);
    expect(r.coverage.reviewed).toEqual([]);
  });

  it("counts a file an error path alone cites", async () => {
    const r = await run(
      flowEdit((w) => ({
        errors: [
          {
            ...w.errors[0]!,
            cite: { file: `${J}/InvalidAmount.java`, line: 3, value: "InvalidAmount" },
          },
        ],
      })),
    );
    expect(r.rejected).toEqual([]);
    expect(r.coverage.read).toContain(`${J}/InvalidAmount.java`);
  });
});

describe("files read with nothing to record (A-read, problem 2)", () => {
  it("parses <repo>.reviewed.jsonl, and says which lines aren't entries", () => {
    expect(reviewedLines()).toEqual([
      {
        line: 1,
        path: `${J}/calc/*.java`,
        why: "pure arithmetic and a constant table of caps: no route, call, store, field or setting",
      },
      {
        line: 2,
        path: `${J}/InvalidAmount.java`,
        why: "an exception type the flow's error path throws; it holds no fact of its own",
      },
    ]);
    const r = parseReviewed(
      [
        "{not json",
        JSON.stringify({ path: "a.java" }),
        JSON.stringify({ path: "a.java", why: "x", extra: 1 }),
        "",
        JSON.stringify({ path: "b.java", why: "nothing here" }),
      ].join("\n"),
    );
    expect(r.entries).toEqual([{ line: 5, path: "b.java", why: "nothing here" }]);
    expect(r.bad.map((b) => b.line)).toEqual([1, 2, 3]);
    for (const b of r.bad) expect(b.message.length).toBeGreaterThan(10);
  });

  it("counts reviewed files apart from read ones, never as read, and leaves none unknown", async () => {
    const r = await run(facts(), reviewedLines());
    expect(r.coverage.reviewed).toEqual([
      `${J}/InvalidAmount.java`,
      `${J}/calc/Rounding.java`,
      `${J}/calc/Tiers.java`,
    ]);
    expect(r.coverage.unknown).toEqual([]);
    expect(r.coverage.read).toHaveLength(6);
    // The ratio is what facts and routed reads show: a reviewed file is on the reader's word.
    expect(r.coverage.ratio).toBe(0.667);
    // Each line, with the files it stands for, so a person can challenge it.
    expect(r.reviewed).toEqual([
      {
        path: `${J}/calc/*.java`,
        why: "pure arithmetic and a constant table of caps: no route, call, store, field or setting",
        files: [`${J}/calc/Rounding.java`, `${J}/calc/Tiers.java`],
      },
      {
        path: `${J}/InvalidAmount.java`,
        why: "an exception type the flow's error path throws; it holds no fact of its own",
        files: [`${J}/InvalidAmount.java`],
      },
    ]);
    expect(r.reviewedProblems).toEqual([]);
  });

  it("counts a reviewed file a kept fact cites as read", async () => {
    const r = await run(facts(), [
      ...reviewedLines(),
      { path: `${J}/LimitService.java`, why: "only a service" },
    ]);
    expect(r.coverage.read).toContain(`${J}/LimitService.java`);
    expect(r.coverage.reviewed).not.toContain(`${J}/LimitService.java`);
    expect(r.reviewed.find((x) => x.path === `${J}/LimitService.java`)?.files).toEqual([]);
    expect(r.reviewedProblems).toEqual([]);
  });

  it("refuses a path that isn't in the repo at this commit, a glob that matches nothing, and a path outside the repo or a secret's", async () => {
    const r = await run(facts(), [
      { line: 1, path: `${J}/Gone.java`, why: "read it" },
      { line: 2, path: "src/main/kotlin/**/*.kt", why: "read them" },
      { line: 3, path: "../forge-ledger/src/A.java", why: "read it" },
      { line: 4, path: ".env", why: "read it" },
    ]);
    expect(r.reviewedProblems.map((p) => [p.line, p.path])).toEqual([
      [1, `${J}/Gone.java`],
      [2, "src/main/kotlin/**/*.kt"],
      [3, "../forge-ledger/src/A.java"],
      [4, ".env"],
    ]);
    expect(r.reviewedProblems[0]!.message).toMatch(/not in the repo at this commit/);
    expect(r.reviewedProblems[1]!.message).toMatch(/matches no file/);
    expect(r.reviewedProblems[2]!.message).toMatch(/outside the repo/);
    expect(r.reviewedProblems[3]!.message).toMatch(/secret/);
    // Nothing is reviewed on a refused line.
    expect(r.coverage.reviewed).toEqual([]);
    expect(r.reviewed).toEqual([]);
  });
});

describe("a validate step's value is checked on its line (A-read, problem 3)", () => {
  it("rejects a validation rule its line doesn't write", async () => {
    const r = await run(
      flowEdit((w) => ({
        steps: w.steps.map((s, i) =>
          i === 0 ? { ...s, cite: { ...s.cite, value: "100000" } } : s,
        ),
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([["w-check", "claim-not-on-line"]]);
    expect(r.rejected[0]!.message).toMatch(/step 1 claims "100000"/);
  });

  it("rejects a validation rule written only in a comment", async () => {
    const r = await run(
      flowEdit((w) => ({
        steps: w.steps.map((s, i) =>
          i === 1
            ? {
                ...s,
                cite: { file: `${J}/LimitController.java`, line: 16, value: "client certificate" },
              }
            : s,
        ),
      })),
    );
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-in-comment"]);
  });

  it("still checks only that a transform's or a branch's line exists", async () => {
    const r = await run(
      flowEdit((w) => ({
        steps: w.steps.map((s) =>
          s.kind === "transform" ? { ...s, cite: { ...s.cite, value: "rounds half even" } } : s,
        ),
      })),
    );
    expect(r.rejected).toEqual([]);
  });
});

describe("an entry's auth rests on the line that sets it (A-read, problem 4)", () => {
  it("keeps an auth whose authCite line writes its value", async () => {
    const r = await run(facts());
    const e = r.accepted.find((f) => f.id === "e-post-check");
    expect(e?.kind === "entry" && e.auth).toBe("oauth2");
    expect(r.authUncited).toEqual([]);
  });

  // A-uncited: the claim stays in the fact the verifier keeps, and `catalogAuth` leaves it out of
  // the catalog. Dropping it here rewrote the reader's own file and erased the warning with it.
  it("keeps an auth with no authCite in the fact it keeps, and says so: a note, not a rejection", async () => {
    const r = await run(edit("e-get-tiers", (x) => ({ ...x, auth: "mtls" }) as Fact));
    expect(r.rejected).toEqual([]);
    const e = r.accepted.find((f) => f.id === "e-get-tiers")!;
    expect(e.kind === "entry" && e.auth).toBe("mtls");
    expect(r.authUncited).toEqual([
      { id: "e-get-tiers", auth: "mtls", cite: `${J}/LimitController.java:24` },
    ]);
  });

  it("says the same on every run: verifying what it kept gives the same count, not nothing", async () => {
    const first = await run(edit("e-get-tiers", (x) => ({ ...x, auth: "mtls" }) as Fact));
    // what `--write` puts back in facts/<repo>.jsonl is `accepted`: verify that, as a person does
    const second = await run(first.accepted);
    expect(second.rejected).toEqual([]);
    expect(second.authUncited).toEqual(first.authUncited);
    const e = second.accepted.find((f) => f.id === "e-get-tiers")!;
    expect(e.kind === "entry" && e.auth).toBe("mtls");
    // and again, in case the second run were the stable one
    const third = await run(second.accepted);
    expect(third.authUncited).toEqual(first.authUncited);
  });

  it("leaves a person's own uncited auth unsaid: it is their word, marked as theirs", async () => {
    const r = await run(edit("e-get-tiers", (x) => ({ ...x, auth: "mtls", by: "person" }) as Fact));
    expect(r.authUncited).toEqual([]);
    const e = r.accepted.find((f) => f.id === "e-get-tiers")!;
    expect(e.kind === "entry" && e.auth).toBe("mtls");
  });

  it("rejects an authCite whose value its line doesn't write, or writes only in a comment", async () => {
    const at = (line: number, value: string) =>
      run(
        edit(
          "e-post-check",
          (x) =>
            ({
              ...x,
              auth: "mtls",
              authCite: { file: `${J}/LimitController.java`, line, value },
            }) as Fact,
        ),
      );
    const off = await at(21, "mtls");
    expect(off.rejected.map((x) => [x.fact.id, x.code])).toContainEqual([
      "e-post-check",
      "claim-not-on-line",
    ]);
    expect(off.rejected.find((x) => x.fact.id === "e-post-check")!.message).toMatch(/auth/);
    const comment = await at(16, "mtls");
    expect(comment.rejected.find((x) => x.fact.id === "e-post-check")?.code).toBe(
      "claim-in-comment",
    );
  });
});

describe("all of a fact's problems in one run (A-read, problem 5)", () => {
  it("reports every faulty step and error of a flow at once", async () => {
    const r = await run(
      flowEdit((w) => ({
        steps: w.steps.map((s, i) =>
          i === 0 ? { ...s, cite: { ...s.cite, value: "100000" } } : s,
        ),
        errors: [{ ...w.errors[0]!, cite: { ...w.errors[0]!.cite, line: 99 } }],
      })),
    );
    expect(r.rejected).toHaveLength(1);
    const x = r.rejected[0]!;
    expect(x.code).toBe("claim-not-on-line");
    expect(x.problems?.map((p) => p.code)).toEqual(["claim-not-on-line", "no-line"]);
    expect(x.message).toMatch(/step 1/);
    expect(x.message).toMatch(/error 1/);
  });

  it("reports an entry's bad citation and its bad auth citation together", async () => {
    const r = await run(
      edit(
        "e-get-tiers",
        (x) =>
          ({
            ...x,
            cite: { ...x.cite, line: 2 },
            auth: "basic",
            authCite: { file: `${J}/LimitController.java`, line: 25, value: "httpBasic" },
          }) as Fact,
      ),
    );
    const x = r.rejected.find((y) => y.fact.id === "e-get-tiers")!;
    expect(x.problems).toHaveLength(2);
  });

  it("keeps one problem's rejection as it was: no problems list", async () => {
    const r = await run(
      edit("f-currency", (x) => ({ ...x, cite: { ...x.cite, line: 3 } }) as Fact),
    );
    expect(r.rejected.map((x) => x.fact.id)).toEqual(["f-currency"]);
    expect(r.rejected[0]!.problems).toBeUndefined();
  });
});
