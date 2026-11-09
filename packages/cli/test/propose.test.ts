import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStepStore, MockGitHost } from "@maycombhq/adapters";
import { changesRelOf } from "@maycombhq/core";
import { serializeChange } from "@maycombhq/changes";
import { createGit } from "@maycombhq/workspace";
import { bringInMerged, proposeForReview, proposePlan } from "../src/propose.js";

/**
 * ADR 0183: Propose for review lists what a kind of work changed and, on the person's yes,
 * pushes exactly those files to a branch and opens the PR. A person merges.
 */
const FORGE = join(import.meta.dirname, "../../../fixtures/forge/metarepo");
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "propose-"));
  const root = join(base, "meta");
  const remote = join(base, "remote.git");
  await cp(join(FORGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  const rt = join(root, "org-pack/runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace(
      "gitHost: { type: mock }",
      "gitHost: { type: mock, settings: { metarepo: forge-meta } }",
    ),
  );
  g(base, "init", "-q", "--bare", remote);
  // As atticus init writes it: this machine's folders stay out of Git.
  await writeFile(join(root, ".gitignore"), "/workspace/\n/.index/\n/.runs/\n");
  g(root, "init", "-q", "-b", "main");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  g(root, "push", "-q", "origin", "main");
  return { root, remote };
}

