import { describe, expect, it } from "vitest";
import { Fact, type FileChange } from "@maycombhq/core";
import { memorySource, rereadPlan, verifyFacts } from "../src/index.js";

/**
 * A changed file invalidates only what cites it (CLAUDE.md rule 4; ADR 0124 addendum
 * A-incremental): facts read at an earlier commit are carried to the new one when every file
 * they cite is unchanged (and their lines still check), and are read again when one changed.
 */

const OLD = "1111111";
const HEAD = "2222222";
const fact = (o: Record<string, unknown>): Fact =>
  Fact.parse({ repo: "forge-ledger", commit: OLD, ...o });

const files = {
  "src/AccountController.java": [
    "@RestController",
    "class AccountController {",
    '  @GetMapping("/accounts/{id}")',
    "  Account get(long id) { return repo.find(id); }",
    "}",
  ].join("\n"),
  "src/AccountRepository.java": [
    "class AccountRepository {",
    '  @Query("from accounts")',
    "}",
  ].join("\n"),
  "src/NotifyClient.java": ["class NotifyClient {", '  post("/notify");', "}"].join("\n"),
  "src/main/resources/application.yml": ["server:", "  base: /api"].join("\n"),
  "src/StatementController.java": [
    "@RestController",
    "class StatementController {",
    '  @GetMapping("/statements/{month}")',
    "}",
  ].join("\n"),
  "README.md": "# forge-ledger",
};
const source = memorySource(files);

const getAccount = fact({
  kind: "entry",
  id: "e-get-account",
  entryType: "rest",
  method: "GET",
  path: "/accounts/{id}",
  cite: { file: "src/AccountController.java", line: 3, value: "/accounts/{id}" },
});
const readAccount = fact({
  kind: "store",
  id: "s-read-account",
  store: "ledger-db",
  name: "accounts",
  op: "read",
  under: "e-get-account",
  cite: { file: "src/AccountRepository.java", line: 2, value: "accounts" },
});
const notify = fact({
  kind: "call",
  id: "c-notify",
  callType: "rest",
  method: "POST",
  path: "/notify",
  cite: { file: "src/Notifier.java", line: 2, value: "/notify" },
});
const withBase = fact({
  kind: "entry",
  id: "e-api-get",
  entryType: "rest",
  method: "GET",
  path: "/api/accounts/{id}",
  cite: {
    file: "src/AccountController.java",
    line: 3,
    value: "/accounts/{id}",
    with: [{ file: "src/main/resources/application.yml", line: 2, value: "/api" }],
  },
});
const flow = fact({
  kind: "flow",
  id: "w-get-account",
  name: "Get an account",
  entry: "e-get-account",
  cite: { file: "src/AccountController.java", line: 3, value: "/accounts/{id}" },
  steps: [
    {
      kind: "read",
      what: "reads the account",
      ref: "s-read-account",
      cite: { file: "src/AccountRepository.java", line: 2, value: "accounts" },
    },
  ],
});

const P = "src/";
const edited: FileChange = { status: "modified", path: `${P}AccountRepository.java` };
const renamed: FileChange = {
  status: "renamed",
  path: `${P}NotifyClient.java`,
  from: `${P}Notifier.java`,
};
const added: FileChange = { status: "added", path: `${P}StatementController.java` };
const readme: FileChange = { status: "modified", path: "README.md" };

