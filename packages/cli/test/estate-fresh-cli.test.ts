import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { rulesNow } from "@maycombhq/assistant-files";
import { Api } from "@maycombhq/core";
import { Router, type ServerContext } from "@maycombhq/server";
import { estateFresh, estateFreshness, freshOrder, type FreshRepo } from "../src/estate-fresh.js";
import { uiTrustRoutes } from "../src/ui-api-trust.js";

/**
 * Plan item P5 (ADR 0141): which repos have moved past their facts' commit, and how many facts
 * need reading again, for every repo at once. On the invented Forge ledger and notifier, each a
 * temp git repo whose commits the test makes with the git binary (no network).
 */

const T = 120_000;
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const P = "src/main/java/forge/ledger/";

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
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-24T10:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-24T10:00:00Z",
        },
      },
    ).trim();
}

/**
 * A clone of the Forge ledger's code under `repo`'s id, its facts read at the first commit, and
 * `move` making the second when given (the clone moves on past the facts).
 */
function clone(root: string, repo: string, move?: (dir: string) => void) {
  const dir = join(root, "workspace", repo);
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
  const git = gitIn(dir);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  if (move) {
    move(dir);
    git("add", "-A");
    git("commit", "-q", "-m", "two");
  }
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", `${repo}.jsonl`),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8")
      .replaceAll('"commit":"0123abc"', `"commit":"${one}"`)
      .replaceAll('"repo":"forge-ledger"', `"repo":"${repo}"`),
  );
  return { dir, one, head: git("rev-parse", "HEAD") };
}

function metarepo() {
  const root = mkdtempSync(join(tmpdir(), "atticus-fresh-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

/** A cited line moved, a cited file renamed, one deleted, one added (as incremental-cli does). */
function changes(dir: string) {
  const ctl = join(dir, P, "AccountController.java");
  writeFileSync(
    ctl,
    readFileSync(ctl, "utf8").replace(
      "  // Reads one account by id.",
      "  // Accounts are read from the ledger's own store.\n  //\n  // Reads one account by id.",
    ),
  );
  renameSync(join(dir, P, "Notifier.java"), join(dir, P, "NotifyClient.java"));
  rmSync(join(dir, P, "SettlementListener.java"));
  mkdirSync(join(dir, P, "statements"), { recursive: true });
  writeFileSync(
    join(dir, P, "statements", "StatementController.java"),
    "package forge.ledger.statements;\n\npublic class StatementController {}\n",
  );
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), report: () => {} },
  };
};

