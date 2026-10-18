import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Finding, toCanonicalYaml } from "@maycombhq/core";
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

const repos = (root: string, build: "passed" | "failed", pr: "merged" | "open" = "merged") =>
  writeChangeRepos(root, {
    schemaVersion: 1,
    change: CHANGE,
    repos: [
      {
        id: "forge-ledger",
        branch: `change/${CHANGE}`,
        base: "main",
        worktree: `workspace/.worktrees/${CHANGE}/forge-ledger`,
        pr: { url: "https://git.example.com/forge/forge-ledger/pull/7", number: 7, state: pr },
        build: { status: build },
      },
    ],
  });

describe("archive gate", () => {
  it("passes a released change with clean findings, merged and built repos and no drift", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
    await cp(
      repoDir(root, "forge-ledger"),
      join(root, `workspace/.worktrees/${CHANGE}/forge-ledger`),
      {
        recursive: true,
      },
    );
    await trace(root, "dismissed");
    const r = await archiveGate(root, CHANGE, { commit: COMMIT });
    expect(r.blockers).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.drift.map((d) => [d.repo, d.drift])).toEqual([["forge-ledger", false]]);
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

  it("blocks on an open blocking finding on any gate, an open PR, a failed build and drift", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "failed", "open");
    await trace(root, "open");
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
    const r = await archiveGate(root, CHANGE, {
      commit: COMMIT,
      repoDir: (id) => (id === "forge-ledger" ? work : undefined),
    });
    expect(r.pass).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(["finding", "pr-open", "build-failed", "drift"]);
    expect(r.blockers[1]!.message).toBe("forge-ledger: PR #7 is open; merge it before archiving.");
    expect(r.blockers[3]!.message).toBe(
      "forge-ledger: 1 catalog drift finding (POST /admin/reindex on ledger-api is in the code but not in the catalog).",
    );
  });

  it("reads the pipelines' drift reports instead of checking out the repos", async () => {
    const root = await metarepo({ change: "released" });
    await repos(root, "passed");
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
