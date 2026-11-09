import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockGitHost } from "@maycombhq/adapters";
import { CONFIRM_TTL_MS, startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { confirmFor } from "./confirm-helpers.js";

/**
 * Review round 48 (ADR 0186): the session token that `atticus ui --show-token` prints for
 * assistants and scripts is not a person's yes. Every write to a shared system the app makes
 * needs the person's confirmation, which only the app's page can ask for; with the token alone
 * each is 403 and nothing reaches the Git host.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE_FIXTURES = join(HERE, "../../changes/test/fixtures/add-transfer-limit");
const REPO = "forge/forge-metarepo";
const ID = "add-transfer-limit";

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-confirm-"));
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
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "*  @forge/platform\n");
  return root;
}

let root: string;
let srv: RunningServer;
const gh = new MockGitHost([{ repo: REPO }]);

async function call(path: string, method: string, body?: unknown) {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** What reached the Git host that writes: pushes, PRs, merges. */
const writes = () => gh.journal.filter((j) => !/^(get|list)/.test(j.method)).map((j) => j.method);

beforeAll(async () => {
  root = await forgeRoot();
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => extendUiRoutes(r, ctx, { gitHost: gh, now: "2026-10-19T09:00:00Z" }),
  });
  const made = await call("/api/changes", "POST", {
    id: ID,
    title: "Add transfer limit",
    type: "feature",
    owners: { "product-owner": ["pat"], architect: ["ari"], developer: ["dev"] },
    systems: ["ledger", "portal"],
  });
  expect(made.status).toBe(201);
  // Ready for its define hand-off, and with a task.
  await cp(join(CHANGE_FIXTURES, "define"), join(root, "openspec/changes", ID), {
    recursive: true,
  });
  await writeFile(
    join(root, "openspec/changes", ID, "tasks.md"),
    "# Tasks\n\n## forge-ledger\n\n- [ ] 1.2 Enforce the limit (story s2)\n",
  );
});
afterAll(() => srv?.close());

describe("a write to a shared system needs the person's confirmation, not the session token", () => {
  const refusals: [string, string, string, unknown][] = [
    ["handoff", "POST", `/api/changes/${ID}/handoff`, { repo: REPO }],
    ["release-prs", "POST", `/api/changes/${ID}/release-prs`, {}],
    ["task-pr", "POST", `/api/changes/${ID}/tasks/1.2/pr`, {}],
    ["digest-send", "POST", "/api/me/digest", { send: true }],
    ["propose", "POST", "/api/propose", { scope: "answers", files: ["questions/q1.yaml"] }],
    [
      "step-run",
      "POST",
      "/api/todo/open-pr-handoff-add-transfer-limit-plan/run",
      { with: "tool", inputsSha256: "a".repeat(64) },
    ],
  ];
  it.each(refusals)("%s with the token alone is 403, and says what to do", async (w, m, p, b) => {
    const r = await call(p, m, b);
    expect(r.status).toBe(403);
    const problem = Api.Problem.parse(r.body);
    expect(problem.detail).toMatch(/Atticus app/);
    expect(problem.detail).toMatch(/ADR 0186/);
    expect(r.body.confirm).toBe(w);
    // A confirmation made up, or one for something else, is refused the same way.
    const forged = await call(p, m, { ...(b as object), confirmation: "f".repeat(43) });
    expect(forged.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("a sync without one only reads; a confirmation that isn't valid is 403", async () => {
    const read = await call(`/api/changes/${ID}/sync`, "POST", { repo: REPO });
    expect(read.status).not.toBe(403);
    expect(writes()).toEqual([]);
    const forged = await call(`/api/changes/${ID}/sync`, "POST", {
      repo: REPO,
      confirmation: "f".repeat(43),
    });
    expect(forged.status).toBe(403);
  });

  it("the page's confirmation is taken once, for its own change, and not after two minutes", async () => {
    // Another change's confirmation: refused.
    const other = await confirmFor(srv, "handoff", "another-change");
    expect(
      (await call(`/api/changes/${ID}/handoff`, "POST", { repo: REPO, confirmation: other }))
        .status,
    ).toBe(403);
    // Another write's: refused.
    const merge = await confirmFor(srv, "merge", ID);
    expect(
      (await call(`/api/changes/${ID}/handoff`, "POST", { repo: REPO, confirmation: merge }))
        .status,
    ).toBe(403);
    // Expired.
    const late = await confirmFor(srv, "handoff", ID);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + CONFIRM_TTL_MS + 1000);
    try {
      expect(
        (await call(`/api/changes/${ID}/handoff`, "POST", { repo: REPO, confirmation: late }))
          .status,
      ).toBe(403);
    } finally {
      clock.mockRestore();
    }
    expect(writes()).toEqual([]);
    // The person's click: accepted, once.
    const yes = await confirmFor(srv, "handoff", ID);
    const ok = await call(`/api/changes/${ID}/handoff`, "POST", { repo: REPO, confirmation: yes });
    expect(ok.status).toBe(201);
    expect(writes()).toContain("createPullRequest");
    const replay = await call(`/api/changes/${ID}/handoff`, "POST", {
      repo: REPO,
      confirmation: yes,
    });
    expect(replay.status).toBe(403);
  });

  it("Sync merges a ready PR only with the person's confirmation", async () => {
    const pr = (await gh.listPullRequests(REPO, {}))[0]!;
    gh.review(REPO, pr.number, "tia", "approved");
    const read = await call(`/api/changes/${ID}/sync`, "POST", { repo: REPO });
    expect(read.status).toBe(200);
    expect(writes()).not.toContain("mergePullRequest");
    expect((await gh.getPullRequest(REPO, pr.number)).state).toBe("open");
    const yes = await confirmFor(srv, "merge", ID);
    const merged = await call(`/api/changes/${ID}/sync`, "POST", { repo: REPO, confirmation: yes });
    expect(merged.status).toBe(200);
    expect((await gh.getPullRequest(REPO, pr.number)).state).toBe("merged");
  });
});
