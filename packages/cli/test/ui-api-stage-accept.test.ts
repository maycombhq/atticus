import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { Api, Finding } from "@maycombhq/core";
import { writeGateRound } from "@maycombhq/naysayer";
import { issueFingerprint, stageFinding, type LoopFinding } from "@maycombhq/planner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { findingAction } from "../src/critic-commands.js";
import { uiThreadRoutes } from "../src/ui-api-thread.js";

/**
 * ADR 0203 A, the app's half: the stage's thread shows the stage's own blocking findings (the
 * built-in gate `stage-<stage>`), each acceptable one with Accept, each other one with why it
 * can't be accepted, and an accepted one with who and why. POST .../stages/{stage}/accept writes
 * through the command line's own `atticus finding <change> <id> waive` (findingAction), so the
 * file it writes is byte for byte the command line's, and it refuses what the command line
 * refuses: a constitution rule, an assistant, a rule not on the list. On the Forge metarepo
 * (invented names, CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const NOW = new Date("2026-11-22T10:00:00Z");
const AT = "2026-11-22T10:00:00Z";
const GATE = "stage-feature";

const loopFinding = (rule: string, target: string, message: string): LoopFinding => ({
  fingerprint: issueFingerprint(rule, target),
  rule,
  target,
  message,
  blocking: true,
  source: "stage",
  seenIn: [1],
});

/** The feature stage's draft: a repo nobody knows, an archived one, a flow nobody knows. */
const UNKNOWN_REPO = loopFinding(
  "feature.unknown-repo",
  "Check the daily transfer limit:forge-limits",
  'New flow "Check the daily transfer limit" is put in repo forge-limits, which the estate doesn\'t have.',
);
const ARCHIVED = loopFinding(
  "feature.archived-repo",
  "Keep the old limits:forge-legacy-limits",
  'New flow "Keep the old limits" is put in repo forge-legacy-limits, which the manifest marks archived.',
);
const UNKNOWN_FLOW = loopFinding(
  "feature.unknown-flow",
  "forge-ledger.set-limit",
  "Flow forge-ledger.set-limit isn't in the catalog.",
);
const ids = {
  repo: `stage-${UNKNOWN_REPO.fingerprint}`,
  archived: `stage-${ARCHIVED.fingerprint}`,
  flow: `stage-${UNKNOWN_FLOW.fingerprint}`,
  constitution: "stage-c0ffee000001",
};
const file = (id: string) => `${REL}/review/${GATE}/1/${id}.yaml`;

/** A metarepo whose feature stage stopped with these four on its gate. */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-ui-accept-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  const o = {
    change: CHANGE,
    stage: "feature" as const,
    source: "feature.yaml",
    rerun: `atticus change feature ${CHANGE}`,
    now: "2026-11-22T09:00:00Z",
  };
  const projected = await Promise.all(
    [UNKNOWN_REPO, ARCHIVED, UNKNOWN_FLOW].map((f) => stageFinding(f, o)),
  );
  // A constitution rule on the stage's gate (a file written by hand or by another Atticus): rule
  // 6 says it is never accepted (C3 already holds it never waivable).
  const constitution = Finding.parse({
    ...projected[0]!,
    id: ids.constitution,
    rule: "constitution.no-secrets-in-artifacts",
    layer: "constitution",
    summary: "feature.yaml names a secret's value.",
    why: "feature.yaml names a secret's value.",
    fix: { text: "Fix feature.yaml and run atticus change feature add-transfer-limit again." },
    locator: { heading: "feature" },
    waivable: false,
  });
  await writeGateRound(root, CHANGE, GATE, [...projected, constitution], o.now, {
    carryById: true,
  });
  await mkdir(join(root, REL, "stage"), { recursive: true });
  await writeFile(
    join(root, REL, "stage/feature.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      stage: "feature",
      iteration: 1,
      state: "stopped",
      updatedAt: "2026-11-22T09:00:00Z",
      findings: [UNKNOWN_REPO, ARCHIVED, UNKNOWN_FLOW].map((f) => ({ ...f, kind: "decision" })),
    }),
  );
  return root;
}

