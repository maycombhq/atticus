import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Finding, parseFacts, toCanonicalYaml } from "@maycombhq/core";
import { writeChangeRepos } from "@maycombhq/workspace";
import { archiveGate, repoDrift } from "../src/index.js";
import { CHANGE, metarepo, put, repoDir } from "./helpers.js";

const COMMIT = "b".repeat(40);

async function trace(root: string, state: "open" | "dismissed") {
  const f = Finding.parse({
    schemaVersion: 1,
    id: "story-without-test-s2-show-remaining",
    kind: "issue",
    change: CHANGE,
    gate: "trace",
    round: 1,
    rule: "trace.story-without-test",
    layer: "constitution",
    lens: "code-and-test",
    severity: "blocking",
    artifact: "stories/s2-show-remaining.md",
    locator: { heading: "Show the remaining limit" },
    summary: "Story s2-show-remaining has no test.",
    why: "Every story needs a test.",
    fix: { text: "Generate or write a test." },
    evidence: [{ source: "artifact", path: "stories/s2-show-remaining.md", line: 1 }],
    waivable: false,
    state,
    ...(state === "dismissed"
      ? {
          resolution: {
            action: "not-relevant",
            by: "quinn",
            at: "2026-10-22T09:00:00Z",
            reason: "Covered by the UI tests",
          },
        }
      : {}),
    createdAt: "2026-10-21T09:00:00Z",
  });
  await put(
    join(root, "openspec/changes", CHANGE),
    `review/trace/1/${f.id}.yaml`,
    toCanonicalYaml(f),
  );
}

const BASE_SHA = "a".repeat(40);

const repos = (
  root: string,
  build: "passed" | "failed" | "not-run",
  pr: "merged" | "open" | "none" = "merged",
) =>
  writeChangeRepos(root, {
    schemaVersion: 1,
    change: CHANGE,
    repos: [
      {
        id: "forge-ledger",
        branch: `change/${CHANGE}`,
        base: "main",
        baseSha: BASE_SHA,
        worktree: `workspace/.worktrees/${CHANGE}/forge-ledger`,
        ...(pr === "none"
          ? {}
          : {
              pr: {
                url: "https://git.example.com/forge/forge-ledger/pull/7",
                number: 7,
                state: pr,
              },
            }),
        build: { status: build },
      },
    ],
  });

/** ADR 0074: the repo's facts, as `atticus verify` keeps them, read at `commit`. */
async function facts(root: string, commit: string) {
  const fact = {
    kind: "entry",
    id: "entry.post.transfers",
    repo: "forge-ledger",
    commit,
    entryType: "rest",
    method: "POST",
    path: "/transfers",
    cite: {
      file: "src/main/java/forge/ledger/LedgerEndpoints.java",
      line: 8,
      value: "/transfers",
    },
    verified: "line",
    by: "assistant",
    conf: "declared",
  };
  expect(parseFacts(JSON.stringify(fact)).ok).toBe(true);
  await put(join(root, "facts"), "forge-ledger.jsonl", `${JSON.stringify(fact)}\n`);
}

/** A catalog record the assistant's facts made, citing forge-ledger at `commit`. */
async function assistantRecord(root: string, commit: string) {
  await put(
    join(root, "catalog/generated"),
    "endpoint/ledger-api.post-transfers-old.yaml",
    [
      "schemaVersion: 2",
      "kind: Endpoint",
      "id: ledger-api.post-transfers-old",
      "status: current",
      "confidence: verified",
      "component: ledger-api",
      "endpointType: rest",
      "method: POST",
      "pathOrTopic: /old-transfers",
      "evidence:",
      "  - source: code",
      "    by: assistant",
      "    repo: forge-ledger",
      `    commit: ${commit}`,
      "    path: src/main/java/forge/ledger/LedgerEndpoints.java",
      "    line: 8",
      "",
    ].join("\n"),
  );
}

