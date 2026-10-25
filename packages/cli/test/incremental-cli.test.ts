import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import { parseFacts, type Fact } from "@maycombhq/core";
import { mapCommand } from "../src/map-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * A changed file invalidates only what cites it (CLAUDE.md rule 4; ADR 0124 addendum
 * A-incremental), end to end on the invented Forge ledger in a temp git repo whose commits the
 * test makes with the git binary (no network): the facts read at one commit, the checkout moved
 * to the next with a cited line moved, a file renamed, a file deleted and a file added.
 * `atticus map --estimate` plans only the re-read, `atticus verify` carries what still holds,
 * the hand-off batches only the changed files, and the catalog is the same bytes as for the same
 * facts written at the new commit.
 */

const T = 120_000;
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const REPO = "forge-ledger";
const P = "src/main/java/forge/ledger/";
const NOW = () => new Date("2026-10-24T12:00:00.000Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  const reported: string[] = [];
  return {
    out,
    err,
    reported,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      report: (f: unknown) => {
        const h = (f as { handoff?: { runId: string } }).handoff;
        if (h) reported.push(h.runId);
      },
    },
  };
};

function gitIn(dir: string) {
  return (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        // fixed dates: the same files make the same commits in every temp repo
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-24T10:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-24T10:00:00Z",
        },
      },
    ).trim();
}

const STATEMENTS = [
  "package forge.ledger.statements;",
  "",
  "import org.springframework.web.bind.annotation.GetMapping;",
  "import org.springframework.web.bind.annotation.PathVariable;",
  "import org.springframework.web.bind.annotation.RestController;",
  "",
  "/** Monthly statements of one account, rendered from its entries. */",
  "@RestController",
  "public class StatementController {",
  "  private final StatementService statements;",
  "",
  "  public StatementController(StatementService statements) {",
  "    this.statements = statements;",
  "  }",
  "",
  '  @GetMapping("/accounts/{accountId}/statements/{month}")',
  "  public Statement month(@PathVariable long accountId, @PathVariable String month) {",
  "    return statements.forMonth(accountId, month);",
  "  }",
  "}",
  "",
].join("\n");

/**
 * A metarepo whose forge-ledger checkout is a git repo: the facts are of its first commit, then
 * `move` makes the second (the checkout moves on).
 */
function moved(move: (repo: string, git: (...a: string[]) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "atticus-incr-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  const repo = join(root, "workspace", REPO);
  cpSync(join(VERIFY, "repo"), repo, { recursive: true });
  const git = gitIn(repo);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  move(repo, git);
  git("add", "-A");
  git("commit", "-q", "-m", "two");
  const two = git("rev-parse", "HEAD");
  mkdirSync(join(root, "facts"), { recursive: true });
  const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
    '"commit":"0123abc"',
    `"commit":"${one}"`,
  );
  writeFileSync(join(root, "facts", `${REPO}.jsonl`), facts);
  return { root, repo, one, two };
}

/** The second commit: a cited line moved, a cited file renamed, one deleted, one added. */
function changes(repo: string) {
  const ctl = join(repo, P, "AccountController.java");
  writeFileSync(
    ctl,
    readFileSync(ctl, "utf8").replace(
      "  // Reads one account by id.",
      "  // Accounts are read from the ledger's own store.\n  //\n  // Reads one account by id.",
    ),
  );
  renameSync(join(repo, P, "Notifier.java"), join(repo, P, "NotifyClient.java"));
  rmSync(join(repo, P, "SettlementListener.java"));
  mkdirSync(join(repo, P, "statements"), { recursive: true });
  writeFileSync(join(repo, P, "statements", "StatementController.java"), STATEMENTS);
}

