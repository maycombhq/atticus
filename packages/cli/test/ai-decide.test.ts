import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Api,
  isAiBy,
  pairsFromCorrections,
  parseCorrections,
  parseFacts,
  Question,
  readBatch,
  readQuestion,
  writeQuestion,
} from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import {
  aiAuditCandidates,
  correctDecision,
  decideAnswers,
  decideLinks,
  decisionsView,
  undoBatch,
} from "../src/ai-decide.js";
import { candidatesOf } from "../src/ui-api-links.js";
import { uiDecisionRoutes } from "../src/ui-api-decisions.js";

/**
 * ADR 0181: AI decides first, people correct, and a correction spreads. On the invented Forge
 * estate of fixtures/prototype-compare: forge-billing has loose calls to the partner gateway
 * (`/charges/{id}/capture`, `/charges/{id}/refunds`, `/charges`, and `captureChargePath`, a
 * field's name); Copilot's answers are mocked, nothing leaves the machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
const GW = "forge-partner-gateway";
const CAPTURE = "entry.post.partners-northwind-charges-chargeid-capture";
const REFUNDS = "entry.post.partners-northwind-charges-chargeid-refunds";
const CHARGES = "entry.post.partners-northwind-charges";
const FILE = "src/main/java/forge/billing/PartnerClient.java";
const AT = new Date("2026-11-08T10:15:00.000Z");

const call = (id: string, path: string, line: number) =>
  JSON.stringify({
    kind: "call",
    id,
    repo: "forge-billing",
    commit: "aaa1111",
    callType: "rest",
    method: "POST",
    path,
    cite: { file: FILE, line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

/** The client's source, so a citation names lines that are there. */
const SOURCE = Array.from({ length: 45 }, (_, i) => {
  const n = i + 1;
  if (n === 31) return "    post(captureChargePath, body); // PartnerRoutes.CAPTURE";
  if (n === 40) return '    post("/charges/" + id + "/capture", body);';
  if (n === 41) return '    post("/charges/" + id + "/refunds", body);';
  if (n === 42) return '    post("/charges", body);';
  return n === 1 ? "package forge.billing;" : `    // line ${n}`;
}).join("\n");

const RUNTIME = (decide: string) =>
  [
    "schemaVersion: 4",
    "assistants: { allowed: [copilot], default: copilot }",
    "modes: { allowed: [hand-off, copilot-acp], default: hand-off }",
    decide,
    "",
  ].join("\n");

let root: string;

async function aiLine(fact: string, line: number, value: string, run: string) {
  return JSON.stringify({
    schemaVersion: 2,
    fact,
    target: { kind: "call", file: FILE, line, value },
    action: "link",
    link: {
      repo: "forge-shop-bff",
      entry: "entry.post.checkout",
      method: "POST",
      path: "/checkout",
    },
    by: "atticus",
    at: "2026-11-08T09:00:00.000Z",
    ai: { runtime: "copilot-acp", run },
    batch: "b-20261108-090000-aaaaaa",
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-decide-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    RUNTIME("decide: { links: auto, questions: auto }"),
  );
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  await appendFile(
    join(root, "facts/forge-billing.jsonl"),
    [
      call("call.post.capture-charge", "captureChargePath", 31),
      call("call.post.charges-capture", "/charges/{id}/capture", 40),
      call("call.post.charges-refunds", "/charges/{id}/refunds", 41),
      call("call.post.charges", "/charges", 42),
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "workspace/forge-billing", dirname(FILE)), { recursive: true });
  await writeFile(join(root, "workspace/forge-billing", FILE), SOURCE);
});

const corrections = async () =>
  parseCorrections(
    await readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8").catch(() => ""),
  ).corrections;
const billingFacts = async () => {
  const r = parseFacts(await readFile(join(root, "facts/forge-billing.jsonl"), "utf8"));
  if (!r.ok) throw new Error("facts don't read");
  return r.facts;
};