const servers: RunningServer[] = [];
async function serve(root: string, user: string, env: Record<string, string> = {}) {
  const s = await startServer({
    root,
    port: 0,
    user,
    watch: false,
    extend: (r, ctx) => uiThreadRoutes(r, ctx, { now: () => NOW, env }),
  });
  servers.push(s);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(s.url + path, {
      method,
      headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const thread = async () =>
    Api.StageThreadView.parse(
      (await call("GET", `/api/changes/${CHANGE}/stages/feature/thread`)).body,
    );
  const accept = (finding: string, reason: string) =>
    call("POST", `/api/changes/${CHANGE}/stages/feature/accept`, { finding, reason });
  return { call, thread, accept };
}
afterAll(async () => {
  for (const s of servers) await s.close();
});

/** The command line's own `atticus finding <change> <id> waive --reason <why> --by <who>`. */
async function cli(root: string, id: string, by: string, reason: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await findingAction(
    root,
    CHANGE,
    id,
    "waive",
    { by, reason },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { now: AT },
  );
  return { code, out, err };
}

const findingOf = (v: Api.StageThreadViewT, id: string) =>
  v.items.find(
    (i): i is Extract<Api.ThreadItemT, { kind: "finding" }> =>
      i.kind === "finding" && i.view.finding.id === id,
  );

const REASON = "forge-limits is created in this release";

describe("the stage's thread shows the stage's own findings", () => {
  let api: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    api = await serve(await metarepo(), "priya");
  });

  it("each with Accept, or why it can't be accepted, in the app's words", async () => {
    const v = await api.thread();
    const repo = findingOf(v, ids.repo)!;
    expect(repo.view.finding.gate).toBe(GATE);
    expect(repo.view.accept).toEqual({ can: true, as: "priya" });
    expect(repo.view.accepted).toBeUndefined();
    // The fix in words, without the command line's own way to accept it.
    expect(repo.view.options.fix).toBe(
      `Fix feature.yaml and run atticus change feature ${CHANGE} again.`,
    );
    // Not relevant would be raised again by the stage's next run: only a fix or an acceptance.
    expect(repo.view.options.dismiss).toBe(false);
    expect(repo.assistantWrites).toBe(true);
    expect(findingOf(v, ids.archived)!.view.accept).toEqual({
      can: false,
      why: "archived-repo",
      as: "priya",
    });
    expect(findingOf(v, ids.flow)!.view.accept).toEqual({
      can: false,
      why: "needs-catalog",
      as: "priya",
    });
    expect(findingOf(v, ids.constitution)!.view.accept).toEqual({
      can: false,
      why: "constitution",
      as: "priya",
    });
  });
});