describe("atticus estate fresh: every repo's freshness at once (P5)", () => {
  it(
    "counts, per repo, the files changed that facts cite and the facts to read again, most stale first",
    async () => {
      const root = metarepo();
      // forge-ledger moved past its facts: a cited line moved, a file renamed, one deleted.
      const ledger = clone(root, "forge-ledger", changes);
      // forge-notify moved too, but only its README changed: its facts carry as they are.
      const notify = clone(root, "forge-notify", (d) =>
        writeFileSync(join(d, "README.md"), "# forge-notify\n"),
      );
      const v = await estateFreshness(root);
      expect(v.problems).toEqual([]);
      expect(v.repos.map((r) => [r.repo, r.state])).toEqual([
        ["forge-ledger", "stale"],
        ["forge-notify", "moved"],
      ]);
      expect(v.repos[0]).toMatchObject({
        facts: 17,
        factsCommits: [ledger.one],
        head: ledger.head,
        current: 0,
        carried: 14,
        reread: 3,
        // AccountController edited, Notifier renamed, SettlementListener deleted.
        citedChanged: 3,
        changed: 4,
        // AccountController, NotifyClient and the new StatementController.
        toRead: 3,
        command: "atticus map forge-ledger",
        slash: "/atticus-map forge-ledger",
      });
      expect(v.repos[1]).toMatchObject({
        head: notify.head,
        carried: 17,
        reread: 0,
        citedChanged: 0,
        changed: 1,
        toRead: 0,
        command: "atticus verify forge-notify --write",
      });

      const o = io();
      expect(await estateFresh(root, {}, o.io)).toBe(0);
      expect(o.err).toEqual([]);
      const text = o.out.join("\n");
      expect(o.out[0]).toBe(
        "2 repos of 2 read have moved past their facts' commit: 3 facts to read again. Most stale first:",
      );
      expect(o.out[1]).toMatch(
        /^repo +state +facts at +clone at +cited changed +to read again +run$/,
      );
      expect(o.out[2]).toMatch(
        new RegExp(
          `^forge-ledger +stale +${ledger.one.slice(0, 12)} +${ledger.head.slice(0, 12)} +3 +3 +atticus map forge-ledger$`,
        ),
      );
      expect(o.out[3]).toMatch(
        /^forge-notify +moved .* 0 +0 +atticus verify forge-notify --write$/,
      );
      expect(text).toContain(
        "  forge-ledger: 3 facts to read again (3 files they cite changed), 14 carried as they are; 3 source files to read.",
      );

      const j = io();
      await estateFresh(root, { json: true }, j.io);
      const parsed = JSON.parse(j.out.join("\n"));
      expect(parsed.factsDir).toBe("facts");
      expect(parsed.repos.map((r: FreshRepo) => r.repo)).toEqual(["forge-ledger", "forge-notify"]);
    },
    T,
  );

  it(
    "says a repo is fresh when its facts are of the clone's commit, and one not read yet",
    async () => {
      const root = metarepo();
      const { one } = clone(root, "forge-ledger");
      // Read under the reading rules there are now (ADR 0167); else it is rules-changed.
      writeFileSync(
        join(root, "facts", "forge-ledger.read-plan.yaml"),
        stringify({
          schemaVersion: 2,
          repo: "forge-ledger",
          commit: one,
          session: 45000,
          plannedAt: "2026-10-30T10:00:00Z",
          parts: [],
          rules: rulesNow(),
        }),
      );
      const v = await estateFreshness(root);
      expect(v.repos.map((r) => [r.repo, r.state])).toEqual([
        ["forge-ledger", "fresh"],
        ["forge-notify", "not-read"],
      ]);
      expect(v.repos[0]).toMatchObject({ current: 17, reread: 0 });
      expect(v.repos[0]!.command).toBeUndefined();
      const o = io();
      await estateFresh(root, {}, o.io);
      expect(o.out).toEqual([
        "All 1 repo read are fresh: each one's facts are of the commit its clone is at.",
        "1 repo not read yet: atticus next says which to read first.",
      ]);
    },
    T,
  );

  it(
    "says when the clone doesn't have the facts' commit, and when there is no clone",
    async () => {
      const root = metarepo();
      const { dir } = clone(root, "forge-ledger");
      // The facts name a commit this clone never had (a shallow or other clone).
      const file = join(root, "facts", "forge-ledger.jsonl");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/"commit":"[0-9a-f]+"/g, `"commit":"${"9".repeat(40)}"`),
      );
      // forge-notify has facts and no clone.
      writeFileSync(
        join(root, "facts", "forge-notify.jsonl"),
        readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
      );
      const v = await estateFreshness(root);
      expect(v.repos.map((r) => [r.repo, r.state])).toEqual([
        ["forge-ledger", "unknown-commit"],
        ["forge-notify", "no-checkout"],
      ]);
      expect(v.repos[0]).toMatchObject({
        unknown: ["9".repeat(40)],
        reread: 17,
        command: "atticus workspace sync",
      });
      expect(dir).toBeTruthy();
    },
    T,
  );

  it("orders the most stale first, then by facts to read again", () => {
    const r = (repo: string, state: FreshRepo["state"], reread = 0, citedChanged = 0) =>
      ({
        repo,
        state,
        reread,
        citedChanged,
        toRead: 0,
        changed: 0,
      }) as FreshRepo;
    expect(
      [
        r("a", "fresh"),
        r("b", "stale", 2, 1),
        r("c", "moved"),
        r("d", "stale", 9, 1),
        r("e", "not-read"),
        r("f", "unknown-commit", 40),
      ]
        .sort(freshOrder)
        .map((x) => x.repo),
    ).toEqual(["d", "b", "f", "c", "a", "e"]);
  });

  it(
    "answers GET /api/trust/fresh with the same view, in the API's shape (C4 2.34.0)",
    async () => {
      const root = metarepo();
      clone(root, "forge-ledger", changes);
      const r = uiTrustRoutes(new Router(), { root } as ServerContext);
      const m = r.match("GET", "/api/trust/fresh");
      if (!("handler" in m)) throw new Error("no route");
      const res = await m.handler({ params: {}, query: {} } as never);
      expect(res.status).toBe(200);
      const v = Api.FreshView.parse(res.body);
      expect(v.repos.map((x) => [x.repo, x.state, x.reread])).toEqual([
        ["forge-ledger", "stale", 3],
        ["forge-notify", "not-read", 0],
      ]);
    },
    T,
  );

  it("outside a metarepo, says how to make one", async () => {
    const o = io();
    expect(await estateFresh(mkdtempSync(join(tmpdir(), "atticus-none-")), {}, o.io)).toBe(2);
    expect(o.err[0]).toContain("isn't an Atticus metarepo");
  });
});