describe("Propose for review", () => {
  it("lists the answers' files, then pushes exactly those and opens the PR", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/private.md"), "not mine to propose\n");
    const now = new Date("2026-11-08T10:00:00Z");
    const plan = await proposePlan(root, "answers", { by: "Pat Lee", now });
    expect(plan.files).toEqual([{ path: "questions/q1.yaml", status: "??" }]);
    expect(plan.branch).toBe("propose/answers/2026-11-08-100000-pat-lee");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const was = { ...process.env };
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    });
    let code: number;
    try {
      code = await proposeForReview(
        root,
        {
          scope: "answers",
          by: "Pat Lee",
          files: ["questions/q1.yaml", "notes/private.md"],
          gitHost: host,
          now,
        },
        { out: (l) => said.push(l), err: (l) => said.push(`ERR ${l}`) },
      );
    } finally {
      process.env = was;
    }
    expect(code, said.join("\n")).toBe(0);
    expect(g(remote, "show", "propose/answers/2026-11-08-100000-pat-lee:questions/q1.yaml")).toBe(
      "answer: 1\n",
    );
    expect(() =>
      g(remote, "show", "propose/answers/2026-11-08-100000-pat-lee:notes/private.md"),
    ).toThrow();
    expect(said.at(-2)).toMatch(/^PR #\d+ is open for review/);
    // The person's working tree and branch are as they were.
    expect(g(root, "branch", "--show-current").trim()).toBe("main");
  });

  it("says so when nothing listed has a change", async () => {
    const { root } = await metarepo();
    const said: string[] = [];
    const code = await proposeForReview(
      root,
      {
        scope: "answers",
        by: "pat",
        files: ["questions/q9.yaml"],
        gitHost: new MockGitHost([{ repo: "forge-meta" }]),
      },
      { out: (l) => said.push(l), err: (l) => said.push(l) },
    );
    expect(code).toBe(2);
    expect(said[0]).toContain("Nothing to propose");
  });

  it("proposes an initiative's records and its folder, not the rest of the curated catalog", async () => {
    const { root } = await metarepo();
    const put = async (p: string) => {
      await mkdir(join(root, p, ".."), { recursive: true });
      await writeFile(join(root, p), "x: 1\n");
    };
    await put("catalog/curated/initiative/pay-v3.yaml");
    await put("catalog/curated/commitment/pay-v3.vendor-spec.yaml");
    await put("catalog/curated/party/party.northwind-pay.yaml");
    await put("initiatives/pay-v3/plan.yaml");
    await put("initiatives/pay-v3/notes.yaml");
    await put("catalog/curated/decision/d1.yaml");
    const plan = await proposePlan(root, "initiatives", {
      by: "tia",
      now: new Date("2026-11-08T10:00:00Z"),
    });
    expect(plan.files.map((f) => f.path)).toEqual([
      "catalog/curated/commitment/pay-v3.vendor-spec.yaml",
      "catalog/curated/initiative/pay-v3.yaml",
      "catalog/curated/party/party.northwind-pay.yaml",
      "initiatives/pay-v3/notes.yaml",
      "initiatives/pay-v3/plan.yaml",
    ]);
    expect(plan.branch).toBe("propose/initiatives/2026-11-08-100000-tia");
    expect(plan.title).toBe("Initiatives and commitments");
  });

  it("proposes the outcomes measured after release, not the rest of the change", async () => {
    const { root } = await metarepo();
    const put = async (p: string) => {
      await mkdir(join(root, p, ".."), { recursive: true });
      await writeFile(join(root, p), "x: 1\n");
    };
    await put("openspec/changes/add-transfer-limit/review/outcomes.yaml");
    await put("openspec/changes/add-transfer-limit/brief.md");
    await put("openspec/changes/archive/2026-10-01-old-change/review/outcomes.yaml");
    const plan = await proposePlan(root, "outcomes", { by: "pat" });
    expect(plan.files.map((f) => f.path)).toEqual([
      "openspec/changes/add-transfer-limit/review/outcomes.yaml",
      "openspec/changes/archive/2026-10-01-old-change/review/outcomes.yaml",
    ]);
    expect(plan.title).toBe("Outcomes measured after release");
  });

  it("lists only the changes' snow.md for the service desk's fields (round 36)", async () => {
    const { root } = await metarepo();
    for (const c of ["add-transfer-limit", "raise-refund-cap"]) {
      await mkdir(join(root, changesRelOf(root), c), { recursive: true });
      await writeFile(join(root, changesRelOf(root), c, "snow.md"), "# Service-desk requests\n");
      await writeFile(join(root, changesRelOf(root), c, "proposal.md"), "# Not the desk's\n");
    }
    const plan = await proposePlan(root, "service-desk", {
      by: "Pat Lee",
      now: new Date("2026-11-08T10:00:00Z"),
    });
    expect(plan.files.map((f) => f.path)).toEqual([
      `${changesRelOf(root)}/add-transfer-limit/snow.md`,
      `${changesRelOf(root)}/raise-refund-cap/snow.md`,
    ]);
    expect(plan.branch).toBe("propose/service-desk/2026-11-08-100000-pat-lee");
    expect(plan.title).toBe("Service-desk request fields");
  });

  // Ninth UX walk: a batch's record (decisions/) never reached main, so Undo couldn't work on
  // another clone. It goes with the answers and corrections it names, and with Home's Propose.
  it("proposes the decision batches' records with the work, the answers and the corrections", async () => {
    const { root } = await metarepo();
    await mkdir(join(root, "decisions"), { recursive: true });
    await writeFile(join(root, "decisions/b-20261108-221204-48de16.yaml"), "id: b\n");
    for (const scope of ["work", "answers", "corrections"] as const)
      expect((await proposePlan(root, scope, { by: "pat" })).files.map((f) => f.path)).toContain(
        "decisions/b-20261108-221204-48de16.yaml",
      );
    expect(
      (await proposePlan(root, "org-pack", { by: "pat" })).files.map((f) => f.path),
    ).not.toContain("decisions/b-20261108-221204-48de16.yaml");
  });

  // Ninth UX walk: a stage correction saved in the app is proposed with Home's Propose.
  it("proposes a change's stage corrections and drafted record with the work, not its loop files", async () => {
    const { root } = await metarepo();
    const stage = join(root, changesRelOf(root), "add-transfer-limit", "stage");
    await mkdir(stage, { recursive: true });
    for (const f of ["corrections.yaml", "drafted.yaml", "feature.yaml"])
      await writeFile(join(stage, f), "x: 1\n");
    const files = (await proposePlan(root, "work", { by: "pat" })).files.map((f) => f.path);
    const rel = `${changesRelOf(root)}/add-transfer-limit/stage`;
    expect(files).toContain(`${rel}/corrections.yaml`);
    expect(files).toContain(`${rel}/drafted.yaml`);
    expect(files).not.toContain(`${rel}/feature.yaml`);
  });
});

const envOn = () => {
  const was = { ...process.env };
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  return () => {
    process.env = was;
  };
};

