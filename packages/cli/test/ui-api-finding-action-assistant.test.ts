import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Finding } from "@maycombhq/core";
import { readRound, writeGateRound } from "@maycombhq/naysayer";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";

/**
 * The review of b30/review2-fixes (ADR 0115 addendum, 2026-11-22): the app's own finding action,
 * POST /api/findings/{changeId}/{findingId}/action, records the app's Git user. Where the app runs
 * inside a Copilot session Atticus started or a coding assistant's terminal, it refuses (403)
 * what the command line refuses there with --by: a waiver (sessionRefusal, the stage Accept's
 * words), and what would close a blocking or risk finding with no change Atticus can check (not
 * relevant, Apply of a finding with no patch, Edit and apply with no edit it can see). An idea's
 * dismissal goes on, as everything does in a person's own app. Invented Forge names.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-11-22T09:00:00Z";

const planFinding = (id: string, severity: "blocking" | "risk" | "idea") =>
  Finding.parse({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: CHANGE,
    gate: "plan",
    round: 1,
    rule: "ledger.limits-named",
    layer: "org",
    lens: "true",
    severity,
    artifact: "proposal.md",
    locator: { line: 1 },
    summary: `A ${severity} finding.`,
    why: "Words.",
    fix: { text: "Say it." },
    evidence: [{ source: "artifact", path: "proposal.md", line: 1 }],
    waivable: true,
    state: "open",
    createdAt: NOW,
  });

async function seeded(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-finding-action-app-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  await writeGateRound(
    root,
    CHANGE,
    "plan",
    [
      planFinding("f-block", "blocking"),
      planFinding("f-risk", "risk"),
      planFinding("f-idea", "idea"),
    ],
    NOW,
  );
  return root;
}

const servers: RunningServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function serve(root: string, env: Record<string, string>) {
  const s = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => uiRoutes(r, ctx, { env }),
  });
  servers.push(s);
  return async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(`${s.url}/api/findings/${CHANGE}/${id}/action`, {
      method: "POST",
      headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as { detail?: string; state?: string } };
  };
}

const stateOf = async (root: string, id: string) =>
  (await readRound(root, CHANGE, "plan", 1)).findings.find((s) => s.finding.id === id)!.finding
    .state;

const TAIL =
  "The app records its Git user here, and that doesn't make this session a person's. Nothing was written.";

describe("POST /api/findings/{changeId}/{findingId}/action where an assistant works", () => {
  it("refuses Not relevant on a blocking or risk finding in a coding assistant's terminal", async () => {
    const root = await seeded();
    const act = await serve(root, { CLAUDECODE: "1" });
    for (const id of ["f-block", "f-risk"]) {
      const r = await act(id, { action: "not-relevant", reason: "known" });
      expect(r.status).toBe(403);
      expect(r.body.detail).toBe(
        `Decide it in an app or a terminal of your own: this app runs in a coding assistant's terminal (CLAUDECODE is set), and only a person dismisses a blocking or risk finding as not relevant. ${TAIL}`,
      );
      expect(await stateOf(root, id)).toBe("open");
    }
    const apply = await act("f-block", { action: "apply" });
    expect(apply.status).toBe(403);
    expect(apply.body.detail).toBe(
      `Record the fix in an app or a terminal of your own: this app runs in a coding assistant's terminal (CLAUDECODE is set), and f-block has no patch, so marking it applied would close a blocking finding with nothing in the draft changed; only a person does that. ${TAIL}`,
    );
    const idea = await act("f-idea", { action: "not-relevant", reason: "later" });
    expect(idea.status).toBe(200);
    expect(idea.body.state).toBe("dismissed");
  }, 60_000);

  it("refuses a waiver there, in the stage Accept's words, and inside a Copilot session Atticus started", async () => {
    const root = await seeded();
    const act = await serve(root, { CLAUDECODE: "1" });
    const w = await act("f-block", { action: "waive", reason: "known" });
    expect(w.status).toBe(403);
    expect(w.body.detail).toBe(
      "Recorded as claude-code: CLAUDECODE is set. claude-code is an assistant: only a person accepts a finding. The person accepts it in an app or a terminal of their own.",
    );
    const acp = await serve(root, { ATTICUS_ACP_SESSION: "s-1" });
    const n = await acp("f-risk", { action: "not-relevant", reason: "known" });
    expect(n.status).toBe(403);
    expect(n.body.detail).toBe(
      `Decide it in an app or a terminal of your own: this app runs inside a Copilot session that Atticus started, and only a person dismisses a blocking or risk finding as not relevant. ${TAIL}`,
    );
    const aw = await acp("f-block", { action: "waive", reason: "known" });
    expect(aw.status).toBe(403);
    expect(aw.body.detail).toMatch(/^This runs inside a Copilot session that Atticus started/);
    expect(await stateOf(root, "f-block")).toBe("open");
    expect(await stateOf(root, "f-risk")).toBe("open");
  }, 60_000);

  it("goes on in a person's own app", async () => {
    const root = await seeded();
    const act = await serve(root, {});
    const r = await act("f-block", { action: "not-relevant", reason: "known" });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("dismissed");
  }, 60_000);
});
