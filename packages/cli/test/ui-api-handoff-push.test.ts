import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { confirmFor } from "./confirm-helpers.js";

/**
 * App-only audit (API 3.3.0): a hand-off whose branch wasn't pushed keeps it here; the change page
 * says so and offers Push again, which pushes it on the person's confirmation and says git's words
 * when it fails.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE = join(HERE, "../../../fixtures/forge-change/openspec/changes/add-transfer-limit");
const ID = "add-transfer-limit";
const B = `handoff/${ID}/plan`;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

async function setup() {
  const top = await mkdtemp(join(tmpdir(), "atticus-ui-push-"));
  const root = join(top, "meta");
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(CHANGE, join(root, "openspec/changes", ID), { recursive: true });
  const file = join(root, "openspec/changes", ID, "change.yaml");
  const c = parse(await readFile(file, "utf8")) as { handoffs: Record<string, unknown>[] };
  c.handoffs.push({
    phase: "plan",
    state: "open",
    approvals: [],
    artifacts: [],
    branch: B,
    by: "pat",
    openedAt: "2026-11-09T09:00:00Z",
    pr: { number: 3, url: "https://git.example.com/forge/forge-metarepo/pull/3" },
    reviewers: [],
  });
  await writeFile(file, stringify(c));
  const bare = join(top, "meta.git");
  await mkdir(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "origin", "main");
  // The hand-off's commit, kept here when its push failed.
  git(root, "branch", B);
  const hook = join(bare, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho 'refused by the host' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  return { root, bare, hook };
}

describe("Push again (app-only audit)", () => {
  it("says the hand-off's branch isn't pushed, pushes it on the person's confirmation, and says git's words when it can't", async () => {
    const { root, bare, hook } = await setup();
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx),
    });
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${srv.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const d = Api.ChangeDetail.parse(await (await call(`/api/changes/${ID}`)).json());
      expect(d.handoff).toMatchObject({ phase: "plan", unpushed: true, branch: B });
      const path = `/api/changes/${ID}/handoff/push`;
      expect((await call(path, "POST", {})).status).toBe(403);
      const no = await call(path, "POST", { confirmation: await confirmFor(srv, "handoff", ID) });
      expect(no.status).toBe(422);
      expect(JSON.stringify(await no.json())).toContain(`${B} wasn't pushed`);
      await writeFile(hook, "#!/bin/sh\nexit 0\n");
      const yes = await call(path, "POST", { confirmation: await confirmFor(srv, "handoff", ID) });
      expect(yes.status).toBe(200);
      const after = Api.ChangeDetail.parse(await yes.json());
      expect(after.handoff?.unpushed).toBeUndefined();
      expect(after.notes?.[0]).toMatch(new RegExp(`^Pushed ${B} `));
      expect(git(bare, "rev-parse", B)).toBe(git(root, "rev-parse", B));
    } finally {
      await srv.close();
    }
  }, 120_000);
});
