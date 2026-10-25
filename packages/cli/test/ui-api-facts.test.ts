import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseCorrections, parseFacts, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiFactsRoutes } from "../src/ui-api-facts.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * The Map with its evidence (ADR 0124 addendum D-app, F3): GET /api/facts/{repo} gives each
 * fact's line and quote, who made and checked it, the fields a person may correct and the open
 * questions about the repo; POST .../corrections writes a person's correction, which the next
 * `atticus verify` applies. Nothing reaches the network and no git runs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, "../../verify/test/fixtures");
const NOW = new Date("2026-10-24T10:00:00Z");
const PERSON = "Priya Nair <priya@forge.example>";

let srv: RunningServer;
let root: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-facts-"));
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(
    join(root, "facts/forge-ledger.jsonl"),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  await raiseQuestions(
    root,
    [
      QuestionDraft.parse({
        question: "Is the settlement listener switched on in production?",
        evidence: ["src/main/java/forge/ledger/SettlementListener.java:14"],
      }),
    ],
    {
      step: "map",
      repo: "forge-ledger",
      command: "atticus verify forge-ledger",
      rerun: "atticus map forge-ledger",
      at: NOW.toISOString(),
    },
  );
  srv = await startServer({
    root,
    port: 0,
    user: PERSON,
    extend: (r, ctx) => uiFactsRoutes(r, ctx, { now: () => NOW }),
  });
});
afterAll(() => srv?.close());

describe("a repo's facts as the Map cites them", () => {
  it("gives each fact's line, quote, claim and who checked it, a flow's steps, and the open questions", async () => {
    const r = await call("GET", "/api/facts/forge-ledger");
    expect(r.status).toBe(200);
    const v = Api.RepoFactsView.parse(r.body);
    expect(v).toMatchObject({
      repo: "forge-ledger",
      file: "facts/forge-ledger.jsonl",
      present: true,
      commit: "0123abc",
      verify: "atticus verify forge-ledger",
      corrections: { file: "facts/forge-ledger.corrections.jsonl", count: 0, stale: [] },
      problems: [],
    });
    expect(v.facts).toHaveLength(17);
    const get = v.facts.find((f) => f.id === "e-get-account")!;
    expect(get).toMatchObject({
      kind: "entry",
      label: "GET /accounts/{accountId}",
      cite: {
        file: "src/main/java/forge/ledger/AccountController.java",
        line: 18,
        quote: '@GetMapping("/accounts/{accountId}")',
      },
      verified: "line",
      by: "assistant",
    });
    // The fields a person may correct: the fact's own words, never its id, repo or commit.
    expect(get.claim).toMatchObject({
      method: "GET",
      path: "/accounts/{accountId}",
      handler: "AccountController.get",
      value: "/accounts/{accountId}",
    });
    expect(Object.keys(get.claim)).not.toContain("id");
    expect(Object.keys(get.claim)).not.toContain("commit");
    const flow = v.facts.find((f) => f.kind === "flow")!;
    expect(flow.steps!.length).toBeGreaterThan(0);
    expect(flow.steps![0]).toHaveProperty("what");
    expect(v.questions).toEqual([
      expect.objectContaining({
        question: "Is the settlement listener switched on in production?",
        evidence: ["src/main/java/forge/ledger/SettlementListener.java:14"],
      }),
    ]);
  });

  it("says a repo nobody has read has no facts, and refuses a name that isn't a repo's", async () => {
    const r = await call("GET", "/api/facts/forge-gateway");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ present: false, facts: [], file: "facts/forge-gateway.jsonl" });
    expect((await call("GET", "/api/facts/..%2Fsecrets")).status).toBe(400);
  });
});