/** The repo's code as the readers see it, with an endpoint the catalog doesn't have. */
async function readersSeeMore(root: string) {
  const work = join(root, "..", "work", "forge-ledger");
  await cp(repoDir(root, "forge-ledger"), work, { recursive: true });
  await put(
    work,
    "src/main/java/forge/ledger/Admin.java",
    `package forge.ledger;

import forge.framework.*;

@ForgeService(name = "ledger-api")
public class Admin {
  @ForgeEndpoint(method = "POST", path = "/admin/reindex", auth = "oauth2")
  public void reindex() { }
}
`,
  );
  return work;
}

describe("archive gate", () => {
  it("passes a released change with clean findings, merged and built repos, and facts of the merged commit", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    const r = await archiveGate(root, CHANGE, {
      commit: COMMIT,
      repoDir: (id) => (id === "forge-ledger" ? repoDir(root, "forge-ledger") : undefined),
    });
    expect(r.blockers).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.drift.map((d) => [d.repo, d.drift])).toEqual([["forge-ledger", false]]);
  });

  it("the readers' drift is a cross-check note: the facts read at the merged commit decide (ADR 0074)", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    const work = await readersSeeMore(root);
    const r = await archiveGate(root, CHANGE, {
      commit: COMMIT,
      repoDir: (id) => (id === "forge-ledger" ? work : undefined),
    });
    expect(r.blockers).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.notes).toEqual([
      "Cross-check only, not blocking: the built-in readers see 1 difference in forge-ledger (POST /admin/reindex on ledger-api is in the code but not in the catalog). The facts read and verified at the merged commit decide (ADR 0074).",
    ]);
  });

  it("asks for the repo to be read again when its facts aren't of the merged commit", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await trace(root, "dismissed");
    // The assistant read the repo once (its record is in the catalog), but its facts are gone.
    await assistantRecord(root, COMMIT);
    const none = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(none.blockers).toEqual([
      {
        code: "needs-reading",
        message:
          "forge-ledger: no facts were read at bbbbbbbbbbbb, the commit its release merged into main: read it again (Map › Trust › Freshness: Read again, or atticus map forge-ledger), then atticus verify forge-ledger --write, so the catalog says what shipped.",
      },
    ]);
    await facts(root, "c".repeat(40));
    const old = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(old.blockers.map((b) => b.code)).toEqual(["needs-reading"]);
    expect(old.blockers[0]!.message).toMatch(
      /^forge-ledger: its facts were read at cccccccccccc, not at bbbbbbbbbbbb, the commit its release merged into main: read it again/,
    );
  });

  it("a repo the assistant never read keeps the readers' check: its catalog is theirs", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await trace(root, "dismissed");
    const work = await readersSeeMore(root);
    const r = await archiveGate(root, CHANGE, {
      commit: COMMIT,
      repoDir: (id) => (id === "forge-ledger" ? work : undefined),
    });
    expect(r.blockers).toEqual([
      {
        code: "drift",
        message:
          "forge-ledger: 1 catalog drift finding (POST /admin/reindex on ledger-api is in the code but not in the catalog).",
      },
    ]);
  });

  it("says to sync first when the clone is still where the change started", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await facts(root, BASE_SHA);
    await trace(root, "dismissed");
    const r = await archiveGate(root, CHANGE, { commit: BASE_SHA });
    expect(r.blockers.map((b) => b.code)).toEqual(["not-synced"]);
    expect(r.blockers[0]!.message).toBe(
      "forge-ledger: the clone here is still at aaaaaaaaaaaa, where the change started, though release PR #7 merged: sync the workspace (atticus workspace sync), then read the repo again.",
    );
  });

  it("asks for the catalog to be written from the facts when it cites an older commit", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    await assistantRecord(root, "c".repeat(40));
    const r = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(r.blockers).toEqual([
      {
        code: "catalog-stale",
        message:
          "forge-ledger: its facts are of the merged commit bbbbbbbbbbbb, but 1 catalog record still cites another commit: write them into the catalog (atticus verify forge-ledger --write, or Apply on the Map).",
      },
    ]);
  });

  it("blocks a repo with no release PR (ADR 0184), unless the org pack doesn't require merged PRs", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed", "none");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    const r = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(r.blockers).toEqual([
      {
        code: "pr-missing",
        message:
          "forge-ledger: no release PR from change/add-transfer-limit into main was raised, so the code never reached main: raise the release PRs (Release › Raise the release PRs, or atticus change release-prs add-transfer-limit --approve), and merge them on the Git host.",
      },
    ]);
    const lax = await metarepo({
      change: "released",
      ciYaml: "schemaVersion: 1\narchive:\n  requireMergedPrs: false\n",
    });
    await repos(lax, "passed", "none");
    await facts(lax, COMMIT);
    await trace(lax, "dismissed");
    expect((await archiveGate(lax, CHANGE, { commit: COMMIT })).blockers).toEqual([]);
  });

  it("passes a repo with nothing to release only while its change branch is where the raise found it (final review)", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed", "none");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    // The change worktree, on change/<id> with no commits beyond main, as the raise found it.
    const dir = join(root, `workspace/.worktrees/${CHANGE}/forge-ledger`);
    await mkdir(dir, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Tia",
      GIT_AUTHOR_EMAIL: "tia@example.com",
      GIT_COMMITTER_NAME: "Tia",
      GIT_COMMITTER_EMAIL: "tia@example.com",
    };
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: dir, env, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    await writeFile(join(dir, "README.md"), "# forge-ledger\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    git("checkout", "-q", "-b", `change/${CHANGE}`);
    await writeFile(
      join(root, "openspec/changes", CHANGE, "release-prs.yaml"),
      `schemaVersion: 1\nnothingToRelease:\n  - repo: forge-ledger\n    commit: ${git("rev-parse", "HEAD")}\n    at: 2026-11-08T10:00:00Z\n    by: tia\n`,
    );
    expect((await archiveGate(root, CHANGE, { commit: COMMIT })).blockers).toEqual([]);
    // Work landed on the change branch since: the entry is void, and the release PR is missing.
    await writeFile(join(dir, "Late.java"), "class Late {}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "late task");
    expect(
      (await archiveGate(root, CHANGE, { commit: COMMIT })).blockers.map((b) => b.code),
    ).toEqual(["pr-missing"]);
  });

  it("blocks a change that isn't released", async () => {
    const root = await metarepo({ change: "build" });
    const r = await archiveGate(root, CHANGE);
    expect(r.blockers).toEqual([
      {
        code: "wrong-state",
        message:
          "add-transfer-limit is build; a change is archived once it is released (go/no-go merged).",
      },
    ]);
    expect(r.notes).toEqual([
      "The change has no repos (repos.yaml), so there was no code to check for drift.",
    ]);
  });

  it("blocks on an open blocking finding on any gate, an open PR and a failed build", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "failed", "open");
    await trace(root, "open");
    const work = await readersSeeMore(root);
    const r = await archiveGate(root, CHANGE, {
      commit: COMMIT,
      repoDir: (id) => (id === "forge-ledger" ? work : undefined),
    });
    expect(r.pass).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(["finding", "pr-open", "build-failed"]);
    expect(r.blockers[1]!.message).toBe(
      "forge-ledger: release PR #7 is open; a person merges it on the Git host before archiving.",
    );
  });

  it("notes a merged release PR the Git host reported no build on", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "not-run");
    await facts(root, COMMIT);
    await trace(root, "dismissed");
    const r = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(r.blockers).toEqual([]);
    expect(r.notes).toContain(
      "forge-ledger: the Git host reported no checks on release PR #7, so no build is recorded for what merged.",
    );
  });

  it("reads the pipelines' drift reports instead of checking out the repos", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await facts(root, COMMIT);
    const clean = await repoDrift({
      repoDir: repoDir(root, "forge-ledger"),
      catalog: root,
      commit: COMMIT,
    });
    const file = join(root, "..", "drift.json");
    await writeFile(file, JSON.stringify(clean));
    const r = await archiveGate(root, CHANGE, { driftReports: [file] });
    expect(r.pass).toBe(true);
    const bad = await archiveGate(root, CHANGE, { driftReports: [join(root, "missing.json")] });
    expect(bad.blockers.map((b) => b.code)).toEqual(["drift-error"]);
  });

  it("can't gate a change that doesn't exist", async () => {
    const root = await metarepo();
    await expect(archiveGate(root, "nope")).rejects.toThrow();
  });
});