describe("review round 35", () => {
  it("carries a rename's removal, gives a second proposal its own branch, and says a refusal", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts/old name.jsonl"), "{}\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "facts");
    g(root, "push", "-q", "origin", "main");
    g(root, "mv", "facts/old name.jsonl", "facts/new näme.jsonl");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(`ERR ${l}`) };
    const off = envOn();
    try {
      const plan = await proposePlan(root, "corrections", {
        by: "pat",
        now: new Date("2026-11-08T10:00:00Z"),
      });
      expect(plan.files).toEqual([
        { path: "facts/new näme.jsonl", status: "R", from: "facts/old name.jsonl" },
      ]);
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:00:00Z"),
          },
          io,
        ),
      ).toBe(0);
      const tree = g(
        remote,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "propose/corrections/2026-11-08-100000-pat",
      ).split("\0");
      expect(tree).toContain("facts/new näme.jsonl");
      expect(tree).not.toContain("facts/old name.jsonl");
      // The same branch again (the same second): the host refuses, and it is said, not a 500.
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:00:00Z"),
          },
          io,
        ),
      ).toBe(1);
      expect(said.at(-1)).toMatch(/^ERR The PR wasn't opened: /);
      // A minute later is its own branch.
      expect(
        await proposeForReview(
          root,
          {
            scope: "corrections",
            by: "pat",
            files: ["facts/new näme.jsonl"],
            gitHost: host,
            now: new Date("2026-11-08T10:01:00Z"),
          },
          io,
        ),
      ).toBe(0);
    } finally {
      off();
    }
  });

  it("brings in what merged: the same edits are put back, the person's own stay", async () => {
    const { root, remote } = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "my own edit\n");
    const host = new MockGitHost([{ repo: "forge-meta" }]);
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(`ERR ${l}`) };
    const off = envOn();
    try {
      g(root, "branch", "-q", "--set-upstream-to=origin/main", "main");
      const now = new Date("2026-11-08T11:00:00Z");
      expect(
        await proposeForReview(
          root,
          { scope: "answers", by: "pat", files: ["questions/q1.yaml"], gitHost: host, now },
          io,
        ),
      ).toBe(0);
      // The PR merges on the host (here: the branch is merged into main on the remote).
      const work = join(root, "..", "merger");
      g(join(root, ".."), "clone", "-q", "-b", "main", remote, work);
      g(work, "merge", "-q", "--no-edit", "origin/propose/answers/2026-11-08-110000-pat");
      g(work, "push", "-q", "origin", "main");
      expect(await bringInMerged(root, io)).toBe(0);
      expect(g(root, "log", "-1", "--format=%s").trim()).not.toBe("init");
      expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("my own edit\n");
      expect(said.at(-1)).toContain("Your own edits stay as they were: README.md");
    } finally {
      off();
    }
  });
});