describe("a person's correction from the Map", () => {
  it("marks a fact wrong only with why, as the signed-in person, and gives the git and verify commands", async () => {
    const none = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "e-settle-listener",
      action: "wrong",
    });
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.body)).toContain("say why the fact is wrong");
    const r = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "e-settle-listener",
      action: "wrong",
      reason: "The listener is switched off; the ledger settles by batch.",
    });
    expect(r.status).toBe(200);
    const res = Api.FactCorrectionResult.parse(r.body);
    expect(res).toMatchObject({
      file: "facts/forge-ledger.corrections.jsonl",
      commit:
        'git add facts/forge-ledger.corrections.jsonl && git commit -m "forge-ledger: a person\'s correction of e-settle-listener"',
      verify: "atticus verify forge-ledger",
      correction: {
        fact: "e-settle-listener",
        action: "wrong",
        by: PERSON,
        at: NOW.toISOString(),
        target: {
          kind: "entry",
          file: "src/main/java/forge/ledger/SettlementListener.java",
          line: 14,
          value: "forge.payments.settled",
        },
      },
    });
    const v = Api.RepoFactsView.parse((await call("GET", "/api/facts/forge-ledger")).body);
    expect(v.corrections.count).toBe(1);
    expect(v.facts.find((f) => f.id === "e-settle-listener")!.correction?.action).toBe("wrong");
  });

  it("corrects a claim, keeping only what changed, and refuses one that makes no fact or changes nothing", async () => {
    const r = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "e-get-account",
      action: "edit",
      set: { handler: "AccountController.read", path: "/accounts/{accountId}" },
    });
    expect(r.status).toBe(200);
    expect((r.body.correction as { set: unknown }).set).toEqual({
      handler: "AccountController.read",
    });
    const bad = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "e-get-account",
      action: "edit",
      set: { entryType: "carrier-pigeon" },
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("entryType");
    const same = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "e-get-account",
      action: "edit",
      set: { path: "/accounts/{accountId}" },
    });
    expect(same.status).toBe(422);
    expect(
      (
        await call("POST", "/api/facts/forge-ledger/corrections", {
          fact: "nope",
          action: "wrong",
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/facts/forge-gateway/corrections", {
          fact: "x",
          action: "wrong",
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("POST", "/api/facts/forge-ledger/corrections", { fact: "x", action: "drop" }))
        .status,
    ).toBe(400);
    const lines = parseCorrections(
      await readFile(join(root, "facts/forge-ledger.corrections.jsonl"), "utf8"),
    );
    expect(lines.bad).toEqual([]);
    expect(lines.corrections.map((c) => [c.fact, c.action])).toEqual([
      ["e-settle-listener", "wrong"],
      ["e-get-account", "edit"],
    ]);
  });

  it("is applied by the next atticus verify: the wrong fact is gone, the corrected one is the person's", async () => {
    const out: string[] = [];
    const code = await verifyCommand(
      root,
      "forge-ledger",
      { dir: join(VERIFY, "repo"), commit: "0123abc" },
      { out: (l) => out.push(l), err: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    // A-big2: listed one a line, the first few, the whole list in verify.yaml.
    expect(out.join("\n")).toContain(
      [
        "2 corrections by a person applied (facts/forge-ledger.corrections.jsonl; listed under corrections in facts/forge-ledger.verify.yaml):",
        "  e-get-account as corrected",
        "  e-settle-listener left out as wrong",
      ].join("\n"),
    );
    const kept = parseFacts(await readFile(join(root, "facts/forge-ledger.jsonl"), "utf8"));
    if (!kept.ok) throw new Error("the kept facts don't parse");
    expect(kept.facts.map((f) => f.id)).not.toContain("e-settle-listener");
    expect(kept.facts.find((f) => f.id === "e-get-account")).toMatchObject({
      handler: "AccountController.read",
      by: "person",
      verified: "person",
    });
    expect(await readFile(join(root, "facts/forge-ledger.verify.yaml"), "utf8")).toContain(
      "action: wrong",
    );
    // The Map now shows the person's fact, with the correction that made it.
    const v = Api.RepoFactsView.parse((await call("GET", "/api/facts/forge-ledger")).body);
    expect(v.facts.find((f) => f.id === "e-get-account")).toMatchObject({
      by: "person",
      verified: "person",
      correction: { action: "edit" },
    });
  });
});