describe("the AI decides a pairing, as itself (ADR 0181, part 1)", () => {
  it("applies what passes the citation check and meets a bar, as Atticus's line with the run, and keeps the rest", async () => {
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    const d = await decideLinks(root, {
      view,
      facts,
      run: "r1",
      now: AT,
      proposals: [
        // The shapes rank the capture route first: it agrees.
        {
          call: "call.post.capture-charge",
          api: CAPTURE,
          why: "the constant",
          lines: [`${FILE}:31`],
        },
        // The shapes say the charges route: the AI's pick stays a proposal.
        { call: "call.post.charges", api: REFUNDS, why: "a guess", lines: [`${FILE}:42`] },
        // A line that isn't there fails the citation check.
        { call: "call.post.charges-capture", api: CAPTURE, why: "x", lines: [`${FILE}:999`] },
      ],
    });
    expect(d?.mode).toBe("auto");
    expect(d?.applied).toEqual([
      { call: "call.post.capture-charge", api: CAPTURE, bar: "agrees-with-shapes" },
    ]);
    expect(d?.kept.map((k) => k.call)).toEqual(["call.post.charges", "call.post.charges-capture"]);
    expect(d?.kept[1]!.why).toMatch(/citation check/);
    const lines = await corrections();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 2,
      action: "link",
      by: "atticus",
      ai: { runtime: "copilot-acp", run: "r1", bar: "agrees-with-shapes" },
      batch: d!.batch,
      link: { repo: GW, entry: CAPTURE },
    });
    // Joined as the AI's, never a person's.
    expect(
      pairsFromCorrections(await billingFacts(), lines)["call.post.capture-charge"]?.ai,
    ).toEqual({
      runtime: "copilot-acp",
      run: "r1",
      bar: "agrees-with-shapes",
    });
    const b = await readBatch(root, d!.batch!);
    expect(b).toMatchObject({ kind: "ai", by: { kind: "ai", run: "r1" } });
    expect(b!.applied).toHaveLength(1);
  });

  it("decides nothing while runtime.yaml says propose, or inside a Copilot session", async () => {
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    const proposals = [
      { call: "call.post.capture-charge", api: CAPTURE, why: "x", lines: [`${FILE}:31`] },
    ];
    expect(
      await decideLinks(root, {
        view,
        facts,
        run: "r1",
        proposals,
        env: { ATTICUS_ACP_SESSION: "1" },
      }),
    ).toBeUndefined();
    await writeFile(join(root, "org-pack/runtime.yaml"), RUNTIME("decide: { links: propose }"));
    expect(await decideLinks(root, { view, facts, run: "r1", proposals })).toBeUndefined();
    expect(await corrections()).toEqual([]);
  });

  it("pauses back to propose when the sample audit puts the AI below decide.minPrecision", async () => {
    await writeFile(
      join(root, "facts/forge-billing.audit.yaml"),
      stringify({
        schema: 1,
        repo: "forge-billing",
        draws: [],
        items: [
          { id: "ai:link:x", kind: "ai", of: "link", claim: "x", cites: ["a:1"], answer: "right" },
          { id: "ai:link:y", kind: "ai", of: "link", claim: "y", cites: ["a:1"], answer: "wrong" },
        ],
      }),
    );
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    const d = await decideLinks(root, {
      view,
      facts,
      run: "r1",
      proposals: [
        { call: "call.post.capture-charge", api: CAPTURE, why: "x", lines: [`${FILE}:31`] },
      ],
    });
    expect(d).toMatchObject({ mode: "propose", applied: [] });
    expect(d?.paused).toMatch(/50% right .*95%/);
    expect(await corrections()).toEqual([]);
    const v = await decisionsView(root);
    expect(v.decide.now).toEqual({ links: "propose", questions: "propose" });
    expect(v.decide.paused?.why).toMatch(/decide\.minPrecision/);
  });
});