const factsOf = (root: string): Fact[] => {
  const r = parseFacts(readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

/**
 * What a reader writes after re-reading the listed files: the edited file's fact at its moved
 * line, the renamed file's under its new path, a fact of the new file; the deleted file's dropped.
 */
function reread(facts: Fact[], two: string): string[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const get = byId.get("e-get-account")!;
  const notify = byId.get("c-notify")!;
  const strip = (f: Fact) => {
    const { verified: _v, by: _b, ...rest } = f;
    return rest;
  };
  return [
    JSON.stringify({ ...strip(get), commit: two, cite: { ...get.cite, line: 20 } }),
    JSON.stringify({
      ...strip(notify),
      commit: two,
      cite: { ...notify.cite, file: `${P}NotifyClient.java` },
    }),
    JSON.stringify({
      kind: "entry",
      id: "e-get-statement",
      repo: REPO,
      commit: two,
      component: "ledger-api",
      entryType: "rest",
      method: "GET",
      path: "/accounts/{accountId}/statements/{month}",
      cite: {
        file: `${P}statements/StatementController.java`,
        line: 16,
        value: "/accounts/{accountId}/statements/{month}",
      },
    }),
  ];
}

describe("atticus map --estimate on a moved checkout: only the re-read (addendum A-incremental)", () => {
  it(
    "lists the facts still holding, the facts to rewrite with how their file changed, and the changed files to read",
    async () => {
      const { root, repo, one, two } = moved(changes);
      const o = io();
      expect(await mapCommand(root, REPO, { estimate: true, dir: repo }, o.io)).toBe(0);
      expect(o.err).toEqual([]);
      const text = o.out.join("\n");
      expect(text).toContain(
        `A re-read: the facts are of ${one.slice(0, 12)} and the checkout is at ${two.slice(0, 12)}; 4 files changed since.`,
      );
      expect(text).toContain("14 facts still hold (every file they cite is unchanged)");
      expect(text).toContain("3 facts cite a file that changed");
      expect(text).toContain(
        `  c-notify (call): ${P}Notifier.java was renamed to ${P}NotifyClient.java`,
      );
      expect(text).toContain(`  e-get-account (entry): ${P}AccountController.java was edited`);
      expect(text).toContain(
        `  e-settle-listener (entry): ${P}SettlementListener.java was deleted`,
      );
      expect(text).toContain("3 files to read whole");
      expect(text).toContain(
        `  ${P}statements/StatementController.java (new; no fact cites it yet)`,
      );
      expect(text).toContain(`  ${P}AccountController.java (1 fact to rewrite)`);
      expect(text).toMatch(
        /3 source files to read, \d+ lines, about \d+ tokens \(the repo has 12 source files/,
      );

      const j = io();
      await mapCommand(root, REPO, { estimate: true, dir: repo, json: true }, j.io);
      const r = JSON.parse(j.out.join("\n"));
      expect(r.files).toBe(3);
      expect(r.batches).toBe(1);
      expect([...r.order].sort()).toEqual(
        [
          `${P}AccountController.java`,
          `${P}NotifyClient.java`,
          `${P}statements/StatementController.java`,
        ].sort(),
      );
      expect(r.reread.carried).toBe(14);
      expect(r.reread.reread.map((x: { id: string }) => x.id)).toEqual([
        "c-notify",
        "e-get-account",
        "e-settle-listener",
      ]);
      expect(r.reread.repo.files).toBe(12);
    },
    T,
  );

  it(
    "says there is nothing to read when no source file changed, and verify carries every fact",
    async () => {
      const { root, repo, two } = moved((dir) =>
        writeFileSync(join(dir, "README.md"), "# forge-ledger\n\nThe ledger API.\n"),
      );
      const o = io();
      await mapCommand(root, REPO, { estimate: true, dir: repo }, o.io);
      expect(o.out.join("\n")).toContain(
        `Nothing a fact cites changed and no source file did: run atticus verify ${REPO} to carry the facts to ${two.slice(0, 12)}.`,
      );
      const v = io();
      expect(await verifyCommand(root, REPO, { dir: repo }, v.io)).toBe(0);
      expect(v.out[0]).toMatch(/17 facts kept, 0 rejected/);
      expect(v.out[1]).toMatch(/^17 of them carried to /);
      expect(factsOf(root).every((f) => f.commit === two)).toBe(true);
      // the facts are of HEAD now: a second verify has nothing to carry and changes nothing
      const before = readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8");
      const w = io();
      expect(await verifyCommand(root, REPO, { dir: repo }, w.io)).toBe(0);
      expect(w.out.join("\n")).not.toMatch(/carried/);
      expect(readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8")).toBe(before);
    },
    T,
  );
});

describe("atticus verify on a moved checkout (addendum A-incremental)", () => {
  it(
    "carries the facts whose files are unchanged to HEAD, records the carry, and sends back what cites a changed file",
    async () => {
      const { root, repo, one, two } = moved(changes);
      const o = io();
      expect(await verifyCommand(root, REPO, { dir: repo }, o.io)).toBe(1);
      const text = o.out.join("\n");
      // s-account-read is under e-get-account, which waits for its rewrite
      expect(o.out[0]).toMatch(/13 facts kept, 4 rejected/);
      expect(text).toContain(`13 of them carried to ${two.slice(0, 12)} from ${one.slice(0, 12)}`);
      expect(text).toContain("3 cite a file that changed since they were read");
      expect(text).toMatch(
        /cite-changed: entry e-settle-listener cites .*SettlementListener\.java, which was deleted since commit/,
      );
      const kept = factsOf(root);
      expect(kept).toHaveLength(13);
      expect(kept.every((f) => f.commit === two)).toBe(true);
      const report = parse(readFileSync(join(root, "facts", `${REPO}.verify.yaml`), "utf8"));
      expect(report.commit).toBe(two);
      expect(report.carried).toHaveLength(1);
      expect(report.carried[0].from).toBe(one);
      expect(report.carried[0].facts).toHaveLength(13);
      const rejected = readFileSync(join(root, "facts", `${REPO}.rejected.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { code: string; fact: Fact });
      expect(rejected.map((r) => [r.fact.id, r.code])).toEqual([
        ["c-notify", "cite-changed"],
        ["e-get-account", "cite-changed"],
        ["e-settle-listener", "cite-changed"],
        ["s-account-read", "ref-rejected"],
      ]);
      // the reader gets each back as it read it, at its own commit
      expect(rejected.every((r) => r.fact.commit === one)).toBe(true);
    },
    T,
  );

  it(
    "passes once the listed facts are rewritten, and writes the same catalog bytes as the same facts written at HEAD",
    async () => {
      const a = moved(changes);
      // what the reader does on a re-read: rewrite the three listed facts, drop the deleted one, add the new
      const facts = factsOf(a.root).filter((f) => f.id !== "e-settle-listener");
      const lines = reread(facts, a.two);
      const keep = facts
        .filter((f) => !["e-get-account", "c-notify"].includes(f.id))
        .map((f) => JSON.stringify(f));
      writeFileSync(join(a.root, "facts", `${REPO}.jsonl`), [...keep, ...lines].join("\n") + "\n");
      const o = io();
      expect(await verifyCommand(a.root, REPO, { dir: a.repo, write: true, now: NOW }, o.io)).toBe(
        0,
      );
      expect(o.out[0]).toMatch(/17 facts kept, 0 rejected/);
      expect(o.out[1]).toMatch(/^14 of them carried to /);
      expect(factsOf(a.root).every((f) => f.commit === a.two)).toBe(true);
      const written = snapshot(a.root);
      expect(Object.keys(written).some((k) => k.startsWith("catalog/generated/"))).toBe(true);
      expect(Object.keys(written).some((k) => k.startsWith("map/forge-ledger/"))).toBe(true);

      // Determinism: writing again changes nothing.
      expect(
        await verifyCommand(a.root, REPO, { dir: a.repo, write: true, now: NOW }, io().io),
      ).toBe(0);
      expect(snapshot(a.root)).toEqual(written);

      // The same commit, the same facts (as read at HEAD, nothing carried) and the same answers in
      // another metarepo: the same bytes.
      const b = moved(changes);
      expect(b.two).toBe(a.two);
      writeFileSync(
        join(b.root, "facts", `${REPO}.jsonl`),
        readFileSync(join(a.root, "facts", `${REPO}.jsonl`), "utf8"),
      );
      const p = io();
      expect(await verifyCommand(b.root, REPO, { dir: b.repo, write: true, now: NOW }, p.io)).toBe(
        0,
      );
      expect(p.out.join("\n")).not.toMatch(/carried/);
      expect(snapshot(b.root)).toEqual(written);
    },
    T,
  );
});

describe("atticus map --handoff on a moved checkout (addendum A-incremental)", () => {
  it(
    "hands only the changed files, with the facts to rewrite, and carries the rest",
    async () => {
      const { root, repo, two } = moved(changes);
      const runtime = new HandoffRuntime({ root, validate: async () => [], now: NOW });
      const first = io();
      expect(
        await mapCommand(root, REPO, { dir: repo, maxTokens: 7000 }, first.io, {
          runtime,
          now: NOW,
        }),
      ).toBe(0);
      expect(first.out[0]).toMatch(
        new RegExp(
          `^Re-reading forge-ledger at ${two.slice(0, 12)}: 3 source files changed since [0-9a-f]{12}, in 1 batch .*; 3 facts to rewrite, 14 carried as they are`,
        ),
      );
      const runId = first.reported[0]!;
      const runDir = join(root, ".runs", `map-${REPO}`, runId);
      const prompt = readFileSync(join(runDir, "prompt.md"), "utf8");
      const files = new Set(
        [...prompt.matchAll(/^(\S+) lines \d+-\d+ of \d+ \(numbered as in the file\)$/gm)].map(
          (m) => m[1]!,
        ),
      );
      expect([...files].sort()).toEqual(
        [
          `${P}AccountController.java`,
          `${P}NotifyClient.java`,
          `${P}statements/StatementController.java`,
        ].sort(),
      );
      expect(prompt).toContain("This is a re-read");
      expect(prompt).toContain("e-get-account was rejected (cite-changed)");
      expect(prompt).toContain("e-settle-listener was rejected (cite-changed)");

      // the reader's answer: the rewritten facts and the new one
      writeFileSync(join(runDir, "facts.jsonl"), reread(factsOf(root), two).join("\n"));
      const o = io();
      expect(
        await mapCommand(root, REPO, { dir: repo, maxTokens: 7000, next: true }, o.io, {
          runtime,
          now: NOW,
        }),
      ).toBe(0);
      // the deleted file's fact the reader left out is still rejected: it gets the fix round
      expect(o.out[0]).toMatch(
        /^Batch 1 of 1: 3 facts kept \(17 in all, 14 carried from an earlier commit\), 1 rejected/,
      );
      expect(o.reported).toHaveLength(1);
      const kept = factsOf(root);
      expect(kept).toHaveLength(17);
      expect(kept.every((f) => f.commit === two)).toBe(true);
      // leaving it out in the fix round drops it: the read ends with nothing rejected
      writeFileSync(join(root, ".runs", `map-${REPO}`, o.reported[0]!, "facts.jsonl"), "");
      const f = io();
      expect(
        await mapCommand(root, REPO, { dir: repo, maxTokens: 7000, next: true }, f.io, {
          runtime,
          now: NOW,
        }),
      ).toBe(0);
      expect(f.out.join("\n")).toMatch(/Read forge-ledger in 1 batch: 17 facts kept/);
      expect(existsSync(join(root, "facts", `${REPO}.rejected.jsonl`))).toBe(false);
    },
    T,
  );
});

/** The catalog, specs, map and question files written, and the facts file. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) =>
      x.name.localeCompare(y.name),
    ))
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else {
        // a question keeps when it was asked, which is the clock's, not the read's
        out[`${rel}${e.name}`] = readFileSync(join(d, e.name), "utf8").replace(
          /^(\s*at:) .*$/gm,
          "$1 <when>",
        );
      }
  };
  for (const top of ["catalog", "specs", "map", "questions"]) walk(join(root, top), `${top}/`);
  out["facts/forge-ledger.jsonl"] = readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8");
  return out;
}