describe("POST .../stages/{stage}/accept", () => {
  it("writes exactly what atticus finding … waive writes, and the thread shows it accepted, by whom and why", async () => {
    const app = await metarepo();
    const term = await metarepo();
    const api = await serve(app, "priya");
    const r = await api.accept(ids.repo, `  ${REASON}  `);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = Api.StageAcceptResult.parse(r.body);
    expect(res.files).toEqual([file(ids.repo)]);
    expect(res.accepted).toEqual({ by: "priya", why: REASON, at: AT });
    const c = await cli(term, ids.repo, "priya", REASON);
    expect(c.code, c.err.join("\n")).toBe(0);
    const bytes = (root: string) => readFile(join(root, file(ids.repo)), "utf8");
    expect(await bytes(app)).toBe(await bytes(term));
    expect(await bytes(app)).toContain("state: waived");

    const seen = findingOf(res.thread, ids.repo)!;
    expect(seen.view.accepted).toEqual({ by: "priya", why: REASON, at: AT });
    expect(seen.view.accept).toBeUndefined();
    expect(findingOf(await api.thread(), ids.repo)!.view.accepted?.by).toBe("priya");
    // Accepted once: a second time is refused, and nothing is written again.
    const again = await api.accept(ids.repo, "Again");
    expect(again.status).toBe(409);
    expect(String(again.body.detail)).toContain("already accepted by priya");
    expect(await bytes(app)).toBe(await bytes(term));
  });

  it.each([
    ["a constitution rule", "constitution", /constitution rule .*can never be waived or accepted/],
    ["a rule not on the list", "flow", /can't be accepted/],
    ["an archived repo", "archived", /can't be accepted/],
  ] as const)("refuses %s as the command line does, and writes nothing", async (_, key, words) => {
    const app = await metarepo();
    const term = await metarepo();
    const id = ids[key];
    const before = await readFile(join(app, file(id)), "utf8");
    const r = await (await serve(app, "priya")).accept(id, REASON);
    expect(r.status).toBe(403);
    const c = await cli(term, id, "priya", REASON);
    expect(c.code).toBe(1);
    expect(String(r.body.detail)).toMatch(words);
    // The same words as the command line's.
    expect(String(r.body.detail)).toBe(c.err.join("\n"));
    expect(await readFile(join(app, file(id)), "utf8")).toBe(before);
    expect(await readFile(join(term, file(id)), "utf8")).toBe(before);
  });

  it("refuses an assistant as the command line does: no Accept, and a 403 that writes nothing", async () => {
    const app = await metarepo();
    const term = await metarepo();
    const before = await readFile(join(app, file(ids.repo)), "utf8");
    const api = await serve(app, "claude-code");
    expect(findingOf(await api.thread(), ids.repo)!.view.accept).toEqual({
      can: false,
      why: "assistant",
      as: "claude-code",
    });
    const r = await api.accept(ids.repo, REASON);
    expect(r.status).toBe(403);
    expect(String(r.body.detail)).toMatch(/claude-code is an assistant: only a person/);
    const c = await cli(term, ids.repo, "claude-code", REASON);
    expect(c.code).toBe(1);
    expect(c.err.join("\n")).toMatch(/claude-code is an assistant: only a person waives/);
    expect(await readFile(join(app, file(ids.repo)), "utf8")).toBe(before);
    expect(await readFile(join(term, file(ids.repo)), "utf8")).toBe(before);
  });

  it("refuses inside a Copilot session Atticus started, as the command line refuses a person's act there", async () => {
    const app = await metarepo();
    const before = await readFile(join(app, file(ids.repo)), "utf8");
    const api = await serve(app, "priya", { ATTICUS_ACP_SESSION: "1" });
    expect(findingOf(await api.thread(), ids.repo)!.view.accept).toEqual({
      can: false,
      why: "assistant-session",
      as: "priya",
    });
    const r = await api.accept(ids.repo, REASON);
    expect(r.status).toBe(403);
    expect(String(r.body.detail)).toMatch(/Copilot session that Atticus started/);
    expect(await readFile(join(app, file(ids.repo)), "utf8")).toBe(before);
  });

  it("needs a reason, a finding of the stage's own gate, and a stage that has one", async () => {
    const app = await metarepo();
    const before = await readFile(join(app, file(ids.repo)), "utf8");
    const api = await serve(app, "priya");
    for (const reason of ["", "   "]) {
      const r = await api.accept(ids.repo, reason);
      expect(r.status).toBe(400);
    }
    const missing = await api.accept("stage-0123456789ab", REASON);
    expect(missing.status).toBe(404);
    // A critic finding's id isn't the stage's: Accept is for the stage's own findings.
    const critic = await api.accept("f-0000000a", REASON);
    expect(critic.status).toBe(400);
    const proposal = await api.call("POST", `/api/changes/${CHANGE}/stages/proposal/accept`, {
      finding: ids.repo,
      reason: REASON,
    });
    expect(proposal.status).toBe(400);
    expect(await readFile(join(app, file(ids.repo)), "utf8")).toBe(before);
  });
});
