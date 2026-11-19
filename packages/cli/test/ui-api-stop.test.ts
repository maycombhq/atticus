import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost, type GitHost } from "@maycombhq/adapters";
import { Api, withCommit, withSignal } from "@maycombhq/core";
import { startServer, STOPPED, TOO_LATE, type ServerContext } from "@maycombhq/server";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import {
  BRING_IN_STOPPED,
  bringInMerged,
  PROPOSE_STOPPED,
  PROPOSE_STOPPED_EARLY,
  proposeForReview,
  STOPPED_CODE,
} from "../src/propose.js";
import { uiRoutes } from "../src/ui-api.js";

/**
 * ADR 0202 point 2: Propose for review and Bring in what merged say their step and hear Stop
 * until their commit point (Propose: just before the push; Bring in: just before the working
 * tree is changed). A Propose stopped before its push leaves the Git host and the remote
 * untouched: no branch, no PR, nothing marked proposed; the commit is on the branch here, and
 * Propose again pushes that commit. Stopped after, it finishes. The Git host is the mock; the
 * remote is a bare repository on this machine (no network).
 */
const FORGE = join(import.meta.dirname, "../../../fixtures/forge/metarepo");
const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
Object.assign(process.env, ENV);
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const tryG = (cwd: string, ...a: string[]) => {
  try {
    return g(cwd, ...a).trim();
  } catch {
    return undefined;
  }
};

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "atticus-stop-"));
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
  await writeFile(join(root, ".gitignore"), "/workspace/\n/.index/\n/.runs/\n/.atticus/\n");
  g(root, "init", "-q", "-b", "main");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  g(root, "push", "-q", "-u", "origin", "main");
  await mkdir(join(root, "questions"), { recursive: true });
  await writeFile(join(root, "questions/q1.yaml"), "answer: 1\n");
  return { root, remote };
}

