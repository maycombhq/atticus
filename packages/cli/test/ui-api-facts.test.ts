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

describe("the reader's slips of form, fixed as the Map reads the facts (R6)", () => {
  it("shows a camelCase id slugged and a flow with no cite on its entry's line, each said as a note", async () => {
    const slipped = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const x = JSON.parse(l.replaceAll('"e-post-entry"', '"ePostEntry"')) as Record<
          string,
          unknown
        >;
        if (x.kind === "flow") delete x.cite;
        return JSON.stringify(x);
      })
      .join("\n");
    await writeFile(join(root, "facts/forge-slips.jsonl"), slipped + "\n");
    const r = await call("GET", "/api/facts/forge-slips");
    expect(r.status).toBe(200);
    const v = Api.RepoFactsView.parse(r.body);
    expect(v.facts).toHaveLength(17);
    expect(v.facts.map((f) => f.id)).toContain("e-post-entry");
    expect(v.facts.map((f) => f.id)).not.toContain("ePostEntry");
    const flow = v.facts.find((f) => f.kind === "flow")!;
    const entry = v.facts.find((f) => f.id === "e-post-entry")!;
    expect(flow.cite).toEqual(entry.cite);
    const notes = v.problems.map((p) => p.message);
    expect(v.problems.every((p) => p.file === "facts/forge-slips.jsonl")).toBe(true);
    expect(notes).toContain(
      "slip of form fixed as read (a note; atticus verify forge-slips writes the fix into the facts file): line 2: fact id ePostEntry slugged to e-post-entry, and every reference to it",
    );
    expect(notes.some((m) => /line 17: flow w-post-entry had no cite/.test(m))).toBe(true);
    expect(notes.some((m) => /isn't a fact/.test(m))).toBe(false);
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
        'git add facts/forge-ledger.corrections.jsonl\ngit commit -m "forge-ledger: a person\'s correction of e-settle-listener"',
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

  it("sets where a call goes (This link is wrong, ADR 0135): kept as the person's by the next verify", async () => {
    const r = await call("POST", "/api/facts/forge-ledger/corrections", {
      fact: "c-fx-rate",
      action: "edit",
      set: { to: "Northwind Pay" },
      reason: "the rates come from the vendor",
    });
    expect(r.status).toBe(200);
    expect(r.body.correction).toMatchObject({ action: "edit", set: { to: "Northwind Pay" } });
    const code = await verifyCommand(
      root,
      "forge-ledger",
      { dir: join(VERIFY, "repo"), commit: "0123abc" },
      { out: () => undefined, err: () => undefined },
    );
    expect(code).toBe(0);
    const kept = parseFacts(await readFile(join(root, "facts/forge-ledger.jsonl"), "utf8"));
    if (!kept.ok) throw new Error("the kept facts don't parse");
    expect(kept.facts.find((f) => f.id === "c-fx-rate")).toMatchObject({
      to: "Northwind Pay",
      by: "person",
    });
  });

  it("says why a correction verify can't apply, so it doesn't wait as pending for good", async () => {
    const file = join(root, "facts/forge-ledger.corrections.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    const bad = { ...last, set: { sync: "sometimes" }, at: "2026-10-25T10:00:00.000Z" };
    await writeFile(file, [...lines, JSON.stringify(bad)].join("\n") + "\n");
    const v = (await call("GET", "/api/facts/forge-ledger")).body as {
      problems: { file: string; message: string }[];
    };
    expect(v.problems).toContainEqual({
      file: "facts/forge-ledger.corrections.jsonl",
      message: expect.stringContaining("doesn't make a fact"),
    });
  });
});

/**
 * This whole arrow is wrong (beta.24): one confirmation corrects every call on an arrow, in one
 * write of each caller repo's corrections file, whichever repos the calls come from.
 */
describe("every call on an arrow at once", () => {
  beforeAll(async () => {
    await writeFile(
      join(root, "facts/forge-teller.jsonl"),
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
    );
  });
  const lines = async (repo: string) =>
    (await readFile(join(root, `facts/${repo}.corrections.jsonl`), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);

  it("writes one line per call, each repo's in one write, and gives every file's commands", async () => {
    const ledgerBefore = (await lines("forge-ledger")).length;
    const r = await call("POST", "/api/links/corrections", {
      items: [
        { repo: "forge-ledger", fact: "c-notify", action: "edit", set: { to: "forge-mailer" } },
        { repo: "forge-ledger", fact: "c-fx-rate", action: "edit", set: { to: "forge-mailer" } },
        { repo: "forge-teller", fact: "c-notify", action: "edit", set: { to: "forge-mailer" } },
      ],
      reason: "They all go to the mailer",
    });
    expect(r.status).toBe(200);
    const res = Api.LinkCorrectionsResult.parse(r.body);
    expect(res.files.map((f) => [f.repo, f.file, f.lines.length])).toEqual([
      ["forge-ledger", "facts/forge-ledger.corrections.jsonl", 2],
      ["forge-teller", "facts/forge-teller.corrections.jsonl", 1],
    ]);
    expect(res.commit).toBe(
      'git add facts/forge-ledger.corrections.jsonl facts/forge-teller.corrections.jsonl\ngit commit -m "A person\'s correction of 3 calls on one link"',
    );
    expect(res.verify).toEqual(["atticus verify forge-ledger", "atticus verify forge-teller"]);
    const ledger = (await lines("forge-ledger")).slice(ledgerBefore).map((l) => JSON.parse(l));
    expect(ledger.map((c) => [c.fact, c.action, c.set, c.reason, c.by])).toEqual([
      ["c-notify", "edit", { to: "forge-mailer" }, "They all go to the mailer", PERSON],
      ["c-fx-rate", "edit", { to: "forge-mailer" }, "They all go to the mailer", PERSON],
    ]);
    expect((await lines("forge-teller")).map((l) => JSON.parse(l).fact)).toEqual(["c-notify"]);
  });

  it("marks them all no call, with why", async () => {
    const r = await call("POST", "/api/links/corrections", {
      items: [{ repo: "forge-teller", fact: "c-fx-rate", action: "wrong" }],
      reason: "A health probe, not a call",
    });
    expect(r.status).toBe(200);
    expect(JSON.parse((await lines("forge-teller")).at(-1)!)).toMatchObject({
      fact: "c-fx-rate",
      action: "wrong",
      reason: "A health probe, not a call",
    });
  });

  it("writes nothing when any one of them can't be recorded", async () => {
    const before = (await lines("forge-ledger")).length;
    const missing = await call("POST", "/api/links/corrections", {
      items: [
        { repo: "forge-ledger", fact: "c-notify", action: "edit", set: { to: "forge-audit" } },
        { repo: "forge-ledger", fact: "nope", action: "edit", set: { to: "forge-audit" } },
      ],
    });
    expect(missing.status).toBe(404);
    const noWhy = await call("POST", "/api/links/corrections", {
      items: [{ repo: "forge-ledger", fact: "c-notify", action: "wrong" }],
    });
    expect(noWhy.status).toBe(422);
    expect((await call("POST", "/api/links/corrections", { items: [] })).status).toBe(400);
    expect(
      (
        await call("POST", "/api/links/corrections", {
          items: [{ repo: "../secrets", fact: "c-notify", action: "wrong", reason: "x" }],
        })
      ).status,
    ).toBe(400);
    expect((await lines("forge-ledger")).length).toBe(before);
  });
});

/**
 * Review of beta.24: the arrow's corrections are written all or none, and asked again they write
 * nothing twice. Every involved file is held for the whole batch; each is written whole and
 * renamed into place; a failure puts back what was written, or says exactly which repos were.
 */
describe("every call on an arrow, all or none", () => {
  let r2: string;
  let s2: RunningServer;
  let failOn: (file: string, n: number) => boolean = () => false;
  let writes = 0;
  const call2 = async (body: unknown) => {
    const r = await fetch(s2.url + "/api/links/corrections", {
      method: "POST",
      headers: { "X-Atticus-Token": s2.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const text = (repo: string) =>
    readFile(join(r2, `facts/${repo}.corrections.jsonl`), "utf8").catch(() => undefined);
  const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8");
  beforeAll(async () => {
    r2 = await mkdtemp(join(tmpdir(), "atticus-ui-arrow-"));
    await mkdir(join(r2, "facts"), { recursive: true });
    for (const repo of ["forge-ledger", "forge-teller"])
      await writeFile(join(r2, `facts/${repo}.jsonl`), facts);
    const { writeFileAtomic } = await import("@maycombhq/core");
    s2 = await startServer({
      root: r2,
      port: 0,
      user: PERSON,
      extend: (r, ctx) =>
        uiFactsRoutes(r, ctx, {
          now: () => NOW,
          write: async (file, data) => {
            writes++;
            if (failOn(file, writes)) throw new Error(`disk full writing ${file}`);
            await writeFileAtomic(file, data);
          },
        }),
    });
  });
  afterAll(() => s2?.close());
  const items = [
    { repo: "forge-ledger", fact: "c-notify", action: "edit", set: { to: "forge-mailer" } },
    { repo: "forge-teller", fact: "c-notify", action: "edit", set: { to: "forge-mailer" } },
  ];

  it("puts back what it wrote when a later repo's write fails, and says so", async () => {
    await writeFile(join(r2, "facts/forge-ledger.corrections.jsonl"), "");
    const before = await text("forge-ledger");
    failOn = (f) => f.endsWith("forge-teller.corrections.jsonl");
    const r = await call2({ items, reason: "The mailer" });
    failOn = () => false;
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ written: [] });
    expect(String(r.body.detail)).toContain("forge-teller");
    expect(await text("forge-ledger")).toBe(before);
    expect(await text("forge-teller")).toBeUndefined();
  });

  it("writes none when a repo's corrections file can't be read", async () => {
    await writeFile(join(r2, "facts/forge-ledger.corrections.jsonl"), "");
    // A folder stands where forge-teller's corrections file goes.
    await mkdir(join(r2, "facts/forge-teller.corrections.jsonl"));
    const r = await call2({ items, reason: "The mailer" });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ written: [] });
    expect(String(r.body.detail)).toContain("facts/forge-teller.corrections.jsonl");
    expect(await text("forge-ledger")).toBe("");
    const { rm } = await import("node:fs/promises");
    await rm(join(r2, "facts/forge-teller.corrections.jsonl"), { recursive: true });
  });

  it("names exactly the repos written when what it wrote can't be put back", async () => {
    await writeFile(join(r2, "facts/forge-ledger.corrections.jsonl"), "");
    writes = 0;
    // The first write (forge-ledger's) goes; forge-teller's fails; putting forge-ledger back fails.
    failOn = (_f, n) => n >= 2;
    const r = await call2({ items, reason: "The mailer" });
    failOn = () => false;
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({
      written: [{ repo: "forge-ledger", file: "facts/forge-ledger.corrections.jsonl" }],
    });
    expect(String(r.body.detail)).toContain("forge-ledger");
    expect((await text("forge-ledger"))!.trim().split("\n")).toHaveLength(1);
  });

  it("writes nothing twice: asked again, a correction already on file is skipped", async () => {
    await writeFile(join(r2, "facts/forge-ledger.corrections.jsonl"), "");
    await writeFile(join(r2, "facts/forge-teller.corrections.jsonl"), "");
    const first = await call2({ items: [...items, items[0]], reason: "The mailer" });
    expect(first.status).toBe(200);
    expect((await text("forge-ledger"))!.trim().split("\n")).toHaveLength(1);
    const again = await call2({ items, reason: "The mailer" });
    expect(again.status).toBe(200);
    const res = Api.LinkCorrectionsResult.parse(again.body);
    expect(res.files).toEqual([]);
    expect(res.skipped).toEqual([
      { repo: "forge-ledger", fact: "c-notify" },
      { repo: "forge-teller", fact: "c-notify" },
    ]);
    expect((await text("forge-ledger"))!.trim().split("\n")).toHaveLength(1);
    expect((await text("forge-teller"))!.trim().split("\n")).toHaveLength(1);
    // Something else said of the same call is written: the newest line is what counts.
    const other = await call2({ items: [items[0]], reason: "The mailer, really" });
    expect(Api.LinkCorrectionsResult.parse(other.body).files).toHaveLength(1);
    expect((await text("forge-ledger"))!.trim().split("\n")).toHaveLength(2);
  });
});