describe("beta.23: Home's list of what to propose, with many files already proposed", () => {
  it("asks Git once per proposal branch and once for the files' contents, not twice a file", async () => {
    const { root } = await metarepo();
    await mkdir(join(root, "questions"), { recursive: true });
    const git = createGit();
    const proposed: Record<string, { blob: string; where: string; branch: string }> = {};
    g(root, "update-ref", "refs/remotes/origin/propose/answers/a", "HEAD");
    for (let i = 0; i < 60; i++) {
      const rel = `questions/q${i}.yaml`;
      await writeFile(join(root, rel), `answer: ${i}\n`);
      proposed[rel] = {
        blob: g(root, "hash-object", "--", rel).trim(),
        // Half on a branch the remote has, half on one it no longer has (merged and deleted).
        where: i % 2 ? "propose/answers/a" : "propose/answers/gone",
        branch: i % 2 ? "propose/answers/a" : "propose/answers/gone",
      };
    }
    // One changed since it was proposed.
    await writeFile(join(root, "questions/q1.yaml"), "answer: changed\n");
    await mkdir(join(root, ".index"), { recursive: true });
    await writeFile(join(root, ".index/proposed.json"), JSON.stringify(proposed));
    const calls: string[][] = [];
    const counted = (args: string[], cwd: string) => {
      calls.push(args);
      return git(args, cwd);
    };
    const plan = await proposePlan(root, "answers", { by: "pat", git: counted });
    const of = (n: number) => plan.files.find((f) => f.path === `questions/q${n}.yaml`);
    expect(of(3)?.proposed).toBe("propose/answers/a");
    expect(of(1)?.proposed).toBeUndefined();
    expect(of(2)?.proposed).toBeUndefined();
    expect(plan.files).toHaveLength(60);
    // status, a rev-parse per branch, one hash-object: four, where it was 91.
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});

describe("review round 36: Bring in never loses an edit", () => {
  const setup = async () => {
    const { root, remote } = await metarepo();
    g(root, "branch", "-q", "--set-upstream-to=origin/main", "main");
    await writeFile(join(root, "other.md"), "base\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "other");
    g(root, "push", "-q", "origin", "main");
    const work = join(root, "..", "teammate");
    g(join(root, ".."), "clone", "-q", "-b", "main", remote, work);
    return { root, work };
  };
  const io = (said: string[]) => ({
    out: (l: string) => said.push(l),
    err: (l: string) => said.push(`ERR ${l}`),
  });

  it("refuses with nothing touched when what merged also changes a file the person edited", async () => {
    const { root, work } = await setup();
    await mkdir(join(work, "questions"), { recursive: true });
    await writeFile(join(work, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(work, "README.md"), "edited\n");
    await writeFile(join(work, "other.md"), "the teammate's\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "merged");
    g(work, "push", "-q", "origin", "main");
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "edited\n");
    await writeFile(join(root, "other.md"), "mine\n");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(1);
    expect(said.at(-1)).toContain("nothing was changed: other.md");
    expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("edited\n");
    expect(await readFile(join(root, "other.md"), "utf8")).toBe("mine\n");
  });

  it("sets a staged new file aside, and brings in the rest", async () => {
    const { root, work } = await setup();
    await mkdir(join(work, "questions"), { recursive: true });
    await writeFile(join(work, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(work, "README.md"), "edited\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "merged");
    g(work, "push", "-q", "origin", "main");
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    await writeFile(join(root, "README.md"), "edited\n");
    g(root, "add", "-A");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("merged");
    expect(await readFile(join(root, "questions/q1.yaml"), "utf8")).toBe("answer: 1\n");
    expect(g(root, "status", "--porcelain").trim()).toBe("");
  });

  it("refuses a branch with its own commits, with nothing touched", async () => {
    const { root, work } = await setup();
    await writeFile(join(work, "other.md"), "theirs\n");
    g(work, "commit", "-q", "-am", "theirs");
    g(work, "push", "-q", "origin", "main");
    await writeFile(join(root, "local.md"), "x\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "local");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(1);
    expect(said.at(-1)).toContain("Your branch has commits");
  });

  it("takes a file deleted here and in what merged as the same edit", async () => {
    const { root, work } = await setup();
    g(work, "rm", "-q", "other.md");
    g(work, "commit", "-q", "-m", "removed");
    g(work, "push", "-q", "origin", "main");
    g(root, "rm", "-q", "other.md");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("removed");
    expect(g(root, "status", "--porcelain").trim()).toBe("");
  });

  it("marks a file already proposed, until its content changes (round 37)", async () => {
    const { root } = await setup();
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
    const said: string[] = [];
    const off = envOn();
    try {
      expect(
        await proposeForReview(
          root,
          {
            scope: "answers",
            by: "pat",
            files: ["questions/q1.yaml"],
            gitHost: new MockGitHost([{ repo: "forge-meta" }]),
          },
          io(said),
        ),
        said.join("\n"),
      ).toBe(0);
    } finally {
      off();
    }
    const after = await proposePlan(root, "answers", { by: "pat" });
    expect(after.files.find((f) => f.path === "questions/q1.yaml")?.proposed).toBeTruthy();
    await writeFile(join(root, "questions/q1.yaml"), "answer: 2\n");
    const changed = await proposePlan(root, "answers", { by: "pat" });
    expect(changed.files.find((f) => f.path === "questions/q1.yaml")?.proposed).toBeUndefined();
    // Round 38: the record is in .index, which a metarepo's .gitignore leaves out.
    expect(existsSync(join(root, ".index", "proposed.json"))).toBe(true);
    expect(existsSync(join(root, "proposed.json"))).toBe(false);
  });

  it("carries a change's own record across a hand-off's merge (fifth UX walk)", async () => {
    const { root, work } = await setup();
    const rel = "openspec/changes/c1";
    await mkdir(join(work, rel), { recursive: true });
    await writeFile(join(work, rel, "brief.md"), "# Brief\n");
    await writeFile(join(work, rel, "change.yaml"), "state: define\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "hand-off merged");
    g(work, "push", "-q", "origin", "main");
    // The hand-off was published from here: its branch is kept here (gitHandoffPublisher).
    g(root, "fetch", "-q", "origin");
    g(root, "branch", "-q", "handoff/c1/define", "origin/main");
    await mkdir(join(root, rel), { recursive: true });
    await writeFile(join(root, rel, "brief.md"), "# Brief\n");
    // Sync wrote the gate's newer state after the merge.
    await writeFile(join(root, rel, "change.yaml"), "state: design\n");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("hand-off merged");
    expect(await readFile(join(root, rel, "change.yaml"), "utf8")).toBe("state: design\n");
    // Sixth UX walk: the merged record is said as merged, never as an edit left out.
    expect(said.join("\n")).not.toContain("Your own edits stay");
    expect(said.join("\n")).toContain(`Merged with your copy's newer state: ${rel}/change.yaml`);
    expect(said.join("\n")).toContain("1 file was already the same");
  });

  it("keeps a reviewer's edit to the change's record as well as Sync's newer state (round 40)", async () => {
    const { root, work } = await setup();
    const rel = "openspec/changes/c1";
    const before = "id: c1\nstate: define\nowner: pat\nsystems:\n  - forge-ledger\n";
    await mkdir(join(root, rel), { recursive: true });
    await writeFile(join(root, rel, "change.yaml"), before);
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "change");
    g(root, "push", "-q", "origin", "main");
    g(work, "pull", "-q", "origin", "main");
    // The reviewer adds a system on the hand-off; Sync here moved the state.
    await writeFile(join(work, rel, "change.yaml"), before + "  - forge-gateway\n");
    g(work, "commit", "-q", "-am", "reviewer");
    g(work, "push", "-q", "origin", "main");
    await writeFile(
      join(root, rel, "change.yaml"),
      before.replace("state: define", "state: design"),
    );
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    const now = await readFile(join(root, rel, "change.yaml"), "utf8");
    expect(now).toContain("state: design");
    expect(now).toContain("forge-gateway");
  });
  /** A change's record the reviewer edited upstream; here Sync moved its state (round 41). */
  const reviewed = async (o: { committed: boolean; handoff?: boolean }) => {
    const { root, work } = await setup();
    const rel = "openspec/changes/c1";
    const before = "id: c1\nstate: define\nowner: pat\nsystems:\n  - forge-ledger\n";
    await mkdir(join(root, rel), { recursive: true });
    await mkdir(join(work, rel), { recursive: true });
    if (o.committed) {
      await writeFile(join(root, rel, "change.yaml"), before);
      g(root, "add", "-A");
      g(root, "commit", "-q", "-m", "change");
      g(root, "push", "-q", "origin", "main");
      g(work, "pull", "-q", "origin", "main");
    } else {
      await writeFile(join(work, rel, "change.yaml"), before);
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", "hand-off");
      g(work, "push", "-q", "origin", "main");
      if (o.handoff) {
        g(root, "fetch", "-q", "origin");
        g(root, "branch", "-q", "handoff/c1/define", "origin/main");
      }
    }
    await writeFile(join(work, rel, "change.yaml"), before + "  - forge-gateway\n");
    g(work, "commit", "-q", "-am", "reviewer");
    g(work, "push", "-q", "origin", "main");
    const mine = before.replace("state: define", "state: design");
    await writeFile(join(root, rel, "change.yaml"), mine);
    return { root, file: join(root, rel, "change.yaml"), mine, rel };
  };

  it("refuses, with nothing changed, when it can't tell what the copy last had of the record (round 41)", async () => {
    const { root, file, mine } = await reviewed({ committed: false });
    const head = g(root, "rev-parse", "HEAD");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(1);
    expect(said.join("\n")).toContain("nothing was changed");
    expect(await readFile(file, "utf8")).toBe(mine);
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("takes the base from the hand-off branch the remote keeps (round 41)", async () => {
    const { root, file } = await reviewed({ committed: false });
    g(root, "fetch", "-q", "origin");
    // The hand-off was published from another clone: only origin's branch names its base. The
    // branch is as the host keeps it after the merge, the reviewer's commit on top of Atticus's;
    // the base is Atticus's commit, the branch's first after it left this copy's main.
    g(root, "push", "-q", "origin", "origin/main:refs/heads/handoff/c1/define");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    const now = await readFile(file, "utf8");
    expect(now).toContain("state: design");
    expect(now).toContain("forge-gateway");
  });

  /**
   * Final review (git and tasks): a new change's hand-off as gitHandoffPublisher leaves it (a
   * commit on main, the local ref and the remote branch), then a reviewer's commit on the hand-off
   * branch, merged; here Sync recorded the merge. The remote branch is newer than the local ref.
   */
  const reviewedHandoff = async () => {
    const { root, work } = await setup();
    const remote = join(root, "..", "remote.git");
    const ID = "c1";
    const rel = `openspec/changes/${ID}`;
    const T = (h: string) => `2026-11-08T${h}:00Z`;
    const ho = (state: string, at: string) => ({
      phase: "define",
      branch: `handoff/${ID}/define`,
      pr: { number: 7, url: "https://git.forge.example/pr/7" },
      state,
      by: "ada",
      openedAt: T("10:00"),
      updatedAt: at,
      reviewers: [],
      approvals: [],
      artifacts: [],
    });
    const pushed = {
      schemaVersion: 1 as const,
      id: ID,
      title: "Old title",
      type: "feature",
      state: "define" as const,
      owners: {},
      createdAt: T("09:00"),
      createdBy: "ada",
      history: [{ from: "draft", to: "define", at: T("09:00"), by: "ada" }],
      handoffs: [ho("open", T("10:00"))],
    };
    await mkdir(join(root, rel), { recursive: true });
    await writeFile(join(root, rel, "brief.md"), "# Brief\n");
    await writeFile(join(root, rel, "change.yaml"), serializeChange(pushed as never));
    g(root, "add", "-A");
    const tree = g(root, "write-tree").trim();
    g(root, "reset", "-q");
    const at = (date: string) => ({
      ...process.env,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_DATE: date,
    });
    const published = execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-m",
        "hand-off",
      ],
      { cwd: root, encoding: "utf8", env: at("2026-11-08T10:00:00Z") },
    ).trim();
    g(root, "update-ref", `refs/heads/handoff/${ID}/define`, published);
    g(root, "push", "-q", "origin", `${published}:refs/heads/handoff/${ID}/define`);
    // The reviewer edits the title on the hand-off branch; the PR merges (fast-forward).
    const rev = join(root, "..", "reviewer");
    g(join(root, ".."), "clone", "-q", "-b", `handoff/${ID}/define`, remote, rev);
    await writeFile(
      join(rev, rel, "change.yaml"),
      serializeChange({ ...pushed, title: "Reviewer title" } as never),
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.name=r",
        "-c",
        "user.email=r@example.com",
        "commit",
        "-q",
        "-am",
        "reviewer: title",
      ],
      { cwd: rev, env: at("2026-11-08T10:30:00Z") },
    );
    g(rev, "push", "-q", "origin", `HEAD:refs/heads/handoff/${ID}/define`);
    g(rev, "push", "-q", "origin", "HEAD:main");
    void work;
    // Here Sync recorded the merge.
    const file = join(root, rel, "change.yaml");
    await writeFile(
      file,
      serializeChange({
        ...pushed,
        state: "design",
        history: [
          ...pushed.history,
          { from: "define", to: "design", at: T("11:00"), by: "ada", pr: 7 },
        ],
        handoffs: [ho("merged", T("11:00"))],
      } as never),
    );
    return { root, file, ID };
  };

  it("keeps a reviewer's edit to a new change's record from the hand-off branch (final review)", async () => {
    const { root, file } = await reviewedHandoff();
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    const now = await readFile(file, "utf8");
    expect(now).toContain("title: Reviewer title");
    expect(now).toContain("state: design");
  });

  it("keeps it when only the remote keeps the hand-off branch, its tip the reviewer's (final review)", async () => {
    const { root, file, ID } = await reviewedHandoff();
    g(root, "update-ref", "-d", `refs/heads/handoff/${ID}/define`);
    g(root, "fetch", "-q", "origin");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    const now = await readFile(file, "utf8");
    expect(now).toContain("title: Reviewer title");
    expect(now).toContain("state: design");
  });

  it("brings in a record new here and staged, kept with the reviewer's edit (round 41)", async () => {
    const { root, file, rel } = await reviewed({ committed: false, handoff: true });
    g(root, "add", "--", rel);
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    const now = await readFile(file, "utf8");
    expect(now).toContain("state: design");
    expect(now).toContain("forge-gateway");
  });

  it("refuses when the record was deleted here and changed in what merged (round 41)", async () => {
    const { root, file } = await reviewed({ committed: true });
    await rm(file);
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(1);
    expect(said.join("\n")).toContain("change.yaml");
    expect(existsSync(file)).toBe(false);
  });

  /**
   * Ninth UX walk: the design hand-off merged on the host while Sync here moved the change to
   * plan and added the hand-off's entries. Both sides edit the same lines of change.yaml, so the
   * text merge refused; the record is merged by its fields instead.
   */
  const ID = "let-tellers-lock-a-card";
  const T = (h: string) => `2026-11-08T${h}:00Z`;
  const ho = (phase: string, n: number, state: string, at: string) => ({
    phase,
    branch: `handoff/${ID}/${phase}`,
    pr: { number: n, url: `https://git.forge.example/pr/${n}` },
    state,
    by: "ada",
    openedAt: at,
    updatedAt: at,
    approvals: [{ by: "bo", at }],
  });
  const st = (from: string, to: string, at: string, pr?: number) => ({
    from,
    to,
    at,
    by: "ada",
    ...(pr ? { pr } : {}),
  });
  const atDefine = {
    schemaVersion: 1 as const,
    id: ID,
    title: "Let tellers lock a card",
    type: "feature",
    state: "define" as const,
    owners: { "product-owner": ["ada"] },
    createdAt: T("22:00"),
    createdBy: "ada",
    history: [st("draft", "define", T("22:00"))],
    handoffs: [ho("define", 102, "open", T("22:28"))],
  };
  const onBranch = {
    ...atDefine,
    state: "design" as const,
    authors: { brief: ["ada"] },
    history: [...atDefine.history, st("define", "design", T("22:32"), 102)],
    handoffs: [ho("define", 102, "merged", T("22:32")), ho("design", 103, "open", T("22:46"))],
  };
  const synced = {
    ...onBranch,
    state: "plan" as const,
    authors: { brief: ["ada"], design: ["ada"] },
    history: [...onBranch.history, st("design", "plan", T("22:47"), 103)],
    handoffs: [ho("define", 102, "merged", T("22:32")), ho("design", 103, "merged", T("22:47"))],
  };
  const handedOff = async (reviewer?: Partial<typeof onBranch>) => {
    const { root, work } = await setup();
    const rel = `openspec/changes/${ID}`;
    const file = join(root, rel, "change.yaml");
    await mkdir(join(root, rel), { recursive: true });
    await writeFile(file, serializeChange(atDefine as never));
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "define merged");
    g(root, "push", "-q", "origin", "main");
    // The design hand-off branch, published from here, merged on the host.
    g(work, "pull", "-q", "origin", "main");
    await writeFile(join(work, rel, "design.md"), "# Design\n");
    await writeFile(
      join(work, rel, "change.yaml"),
      serializeChange({ ...onBranch, ...reviewer } as never),
    );
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "Approve design");
    g(work, "push", "-q", "origin", `HEAD:refs/heads/handoff/${ID}/design`);
    g(work, "push", "-q", "origin", "HEAD:main");
    // Here: the design.md the hand-off carried, and Sync's newer record.
    await writeFile(join(root, rel, "design.md"), "# Design\n");
    await writeFile(file, serializeChange(synced as never));
    return { root, file };
  };

  it("merges the change's record by its fields after a hand-off merged (ninth UX walk)", async () => {
    const { root, file } = await handedOff();
    const said: string[] = [];
    expect(await bringInMerged(root, io(said)), said.join("\n")).toBe(0);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("Approve design");
    expect(await readFile(file, "utf8")).toBe(serializeChange(synced as never));
    expect(said.join("\n")).toContain(
      `Merged with your copy's newer state: openspec/changes/${ID}/change.yaml`,
    );
  });

  it("keeps a reviewer's title with Sync's state, and refuses two different titles", async () => {
    const kept = await handedOff({ title: "Let tellers lock a card from the branch" });
    expect(await bringInMerged(kept.root, io([]))).toBe(0);
    const now = await readFile(kept.file, "utf8");
    expect(now).toContain("title: Let tellers lock a card from the branch");
    expect(now).toContain("state: plan");

    const { root, file } = await handedOff({ title: "Lock a card at the counter" });
    const mine = serializeChange({ ...synced, title: "Lock a card from the branch" } as never);
    await writeFile(file, mine);
    const head = g(root, "rev-parse", "HEAD");
    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(1);
    expect(said.join("\n")).toContain("nothing was changed");
    expect(said.join("\n")).toContain("title");
    expect(await readFile(file, "utf8")).toBe(mine);
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("puts the person's own record back when the copy can't be brought up (round 41)", async () => {
    const { root, file, mine } = await reviewed({ committed: true });
    const real = createGit();
    const git: typeof real = (a, c) =>
      a[0] === "merge" ? Promise.reject(new Error("held by another process")) : real(a, c);
    const said: string[] = [];
    expect(await bringInMerged(root, io(said), { git }), said.join("\n")).toBe(1);
    expect(await readFile(file, "utf8")).toBe(mine);
  });
});

/**
 * Ninth UX walk: on a manual Git host, the "Open a pull request" steps of a hand-off or proposal
 * stayed open after Bring in had brought its merge in. They close, saying so, and Sync then reads
 * the PR as merged; a PR not merged, or into another repo, keeps its steps.
 */
describe("Bring in closes the manual steps of a PR that merged", () => {
  const io = (said: string[]) => ({
    out: (l: string) => said.push(l),
    err: (l: string) => said.push(`ERR ${l}`),
  });
  const openStep = (head: string, number: number, repo = "forge-meta", change?: string) => ({
    slug: `open-pr-${head}`,
    ...(change ? { change } : {}),
    system: "git-host" as const,
    action: "open-pull-request",
    key: `git-host|pr|${repo}|${head}|${number}`,
    title: `Open a pull request from ${head} into main`,
    where: `Git host: ${repo}, new pull request`,
    inputs: { title: head, base: "main", head, number, repo },
    result: [
      { name: "url", label: "Pull request link", format: "url" as const, required: true },
      { name: "number", label: "Pull request number", format: "integer" as const, required: true },
    ],
    createdBy: "ada",
  });
  const reportStep = (head: string, number: number, dependsOn: string, change?: string) => ({
    slug: `report-pr-${head}`,
    ...(change ? { change } : {}),
    system: "git-host" as const,
    action: "report-pull-request",
    key: `git-host|report|forge-meta|${number}|0`,
    title: `Record the reviews and checks on the PR from ${head}, and whether it merged`,
    where: "Git host: forge-meta",
    inputs: { number, repo: "forge-meta" },
    dependsOn: [dependsOn],
    result: [
      { name: "approvers", label: "Approved by", format: "handles" as const, required: false },
      {
        name: "checksPassing",
        label: "All checks pass",
        format: "yes-no" as const,
        required: true,
      },
      {
        name: "merged",
        label: "Merged on the Git host",
        format: "yes-no" as const,
        required: false,
      },
    ],
    createdBy: "atticus",
  });

  it("closes a merged hand-off's steps, and leaves an unmerged PR's and another repo's open", async () => {
    const { root, remote } = await metarepo();
    g(root, "branch", "-q", "--set-upstream-to=origin/main", "main");
    // The branches, published from here (gitHandoffPublisher keeps them here and pushes them).
    for (const [branch, file] of [
      ["handoff/c1/define", "brief.md"],
      ["propose/work/2026-11-08-221013-ada", "notes.md"],
    ] as const) {
      g(root, "checkout", "-q", "-b", branch, "main");
      await writeFile(join(root, file), "x\n");
      g(root, "add", "-A");
      g(root, "commit", "-q", "-m", branch);
      g(root, "push", "-q", "origin", branch);
      g(root, "checkout", "-q", "main");
    }
    // A branch with no commits of its own reads as not merged.
    g(root, "branch", "-q", "handoff/c2/define", "main");
    const store = fileStepStore(root);
    const define = await store.create(openStep("handoff/c1/define", 1, "forge-meta", "c1"));
    const report = await store.create(reportStep("handoff/c1/define", 1, define.id, "c1"));
    const proposal = await store.create(openStep("propose/work/2026-11-08-221013-ada", 2));
    const empty = await store.create(openStep("handoff/c2/define", 3));
    const release = await store.create(openStep("handoff/c1/define", 4, "forge-ledger"));
    // The host merges the hand-off (a merge commit), and deletes its branch.
    const hostClone = join(root, "..", "host");
    g(join(root, ".."), "clone", "-q", "-b", "main", remote, hostClone);
    g(hostClone, "merge", "-q", "--no-ff", "origin/handoff/c1/define", "-m", "Merge PR #1");
    g(hostClone, "push", "-q", "origin", "main");
    g(hostClone, "push", "-q", "origin", "--delete", "handoff/c1/define");
    const said: string[] = [];
    expect(
      await bringInMerged(root, io(said), { now: new Date("2026-11-08T23:30:00Z") }),
      said.join("\n"),
    ).toBe(0);
    expect(said.join("\n")).toContain(
      "Closed the manual steps of a pull request that merged (merged, seen by Bring in): handoff/c1/define.",
    );
    const opened = (await store.get(define.id))!;
    expect(opened.state).toBe("done");
    expect(opened.recorded).toMatchObject({ by: "atticus", note: "merged, seen by Bring in" });
    const reported = (await store.get(report.id))!;
    expect(reported.state).toBe("done");
    expect(reported.recorded?.values).toMatchObject({ merged: true });
    for (const s of [proposal, empty, release]) expect((await store.get(s.id))!.state).toBe("open");
  });
});
