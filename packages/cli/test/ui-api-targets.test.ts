import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, raiseQuestions, TARGETS_ANOTHER_LABEL, TARGETS_STEP_ID } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";

/**
 * ADR 0162 (F8): the app's "Another repo…" picker and a target answer through the local API, on
 * the invented bank-shaped estate (fixtures/link-estate). No network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const AT = "2026-11-01T12:00:00.000Z";
let root: string;
let srv: RunningServer;
let id: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-targets-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "roles.yaml"),
    "schemaVersion: 2\nteams:\n  - { id: team-ledger-ops, name: Ledger Ops }\n",
  );
  const { raised } = await raiseQuestions(
    root,
    [
      {
        question: "Which repo or system answers GET /limits/{id}, which payments-api calls?",
        options: [
          { label: "forge-accounts", means: "it serves it", changes: "joins it" },
          { label: TARGETS_ANOTHER_LABEL, means: "the picker", changes: "name one" },
        ],
        evidence: ["src/main/java/forge/payments/PaymentsService.java:24"],
        scope: "repo",
      },
    ],
    {
      step: TARGETS_STEP_ID,
      repo: "forge-payments",
      command: "atticus verify forge-payments --write",
      rerun: "atticus verify forge-payments --write",
      at: AT,
    },
  );
  id = raised[0]!.id;
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiQuestionRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("GET /api/questions/{id}/targets and a target answer (ADR 0162)", () => {
  it("lists the whole estate's repos, systems and teams", async () => {
    const r = await call("GET", `/api/questions/${id}/targets`);
    expect(r.status).toBe(200);
    const picks = Api.TargetPickList.parse(r.body).picks;
    expect(picks.filter((x) => x.kind === "repo")).toHaveLength(10);
    expect(picks.find((x) => x.id === "team-ledger-ops")?.adds?.owner).toBe("team-ledger-ops");
    expect((await call("GET", "/api/questions/q-000000000000/targets")).status).toBe(404);
  });

  it("writes nothing into the profile when the answer is refused (review item 14)", async () => {
    const file = join(root, "org-pack", "profiles", "forge", "profile.yaml");
    const before = await readFile(file, "utf8");
    const r = await call("POST", `/api/questions/${id}/answer`, {
      target: "Tidewater",
      addSystem: "vendor",
      scope: "repo-type",
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("Say which repo type");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses a team with no system until addSystem says to add it, then writes it for review", async () => {
    const no = await call("POST", `/api/questions/${id}/answer`, { target: "team-ledger-ops" });
    expect(no.status).toBe(400);
    expect(JSON.stringify(no.body)).toContain("has no system in the profile yet");
    const yes = await call("POST", `/api/questions/${id}/answer`, {
      target: "team-ledger-ops",
      addSystem: "internal",
    });
    expect(yes.status).toBe(200);
    const body = Api.AnsweredQuestion.parse(yes.body);
    expect(body.question.answer?.text).toBe("team-ledger-ops-system");
    expect(body.system).toMatchObject({ id: "team-ledger-ops-system", added: true });
    const profile = parse(
      await readFile(join(root, "org-pack", "profiles", "forge", "profile.yaml"), "utf8"),
    ) as { systems: { id: string; owner?: string }[] };
    expect(profile.systems.find((s) => s.id === "team-ledger-ops-system")?.owner).toBe(
      "team-ledger-ops",
    );
  });

  it("refuses an answer's words as a new system, and takes Ignore with a reason (beta.24 review)", async () => {
    const file = join(root, "org-pack", "profiles", "forge", "profile.yaml");
    const before = await readFile(file, "utf8");
    for (const body of [
      { target: "ignore this, its cicd related", addSystem: "vendor" },
      { text: "this is a proxy to send outbound webhook to merchants" },
    ]) {
      const r = await call("POST", `/api/questions/${id}/answer`, body);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain("names no repo, component or system");
    }
    expect(await readFile(file, "utf8")).toBe(before);
    const mixed = await call("POST", `/api/questions/${id}/answer`, { ignore: true, option: 1 });
    expect(mixed.status).toBe(400);
    const r = await call("POST", `/api/questions/${id}/answer`, {
      ignore: true,
      reason: "its cicd related",
    });
    expect(r.status).toBe(200);
    expect(Api.AnsweredQuestion.parse(r.body).question.answer?.text).toBe(
      "Ignore: its cicd related",
    );
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