describe("a person corrects a pairing, and the correction spreads (ADR 0181, part 2)", () => {
  beforeEach(async () => {
    await writeFile(
      join(root, "facts/forge-billing.corrections.jsonl"),
      [
        await aiLine("call.post.charges-capture", 40, "/charges/{id}/capture", "r0"),
        await aiLine("call.post.charges-refunds", 41, "/charges/{id}/refunds", "r0"),
        "",
      ].join("\n"),
    );
  });

  it("previews the rule and what it re-checks, writing nothing", async () => {
    const before = await readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8");
    const r = await correctDecision(
      root,
      {
        item: "link:forge-billing:call.post.charges-capture",
        api: CAPTURE,
        repo: GW,
        preview: true,
      },
      { by: "pat", now: AT },
    );
    expect(r.written).toBe(false);
    expect(r.rule).toEqual({ kind: "path", match: "/charges/**", derived: true });
    expect(r.spread.map((s) => [s.item, s.change])).toEqual([
      ["link:forge-billing:call.post.charges-refunds", "replaced"],
      ["link:forge-billing:call.post.charges", "applied"],
    ]);
    expect(await readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8")).toBe(
      before,
    );
  });

  it("writes the person's line and the rule's lines in one batch, and Undo removes exactly them", async () => {
    const r = await correctDecision(
      root,
      { item: "link:forge-billing:call.post.charges-capture", api: CAPTURE, repo: GW },
      { by: "pat", now: AT },
    );
    expect(r.written).toBe(true);
    expect(r.counts).toEqual({ applied: 1, confirmed: 0, replaced: 1, reverted: 0 });
    const lines = await corrections();
    const mine = lines.filter((l) => l.batch === r.batch);
    expect(mine.map((l) => [l.fact, l.by, l.link?.entry, l.rule?.from, l.match])).toEqual([
      ["call.post.charges-capture", "pat", CAPTURE, undefined, "/charges/**"],
      [
        "call.post.charges-refunds",
        "pat",
        REFUNDS,
        "link:forge-billing:call.post.charges-capture",
        undefined,
      ],
      [
        "call.post.charges",
        "pat",
        CHARGES,
        "link:forge-billing:call.post.charges-capture",
        undefined,
      ],
    ]);
    // A person's word now, never the AI's.
    const pairs = pairsFromCorrections(await billingFacts(), lines);
    for (const id of [
      "call.post.charges-capture",
      "call.post.charges-refunds",
      "call.post.charges",
    ])
      expect(pairs[id]).toMatchObject({ repo: GW, by: "pat" });
    expect(Object.values(pairs).some((p) => p.ai)).toBe(false);
    expect((await decisionsView(root)).links.items).toEqual([]);

    const u = await undoBatch(root, r.batch!, { by: "pat", now: AT });
    expect(u).toMatchObject({ batch: r.batch, removed: 3, restored: 0, skipped: [] });
    const after = await corrections();
    expect(after.every((l) => l.ai)).toBe(true);
    expect((await decisionsView(root)).links.items.map((i) => i.item)).toEqual([
      "link:forge-billing:call.post.charges-capture",
      "link:forge-billing:call.post.charges-refunds",
    ]);
    await expect(undoBatch(root, r.batch!, { by: "pat" })).rejects.toThrow(/undone by pat/);
  });

  it("takes none: an unlink, and the AI pairings the rule covers are withdrawn the same way", async () => {
    const r = await correctDecision(
      root,
      { item: "link:forge-billing:call.post.charges-capture", none: true },
      { by: "pat", now: AT },
    );
    expect(r.answer).toBe("none");
    const lines = (await corrections()).filter((l) => l.batch === r.batch);
    expect(lines.map((l) => [l.fact, l.action])).toEqual([
      ["call.post.charges-capture", "unlink"],
      ["call.post.charges-refunds", "unlink"],
      ["call.post.charges", "unlink"],
    ]);
    expect(pairsFromCorrections(await billingFacts(), await corrections())).toEqual({});
  });

  it("corrects one alone with similar off, refuses what isn't the AI's, and a session corrects nothing", async () => {
    const r = await correctDecision(
      root,
      {
        item: "link:forge-billing:call.post.charges-capture",
        api: CAPTURE,
        repo: GW,
        similar: false,
      },
      { by: "pat", now: AT },
    );
    expect(r.rule).toBeUndefined();
    expect(r.spread).toEqual([]);
    await expect(
      correctDecision(
        root,
        { item: "link:forge-billing:call.post.charges-capture", api: CAPTURE, repo: GW },
        { by: "pat" },
      ),
    ).rejects.toThrow(/isn't paired by AI/);
    await expect(
      correctDecision(
        root,
        { item: "link:forge-billing:call.post.charges-refunds", none: true },
        { by: "pat", env: { ATTICUS_ACP_SESSION: "1" } },
      ),
    ).rejects.toThrow(/acts as no one/);
  });

  it("lists the AI's standing pairings as audit items of the AI kind", async () => {
    const items = await aiAuditCandidates(root, "forge-billing");
    expect(items.map((i) => [i.id, i.kind, i.of, i.run])).toEqual([
      ["ai:link:call.post.charges-capture", "ai", "link", "r0"],
      ["ai:link:call.post.charges-refunds", "ai", "link", "r0"],
    ]);
  });
});

const targetsQuestion = (id: string, line: number) =>
  Question.parse({
    schemaVersion: 5,
    id,
    askedBy: {
      step: "facts-targets",
      command: "atticus verify forge-billing --write",
      at: "2026-11-08T08:00:00Z",
    },
    repo: "forge-billing",
    question: `Where does forge-billing's call on line ${line} go?`,
    options: [
      { label: "forge-shop-bff", means: "forge-shop-bff: a path like it", changes: "joins it" },
      { label: GW, means: `${GW}: the same path under /partners/northwind`, changes: "joins it" },
      { label: "Another repo…", means: "A repo not listed", changes: "Nothing until you name one" },
      { label: "None of these", means: "Nothing answers it", changes: "The call stays loose" },
    ],
    evidence: [`${FILE}:${line}`],
    scope: { level: "repo", id: "forge-billing" },
    state: "open",
    rerun: "atticus verify forge-billing --write",
  });

const QA = "q-aaaaaaaaaaa1";
const QB = "q-bbbbbbbbbbb2";

async function propose(id: string, option: number, line: number) {
  await mkdir(join(root, "proposals/questions"), { recursive: true });
  await writeFile(
    join(root, `proposals/questions/${id}.yaml`),
    stringify({
      schemaVersion: 1,
      answer: { option },
      why: "The client posts to it.",
      cites: [{ file: FILE, line, quote: SOURCE.split("\n")[line - 1]!.trim() }],
      by: "copilot",
      at: "2026-11-08T10:00:00.000Z",
    }),
  );
}

describe("the AI answers an option question, and a correction spreads (ADR 0181)", () => {
  beforeEach(async () => {
    await writeQuestion(root, targetsQuestion(QA, 40));
    await writeQuestion(root, targetsQuestion(QB, 41));
    await propose(QA, 1, 40);
    await propose(QB, 1, 41);
  });

  it("answers as the AI, with the run and the proposal's lines, and takes the proposal up", async () => {
    const d = await decideAnswers(root, { run: "r2", now: AT });
    expect(d?.applied.map((a) => [a.id, a.option, a.bar])).toEqual([
      [QA, 1, "agrees-with-shapes"],
      [QB, 1, "agrees-with-shapes"],
    ]);
    const q = (await readQuestion(root, QA))!;
    expect(q.state).toBe("answered");
    expect(isAiBy(q.answer!.by)).toBe(true);
    expect(q.answer).toMatchObject({
      by: { kind: "ai", runtime: "copilot-acp", run: "r2" },
      batch: d!.batch,
      proposal: { by: "copilot", cites: [{ file: FILE, line: 40 }] },
    });
    expect(await readdir(join(root, "proposals/questions"))).toEqual([]);
    const v = await decisionsView(root);
    expect(v.questions.counts).toMatchObject({ byAi: 2, byPerson: 0 });
    expect(v.questions.items.map((i) => [i.item, i.decided, i.run])).toEqual([
      [QA, "forge-shop-bff", "r2"],
      [QB, "forge-shop-bff", "r2"],
    ]);
    expect(v.batches[0]).toMatchObject({
      id: d!.batch,
      kind: "ai",
      by: "AI (copilot-acp, run r2)",
    });
  });

  it("never decides what isn't the AI's: an option further down, or with questions on propose", async () => {
    await propose(QA, 2, 40);
    const d = await decideAnswers(root, { run: "r2", ids: new Set([QA]), now: AT });
    expect(d?.applied).toEqual([]);
    expect(d?.kept[0]!.why).toMatch(/shapes don't list that option first/);
    await writeFile(join(root, "org-pack/runtime.yaml"), RUNTIME("decide: { links: auto }"));
    expect(await decideAnswers(root, { run: "r2" })).toBeUndefined();
    expect((await readQuestion(root, QB))!.state).toBe("open");
  });

  it("a person's correction is theirs, its rule answers the AI's sibling, and Undo puts the AI's answers back", async () => {
    await decideAnswers(root, { run: "r2", now: AT });
    const r = await correctDecision(root, { item: QA, option: 2 }, { by: "pat", now: AT });
    expect(r).toMatchObject({
      written: true,
      answer: GW,
      rule: { kind: "path", match: "/charges/**", derived: true },
      counts: { applied: 0, confirmed: 0, replaced: 1, reverted: 0 },
    });
    const a = (await readQuestion(root, QA))!;
    expect(a.answer).toMatchObject({ option: 2, by: "pat", match: "/charges/**", batch: r.batch });
    const b = (await readQuestion(root, QB))!;
    expect(b.answer).toMatchObject({
      option: 2,
      by: "pat",
      rule: { from: QA, match: "/charges/**" },
      batch: r.batch,
    });
    const v = await decisionsView(root);
    expect(v.questions.counts).toMatchObject({ byAi: 0, byPerson: 2 });

    await undoBatch(root, r.batch!, { by: "pat", now: AT });
    for (const id of [QA, QB]) {
      const q = (await readQuestion(root, id))!;
      expect(q.answer).toMatchObject({ option: 1, by: { kind: "ai", run: "r2" } });
    }
  });

  it("refuses to correct a question no AI answered", async () => {
    await expect(correctDecision(root, { item: QA, option: 2 }, { by: "pat" })).rejects.toThrow(
      /isn't an AI decision/,
    );
  });
});

describe("the local API (C4 2.80.0)", () => {
  it("lists, previews, corrects and undoes through the routes, as the app's user", async () => {
    await writeFile(
      join(root, "facts/forge-billing.corrections.jsonl"),
      `${await aiLine("call.post.charges-capture", 40, "/charges/{id}/capture", "r0")}\n`,
    );
    const srv = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiDecisionRoutes(r, ctx, { now: () => AT }),
    });
    try {
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(srv.url + path, {
          method,
          headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: (await res.json()) as unknown };
      };
      const v = Api.DecisionsView.parse((await call("GET", "/api/decisions")).body);
      expect(v.links.items.map((i) => [i.item, i.run])).toEqual([
        ["link:forge-billing:call.post.charges-capture", "r0"],
      ]);
      expect(v.decide.configured).toEqual({ links: "auto", questions: "auto", minPrecision: 0.95 });
      const item = "link:forge-billing:call.post.charges-capture";
      const p = Api.CorrectDecisionResult.parse(
        (
          await call("POST", "/api/decisions/correct", {
            item,
            api: CAPTURE,
            repo: GW,
            preview: true,
          })
        ).body,
      );
      expect(p.written).toBe(false);
      const w = Api.CorrectDecisionResult.parse(
        (await call("POST", "/api/decisions/correct", { item, api: CAPTURE, repo: GW })).body,
      );
      expect(w.written).toBe(true);
      expect((await call("POST", "/api/decisions/correct", {})).status).toBe(400);
      expect((await call("POST", "/api/decisions/correct", { item, none: true })).status).toBe(409);
      const u = await call("POST", `/api/decisions/batches/${w.batch}/undo`);
      expect(u.status).toBe(200);
      expect(Api.UndoBatchResult.parse(u.body).batch).toBe(w.batch);
      expect((await call("POST", `/api/decisions/batches/${w.batch}/undo`)).status).toBe(409);
      expect((await call("POST", "/api/decisions/batches/nope/undo")).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});

describe("after a Copilot session Atticus ran (ADR 0181 with ADR 0178 and ADR 0171)", () => {
  it("Match with Copilot: the session writes its answer; Atticus applies what passes and says so", async () => {
    const { runMatch } = await import("../src/link-match.js");
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    const r = await runMatch(root, {
      view,
      quotes: new Map(),
      facts,
      mode: "copilot-acp",
      now: AT,
      runner: async () => {
        await writeFile(
          join(root, "proposals/matching/forge-billing--repo-forge-partner-gateway.yaml"),
          stringify({
            pairs: [
              {
                call: "call.post.capture-charge",
                api: CAPTURE,
                why: "the constant",
                lines: [`${FILE}:31`],
              },
              { call: "call.post.charges", api: REFUNDS, why: "a guess", lines: [`${FILE}:42`] },
            ],
            none: [],
          }),
        );
        return { stopReason: "end_turn", runId: "r9" } as never;
      },
    });
    expect(r.state).toBe("done");
    expect(r.decided?.applied).toEqual([
      { call: "call.post.capture-charge", api: CAPTURE, bar: "agrees-with-shapes" },
    ]);
    // What was applied is no longer a proposal; the rest are.
    expect(r.proposals.map((p) => p.call)).toEqual(["call.post.charges"]);
    expect((await corrections())[0]).toMatchObject({ by: "atticus", ai: { run: "r9" } });
  });

  it("questions propose: the answers the session proposed that pass are applied as the AI's", async () => {
    const { questionsProposeCommand } = await import("../src/copilot-acp-steps.js");
    await writeQuestion(root, targetsQuestion(QA, 40));
    const said: string[] = [];
    const code = await questionsProposeCommand(
      root,
      {
        mode: "copilot-acp",
        now: AT,
        runner: async () => {
          await propose(QA, 1, 40);
          return { stopReason: "end_turn", runId: "r7" } as never;
        },
      },
      { out: (l) => said.push(l), err: (l) => said.push(l) },
      async () => 0,
    );
    expect(code).toBe(0);
    expect(said.join("\n")).toMatch(/Detected by AI: 1 answer applied in batch b-20261108-101500-/);
    expect((await readQuestion(root, QA))!.answer?.by).toMatchObject({ kind: "ai", run: "r7" });
  });
});

describe("a person's word stands over the AI's (round 45)", () => {
  const propose = [
    { call: "call.post.capture-charge", api: CAPTURE, why: "x", lines: [`${FILE}:31`] },
  ];
  it("never re-pairs a call a person said reaches none", async () => {
    await writeFile(
      join(root, "facts/forge-billing.corrections.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        fact: "call.post.capture-charge",
        target: { kind: "call", file: FILE, line: 31, value: "captureChargePath" },
        action: "unlink",
        by: "pat",
        at: "2026-11-08T09:00:00.000Z",
      }) + "\n",
    );
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    const d = await decideLinks(root, { view, facts, run: "r1", now: AT, proposals: propose });
    expect(d?.applied).toEqual([]);
    expect(d?.kept[0]?.why).toMatch(/a person has said where this call goes/);
    expect((await corrections()).filter((c) => c.ai)).toEqual([]);
  });

  it("never overrides a pairing a person made while the session ran", async () => {
    const { view, facts } = await candidatesOf(root, "forge-billing", { repo: GW });
    await writeFile(
      join(root, "facts/forge-billing.corrections.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        fact: "call.post.capture-charge",
        target: { kind: "call", file: FILE, line: 31, value: "captureChargePath" },
        action: "link",
        link: {
          repo: GW,
          entry: REFUNDS,
          method: "POST",
          path: "/partners/northwind/charges/{chargeId}/refunds",
        },
        by: "pat",
        at: "2026-11-08T10:00:00.000Z",
      }) + "\n",
    );
    const d = await decideLinks(root, { view, facts, run: "r1", now: AT, proposals: propose });
    expect(d?.applied).toEqual([]);
    const pairs = pairsFromCorrections(await billingFacts(), await corrections());
    expect(pairs["call.post.capture-charge"]).toMatchObject({ by: "pat", entry: REFUNDS });
  });
});