describe("verifyFacts with carry: facts of an earlier commit", () => {
  it("carries a fact whose files are unchanged: its commit becomes HEAD, the carry is reported", async () => {
    const r = await verifyFacts({
      facts: [getAccount, readAccount],
      source,
      commit: HEAD,
      carry: { [OLD]: [readme, added] },
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((f) => [f.id, f.commit, f.verified])).toEqual([
      ["e-get-account", HEAD, "line"],
      ["s-read-account", HEAD, "line"],
    ]);
    expect(r.carried).toEqual([
      { id: "e-get-account", from: OLD },
      { id: "s-read-account", from: OLD },
    ]);
  });

  it("re-runs the line check on a carried fact: a line that no longer holds is rejected as such", async () => {
    const moved = fact({ ...getAccount, cite: { ...getAccount.cite, line: 1 } });
    const r = await verifyFacts({ facts: [moved], source, commit: HEAD, carry: { [OLD]: [] } });
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line"]);
    expect(r.carried).toEqual([]);
  });

  it("rejects a fact citing an edited, renamed or deleted file as cite-changed, saying how", async () => {
    const deleted: FileChange = { status: "deleted", path: `${P}AccountController.java` };
    const r = await verifyFacts({
      facts: [readAccount, notify, getAccount],
      source,
      commit: HEAD,
      carry: { [OLD]: [edited, renamed] },
    });
    const why = Object.fromEntries(r.rejected.map((x) => [x.fact.id, [x.code, x.message]]));
    expect(why["s-read-account"]![0]).toBe("cite-changed");
    expect(why["s-read-account"]![1]).toMatch(
      /cites src\/AccountRepository\.java, which was edited since commit 1111111; read it again at 2222222/,
    );
    expect(why["c-notify"]![1]).toMatch(
      /src\/Notifier\.java, which was renamed to src\/NotifyClient\.java since commit 1111111/,
    );
    expect(r.accepted.map((f) => f.id)).toEqual(["e-get-account"]);
    // the rejected fact keeps the commit it was read at, for the reader to see
    expect(r.rejected[0]!.fact.commit).toBe(OLD);
    const d = await verifyFacts({
      facts: [getAccount],
      source,
      commit: HEAD,
      carry: { [OLD]: [deleted] },
    });
    expect(d.rejected[0]!.message).toMatch(/which was deleted since commit 1111111/);
  });

  it("counts a cite.with part and a flow step: a changed part's file makes the fact stale", async () => {
    const yml: FileChange = { status: "modified", path: `${P}main/resources/application.yml` };
    const r = await verifyFacts({
      facts: [getAccount, readAccount, withBase, flow],
      source,
      commit: HEAD,
      carry: { [OLD]: [yml] },
    });
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([["e-api-get", "cite-changed"]]);
    const s = await verifyFacts({
      facts: [getAccount, readAccount, flow],
      source,
      commit: HEAD,
      carry: { [OLD]: [edited] },
    });
    // the flow's step cites the edited repository; the store does too; the entry is carried
    expect(s.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["s-read-account", "cite-changed"],
      ["w-get-account", "cite-changed"],
    ]);
    expect(s.carried.map((c) => c.id)).toEqual(["e-get-account"]);
  });

  it("rejects a carried fact naming a stale one (it waits for its rewrite), and keeps a fact already of HEAD", async () => {
    const rewritten = fact({ ...getAccount, commit: HEAD });
    const staleEntry = fact({
      ...getAccount,
      cite: { ...getAccount.cite, file: "src/Gone.java" },
    });
    const r = await verifyFacts({
      facts: [staleEntry, readAccount],
      source,
      commit: HEAD,
      carry: { [OLD]: [{ status: "deleted", path: `${P}Gone.java` }] },
    });
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["e-get-account", "cite-changed"],
      ["s-read-account", "ref-rejected"],
    ]);
    const ok = await verifyFacts({
      facts: [rewritten, readAccount],
      source,
      commit: HEAD,
      carry: { [OLD]: [] },
    });
    expect(ok.rejected).toEqual([]);
    expect(ok.carried).toEqual([{ id: "s-read-account", from: OLD }]);
  });

  it("rejects a fact of a commit with no diff as wrong-commit, as before", async () => {
    const r = await verifyFacts({ facts: [getAccount], source, commit: HEAD, carry: {} });
    expect(r.rejected.map((x) => x.code)).toEqual(["wrong-commit"]);
    const s = await verifyFacts({ facts: [getAccount], source, commit: HEAD });
    expect(s.rejected.map((x) => x.code)).toEqual(["wrong-commit"]);
    expect(s.carried).toEqual([]);
  });
});

describe("rereadPlan: what a re-read reads", () => {
  it("lists the facts to revisit, the facts carried, and the changed source files to read", () => {
    const plan = rereadPlan({
      facts: [getAccount, readAccount, notify, flow],
      commit: HEAD,
      carry: { [OLD]: [edited, renamed, added, readme] },
      source,
    });
    expect(plan.from).toEqual([{ commit: OLD, changed: 4 }]);
    expect(plan.current).toBe(0);
    expect(plan.carried).toBe(1);
    expect(plan.reread).toEqual([
      {
        id: "c-notify",
        kind: "call",
        from: OLD,
        file: `${P}Notifier.java`,
        how: "renamed",
        to: `${P}NotifyClient.java`,
      },
      {
        id: "s-read-account",
        kind: "store",
        from: OLD,
        file: `${P}AccountRepository.java`,
        how: "edited",
      },
      {
        id: "w-get-account",
        kind: "flow",
        from: OLD,
        file: `${P}AccountRepository.java`,
        how: "edited",
      },
    ]);
    // source files only (README isn't one), in reading order, each with the facts it holds to rewrite
    expect(plan.files).toEqual([
      { path: `${P}StatementController.java`, status: "added", facts: 0 },
      { path: `${P}AccountRepository.java`, status: "modified", facts: 2 },
      { path: `${P}NotifyClient.java`, status: "renamed", facts: 1 },
    ]);
    expect(plan.unknown).toEqual([]);
  });

  it("says a commit it can't compare, and leaves out a file an exclusion rule covers", () => {
    const plan = rereadPlan({
      facts: [getAccount, fact({ ...notify, commit: "3333333" })],
      commit: HEAD,
      carry: { [OLD]: [added] },
      source,
      exclude: ["src/Statement*"],
    });
    expect(plan.unknown).toEqual(["3333333"]);
    expect(plan.files).toEqual([]);
    expect(plan.carried).toBe(1);
  });
});