/** A Git host that counts its writes, and can hold one call until let go. */
function heldHost(hold: "getRepo" | "createPullRequest") {
  const inner = new MockGitHost([{ repo: "forge-meta" }]);
  let reached!: () => void;
  let go!: () => void;
  const at = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (go = r));
  const prs: unknown[] = [];
  const host = new Proxy(inner, {
    get(t, k, recv) {
      const v = Reflect.get(t, k, recv) as unknown;
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        if (k === hold) {
          reached();
          await gate;
        }
        if (k === "createPullRequest") prs.push(args[0]);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as unknown as GitHost;
  return { host, at, go, prs };
}

const BRANCH = "propose/answers/2026-11-18-100000-pat";
const remoteBranches = (remote: string) =>
  g(remote, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n");

describe("Propose for review: its steps and Stop (ADR 0202 point 2)", () => {
  it("says each step in order, and its commit point is just before the push", async () => {
    const { root } = await metarepo();
    const steps: string[] = [];
    let committedAt = -1;
    const code = await withCommit(
      () => (committedAt = steps.length),
      () =>
        proposeForReview(
          root,
          {
            scope: "answers",
            by: "pat",
            files: ["questions/q1.yaml"],
            branch: BRANCH,
            gitHost: new MockGitHost([{ repo: "forge-meta" }]),
          },
          { out: () => undefined, err: () => undefined, progress: (l) => steps.push(l) },
        ),
    );
    expect(code).toBe(0);
    expect(steps).toEqual([
      "Listing what changed…",
      `Committing 1 file to ${BRANCH}…`,
      `Pushing ${BRANCH}…`,
      "Opening the pull request…",
    ]);
    // Committed (Stop too late) after "Committing…" and before "Pushing…" was said.
    expect(committedAt).toBe(2);
  }, 60_000);

  it("stopped before the commit is made: nothing committed, nothing pushed, no PR", async () => {
    const { root, remote } = await metarepo();
    const stop = new AbortController();
    const h = heldHost("getRepo");
    const said: string[] = [];
    const ran = proposeForReview(
      root,
      {
        scope: "answers",
        by: "pat",
        files: ["questions/q1.yaml"],
        branch: BRANCH,
        gitHost: h.host,
        signal: stop.signal,
      },
      { out: (l) => said.push(l), err: (l) => said.push(l) },
    );
    await h.at;
    stop.abort();
    h.go();
    expect(await ran).toBe(STOPPED_CODE);
    expect(said).toEqual([PROPOSE_STOPPED_EARLY]);
    expect(remoteBranches(remote)).toEqual(["refs/heads/main"]);
    expect(tryG(root, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).toBeUndefined();
    expect(h.prs).toEqual([]);
  }, 60_000);

  it("a job stopped before the push: the host and the remote untouched, the commit on the branch here, and Propose again pushes that commit", async () => {
    const { root, remote } = await metarepo();
    const first = heldHost("getRepo");
    let host = first.host;
    let ctx!: ServerContext;
    const pageKey = "k".repeat(43);
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      pageKey,
      watch: false,
      extend: (r, c) => {
        ctx = c;
        // The host of the moment, so the second Propose gets one that holds nothing.
        const now = new Proxy({} as GitHost, {
          get: (_t, k) => Reflect.get(host, k, host) as unknown,
        });
        return uiRoutes(r, c, { gitHost: now, autoDone: { off: true } });
      },
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(s.url + path, {
        method,
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const propose = async () => {
      const c = await call("POST", "/api/confirmations", {
        write: "propose",
        target: "answers",
        pageKey,
      });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const r = await call("POST", "/api/propose", {
        scope: "answers",
        files: ["questions/q1.yaml"],
        branch: BRANCH,
        confirmation: c.body.confirmation,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return String(r.body.jobId);
    };
    try {
      const id = await propose();
      await first.at;
      const running = Api.Job.parse((await call("GET", `/api/jobs/${id}`)).body);
      expect(running).toMatchObject({
        stoppable: true,
        stopLands: "now",
        for: { action: "propose" },
      });
      // The pre-push steps are local and quick: Stop is asked once the commit is being made.
      const committing = async () => {
        for (let n = 0; n < 400; n++) {
          if (ctx.jobs.get(id)!.progress.message.startsWith("Committing 1 file to ")) return;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`never said Committing: ${ctx.jobs.get(id)!.progress.message}`);
      };
      first.go();
      await committing();
      expect((await call("POST", `/api/jobs/${id}/cancel`)).status).toBe(200);
      expect(ctx.jobs.get(id)).toMatchObject({ stopping: true, stoppable: false });
      const end = Api.Job.parse(await ctx.jobs.settle(id));
      expect(end.state).toBe("cancelled");
      expect(end.stoppable).toBe(false);
      expect(end.errors).toEqual([PROPOSE_STOPPED(BRANCH)]);
      expect(end.progress.message).toBe(STOPPED);
      // What a stopped Propose leaves. On the remote and the Git host: nothing.
      expect(remoteBranches(remote)).toEqual(["refs/heads/main"]);
      expect(first.prs).toEqual([]);
      // Here: the commit on the proposal's branch, holding the file; nothing marked proposed;
      // the working tree, the index and the checked-out branch as they were.
      const commit = g(root, "rev-parse", "--verify", `refs/heads/${BRANCH}`).trim();
      expect(g(root, "show", `${BRANCH}:questions/q1.yaml`)).toBe("answer: 1\n");
      expect(g(root, "branch", "--show-current").trim()).toBe("main");
      expect(g(root, "status", "--porcelain").trim()).toBe("?? questions/");
      const plan = await call("GET", "/api/propose?scope=answers");
      expect((plan.body.files as { path: string; proposed?: string }[])[0]).toEqual({
        path: "questions/q1.yaml",
        status: "??",
      });
      // Propose again pushes it: that commit, and the PR is opened from its branch.
      const second = heldHost("createPullRequest");
      host = second.host;
      const again = await propose();
      await second.at;
      // Past the push: Stop is too late, and it finishes.
      expect(ctx.jobs.get(again)).toMatchObject({ stoppable: false });
      expect(ctx.jobs.get(again)!.stopLands).toBeUndefined();
      expect(ctx.jobs.get(again)!.progress.message).toBe("Opening the pull request…");
      expect((await call("POST", `/api/jobs/${again}/cancel`)).status).toBe(200);
      second.go();
      const done = await ctx.jobs.settle(again);
      expect(done.state).toBe("done");
      expect(ctx.jobs.linesOf(again)!.lines).toContain(TOO_LATE);
      expect(g(remote, "rev-parse", `refs/heads/${BRANCH}`).trim()).toBe(commit);
      expect(second.prs).toHaveLength(1);
      expect(second.prs[0]).toMatchObject({ head: BRANCH, base: "main" });
    } finally {
      first.go();
      await s.close();
    }
  }, 120_000);
});

describe("Bring in what merged: its steps and Stop (ADR 0202 point 2)", () => {
  /** A teammate's merge lands on the remote: one commit the copy here hasn't. */
  async function merged() {
    const { root, remote } = await metarepo();
    const other = join(root, "..", "other");
    g(join(root, ".."), "clone", "-q", remote, other);
    await writeFile(join(other, "notes.md"), "merged\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "merged");
    g(other, "push", "-q", "origin", "main");
    return { root };
  }
  /** Git, holding the first call whose arguments start with `hold` until let go. */
  function heldGit(hold: string) {
    const real = createGit();
    let reached!: () => void;
    let go!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (go = r));
    const git: GitRunner = async (args, cwd, o) => {
      if (args[0] === hold) {
        reached();
        await gate;
      }
      return real(args, cwd, o);
    };
    return { git, at, go };
  }

  it("says each step in order, and commits just before the working tree is changed", async () => {
    const { root } = await merged();
    const steps: string[] = [];
    let committedAt = -1;
    const said: string[] = [];
    const code = await withCommit(
      () => (committedAt = steps.length),
      () =>
        bringInMerged(root, {
          out: (l) => said.push(l),
          err: (l) => said.push(l),
          progress: (l) => steps.push(l),
        }),
    );
    expect(code, said.join("\n")).toBe(0);
    expect(steps).toEqual(["Fetching origin/main…", "Bringing in 1 commit…"]);
    expect(committedAt).toBe(1);
    expect(existsSync(join(root, "notes.md"))).toBe(true);
  }, 60_000);

  it("with nothing new it says the line it has today, and no step of bringing in", async () => {
    const { root } = await metarepo();
    const steps: string[] = [];
    const said: string[] = [];
    const code = await bringInMerged(root, {
      out: (l) => said.push(l),
      err: (l) => said.push(l),
      progress: (l) => steps.push(l),
    });
    expect(code).toBe(0);
    expect(steps).toEqual(["Fetching origin/main…"]);
    expect(said[0]).toContain("Nothing new has merged on origin/main yet");
  }, 60_000);

  it("stopped before anything is brought in: the copy is as it was", async () => {
    const { root } = await merged();
    const before = g(root, "rev-parse", "HEAD").trim();
    const stop = new AbortController();
    const h = heldGit("fetch");
    const said: string[] = [];
    const ran = bringInMerged(
      root,
      { out: (l) => said.push(l), err: (l) => said.push(l) },
      { git: h.git, signal: stop.signal },
    );
    await h.at;
    stop.abort();
    h.go();
    expect(await ran).toBe(STOPPED_CODE);
    expect(said).toEqual([BRING_IN_STOPPED]);
    expect(g(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(existsSync(join(root, "notes.md"))).toBe(false);
    expect(g(root, "status", "--porcelain").trim()).toBe("?? questions/");
  }, 60_000);

  it("stopped once the working tree is being changed: it finishes", async () => {
    const { root } = await merged();
    const stop = new AbortController();
    const h = heldGit("merge");
    const said: string[] = [];
    let committed = false;
    const ran = withSignal(stop.signal, () =>
      withCommit(
        () => (committed = true),
        () => bringInMerged(root, { out: (l) => said.push(l), err: (l) => said.push(l) }, h),
      ),
    );
    await h.at;
    expect(committed).toBe(true);
    stop.abort();
    h.go();
    expect(await ran).toBe(0);
    expect(said[0]).toContain("Brought in what merged on origin/main");
    expect(existsSync(join(root, "notes.md"))).toBe(true);
  }, 60_000);
});
