import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  acquireLock,
  estimateTokens,
  readLock,
  linksFor,
  listBatches,
  parseCorrections,
  parseFacts,
  Runtime,
  withRunIo,
} from "@maycombhq/core";
import { undoDirOf } from "@maycombhq/scanner";
import {
  applyPairHooks,
  pairApply,
  pairAsk,
  pairLines,
  pairLoose,
  pairNot,
  pathProblem,
} from "../src/apply-pair.js";
import { makeBigEstate } from "./big-estate.js";
import { verifyCommand } from "../src/verify-commands.js";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";

/**
 * ADR 0210 part 4 (item 4 of docs/plan/ai-first.md): after Apply's write, the calls the join left
 * loose go to the model in one request, every candidate repo's entries at once; a pairing is drawn
 * as the AI's only when the verifier finds both its quotes (the call's line, the entry's line)
 * and each line it rests on in the code. On fixtures/gateway-shape: the proxy's five requests,
 * whose targets name servers, not hosts. The model is a fake runner; nothing leaves the machine.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/gateway-shape");
const FORGE = join(HERE, "../../../fixtures/forge/metarepo/org-pack");
const W = "forge-edge-wallets";
const WM = "forge-wallets-module";
const LM = "forge-ledger-module";
const FLOWS = "apiproxy/proxies/default.xml";
const CAMEL = "src/main/resources/OSGI-INF/blueprint/camel-context.xml";

/** The proxy's five requests, each cited at its flow's condition. */
const CALLS = [
  ["call.get.account", "GET", "/accounts/*", 14],
  ["call.post.accounts", "POST", "/accounts", 17],
  ["call.get.holds", "GET", "/accounts/*/holds", 20],
  ["call.get.statement", "GET", "/statements/*", 23],
  ["call.put.limits", "PUT", "/accounts/*/limits", 26],
] as const;
const callFact = ([id, method, path, line]: (typeof CALLS)[number]) =>
  JSON.stringify({
    kind: "call",
    id,
    repo: W,
    commit: "9f8e7d6",
    callType: "rest",
    method,
    path,
    base: "target.server",
    cite: { file: FLOWS, line, value: path, quote: `MatchesPath "${path}"` },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

const flow = (line: number, path: string) => ({
  file: FLOWS,
  line,
  quote: `MatchesPath "${path}"`,
});
const camel = (line: number, quote: string) => ({ file: CAMEL, line, quote });
const path = (repo: string, file: string, line: number) => ({
  repo,
  file,
  line,
  quote: "<Path>/cxf/api</Path>",
});
const wallets = [
  {
    repo: W,
    file: "apiproxy/targets/wallets.xml",
    line: 14,
    quote: '<Server name="wallets-fuse"/>',
  },
  path(W, "apiproxy/targets/wallets.xml", 16),
  {
    repo: "forge-edge-config",
    file: "env/prod/targetservers.json",
    line: 4,
    quote: '"host": "wallets.prod.forge.example"',
  },
  { repo: WM, file: "deploy/prod.yaml", line: 2, quote: "host: wallets.prod.forge.example" },
];
const ledger = [
  { repo: W, file: "apiproxy/targets/ledger.xml", line: 4, quote: '<Server name="ledger-fuse"/>' },
  path(W, "apiproxy/targets/ledger.xml", 6),
  { repo: LM, file: "deploy/prod.yaml", line: 2, quote: "host: ledger.prod.forge.example" },
];
const rewrite = {
  repo: W,
  file: "apiproxy/resources/jsc/rewrite-holds.js",
  line: 4,
  quote: 'suffix.replace(/\\/holds$/, "/blocks")',
};

/**
 * The model's answer: the four true arrows, and before them two wrong ones for the first call (a
 * quote not on its line; GET /accounts/* to POST /accounts, which no check lets through), and one
 * for the request no entry could serve (PUT: no candidate, so never sent).
 */
const ANSWER = {
  pairs: [
    {
      call: `${W} call.get.account`,
      entry: `${WM} entry.get.account`,
      callLine: flow(14, "/accounts/*"),
      entryLine: camel(6, '<get uri="/{walletId}">'),
      with: wallets,
    },
    {
      call: `${W} call.get.account`,
      entry: `${WM} entry.post.accounts`,
      callLine: flow(14, "/accounts/*"),
      entryLine: camel(9, "<post>"),
      with: wallets,
    },
    {
      call: `${W} call.get.account`,
      entry: `${WM} entry.get.account`,
      callLine: flow(14, "/accounts/*"),
      entryLine: camel(6, '<get uri="/{accountId}">'),
      with: wallets,
    },
    {
      call: `${W} call.post.accounts`,
      entry: `${WM} entry.post.accounts`,
      callLine: flow(17, "/accounts"),
      entryLine: camel(9, "<post>"),
      with: wallets,
    },
    {
      call: `${W} call.get.holds`,
      entry: `${WM} entry.get.account-blocks`,
      callLine: flow(20, "/accounts/*/holds"),
      entryLine: camel(12, '<get uri="/{accountId}/blocks">'),
      with: [...wallets, rewrite],
    },
    {
      call: `${W} call.get.statement`,
      entry: `${LM} entry.get.statement`,
      callLine: flow(23, "/statements/*"),
      entryLine: camel(14, '<get uri="/{statementId}">'),
      with: ledger,
    },
    {
      call: `${W} call.put.limits`,
      entry: `${LM} entry.get.ledger-account`,
      callLine: flow(26, "/accounts/*/limits"),
      entryLine: camel(6, '<get uri="/{accountId}">'),
    },
  ],
};

let root: string;
let prompts: string[];
/** Told as the model runs, before it answers (a person's line written meanwhile). */
let during: (() => Promise<void>) | undefined;
const runner: AcpStepRunner = async (s) => {
  prompts.push(s.line);
  await during?.();
  const file = /Write (\S+\.yaml)/.exec(s.line)![1]!;
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), stringify(ANSWER));
  return { stopReason: "end_turn", runId: `r${prompts.length}` } as never;
};

const RUNTIME = (more: string[] = []) =>
  [
    "schemaVersion: 5",
    "assistants: { allowed: [copilot], default: copilot }",
    "modes: { allowed: [hand-off, copilot-acp], default: copilot-acp }",
    ...more,
    "",
  ].join("\n");

beforeEach(async () => {
  prompts = [];
  during = undefined;
  root = await mkdtemp(join(tmpdir(), "atticus-apply-pair-"));
  await cp(FORGE, join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/runtime.yaml"), RUNTIME());
  const repo = (id: string, type: string) => ({
    id,
    url: `https://git.example.com/forge/${id}.git`,
    type,
    owner: "team-wallets",
  });
  await writeFile(
    join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      repos: [
        repo(W, "gateway"),
        repo("forge-edge-config", "infra"),
        repo(WM, "spring-boot"),
        repo(LM, "spring-boot"),
      ],
    }),
  );
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  await writeFile(join(root, `facts/${W}.jsonl`), CALLS.map(callFact).join("\n") + "\n");
  await cp(join(FIX, "repos"), join(root, "workspace"), { recursive: true });
  // What Apply kept: each repo's facts snapshot in the catalog.
  await cp(join(root, "facts"), join(root, "catalog/sources/facts"), { recursive: true });
});

const lines = async (repo = W) =>
  parseCorrections(
    await readFile(join(root, `facts/${repo}.corrections.jsonl`), "utf8").catch(() => ""),
  ).corrections;
const proxyCalls = async () => {
  const r = parseFacts(await readFile(join(root, `facts/${W}.jsonl`), "utf8"));
  if (!r.ok) throw new Error("the facts don't read");
  return r.facts;
};

const sentIn = (prompt: string) => (/## The calls[\s\S]*?## The entries/.exec(prompt) ?? [""])[0];
const personLine = (
  fact: string,
  line: number,
  value: string,
  to: { repo: string; entry: string; method: string; path: string },
) =>
  JSON.stringify({
    schemaVersion: 2,
    fact,
    target: { kind: "call", file: FLOWS, line, value },
    action: "link",
    link: to,
    by: "pat@forge.example",
    at: "2099-01-01T00:00:00.000Z",
  }) + "\n";
const TO_LEDGER = {
  repo: LM,
  entry: "entry.get.ledger-account",
  method: "GET",
  path: "/cxf/api/accounts/{accountId}",
};

describe("Apply pairs what the join left loose (ADR 0210 part 4)", () => {
  it("draws the pairings both of whose sides check as the AI's, drops the rest and lists them", async () => {
    const r = await pairLoose(root, { runner });
    expect(prompts).toHaveLength(1);
    // Every candidate repo's entries in the one request; only entries that could serve a call.
    expect(prompts[0]).toContain(`${WM} entry.get.account`);
    expect(prompts[0]).toContain(`${LM} entry.get.ledger-account`);
    expect(prompts[0]).not.toContain("entry.delete.account");
    // PUT /accounts/*/limits: no entry could serve it, so it is never sent.
    expect(sentIn(prompts[0]!)).not.toContain("call.put.limits");
    expect(r.paired.map((p) => p.call).sort()).toEqual([
      `${W} call.get.account`,
      `${W} call.get.holds`,
      `${W} call.get.statement`,
      `${W} call.post.accounts`,
    ]);
    expect(r.dropped.map((d) => [d.call, d.why])).toEqual([
      [`${W} call.get.account`, expect.stringMatching(/quote/)],
      [`${W} call.get.account`, expect.stringMatching(/candidate/)],
      [`${W} call.put.limits`, expect.stringMatching(/wasn't sent/)],
    ]);
    expect(r.loose).toEqual([`${W} call.put.limits`]);
    const c = await lines();
    expect(c).toHaveLength(4);
    for (const l of c) {
      expect(l.by).toBe("atticus");
      expect(l.ai).toEqual({ runtime: "copilot-acp", run: "r1" });
    }
    const facts = await proxyCalls();
    const holds = facts.find((f) => f.id === "call.get.holds")!;
    expect(linksFor(holds, c)[0]!.link).toMatchObject({
      repo: WM,
      entry: "entry.get.account-blocks",
    });
    const b = (await listBatches(root)).batches;
    expect(b).toHaveLength(1);
    expect(b[0]!.applied).toHaveLength(4);
    expect(pairLines(r)).toEqual([
      "Paired 4 calls; 1 left loose.",
      expect.stringMatching(/^ {2}Dropped .*call\.get\.account/),
      expect.stringMatching(/^ {2}Dropped .*call\.get\.account/),
      expect.stringMatching(/^ {2}Dropped .*call\.put\.limits/),
      `  Left loose: ${W} call.put.limits`,
    ]);
  });

  it("the path and method must agree, and a prefix or a rewrite must be on a line it rests on", () => {
    const call = { method: "GET", path: "/accounts/*" };
    const entry = (method: string, path: string) => ({ method, path });
    expect(pathProblem(call, entry("POST", "/limits"))).toMatch(/method/);
    expect(pathProblem(call, entry("GET", "/cxf/api/accounts/{accountId}"))).toBeUndefined();
    expect(pathProblem(call, entry("GET", "/cxf/api/accounts/{accountId}"), [])).toMatch(
      /\/cxf\/api/,
    );
    expect(
      pathProblem(call, entry("GET", "/cxf/api/accounts/{accountId}"), ["<Path>/cxf/api</Path>"]),
    ).toBeUndefined();
    const holds = { method: "GET", path: "/accounts/*/holds" };
    const blocks = entry("GET", "/cxf/api/accounts/{accountId}/blocks");
    expect(pathProblem(holds, blocks, ["<Path>/cxf/api</Path>"])).toMatch(/blocks/);
    expect(
      pathProblem(holds, blocks, ["<Path>/cxf/api</Path>", 'replace(/holds$/, "/blocks")']),
    ).toBeUndefined();
    expect(pathProblem({ method: "GET", path: "/a/b/c" }, entry("GET", "/b/c"))).toMatch(/shorter/);
  });

  it("a second Apply with no change sends no prompt", async () => {
    await pairLoose(root, { runner });
    const r = await pairLoose(root, { runner });
    expect(prompts).toHaveLength(1);
    expect(r.paired).toEqual([]);
    expect(r.loose).toEqual([`${W} call.put.limits`]);
    expect(await lines()).toHaveLength(4);
  });

  it("an entry's file changed: only the calls it or its entries cite are paired again", async () => {
    await pairLoose(root, { runner });
    await appendFile(join(root, "workspace", LM, CAMEL), "<!-- touched -->\n");
    const r = await pairLoose(root, { runner });
    expect(prompts).toHaveLength(2);
    const sent = sentIn(prompts[1]!);
    expect(sent).toContain("call.get.statement");
    expect(sent).not.toContain("call.post.accounts");
    expect(sent).not.toContain("call.get.holds");
    expect(r.paired.map((p) => p.call)).toEqual([`${W} call.get.statement`]);
    expect(await lines()).toHaveLength(4);
  });

  it("an AI line whose cited line no longer says it is withdrawn, and said", async () => {
    await pairLoose(root, { runner });
    const file = join(root, "workspace", WM, CAMEL);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace('<get uri="/{accountId}">', '<get uri="/{id}">'),
    );
    const r = await pairLoose(root, { runner });
    expect(r.withdrawn.map((w) => w.call)).toEqual([`${W} call.get.account`]);
    expect(pairLines(r)).toContain("Withdrew 1 AI pairing whose lines changed.");
    const facts = await proxyCalls();
    const newest = linksFor(
      facts.find((f) => f.id === "call.get.account")!,
      await lines(),
    )[0];
    expect(newest).toBeUndefined();
    expect(r.loose).toContain(`${W} call.get.account`);
  });

  it("a person's move of an AI arrow is kept on the next Apply", async () => {
    await pairLoose(root, { runner });
    await appendFile(
      join(root, `facts/${W}.corrections.jsonl`),
      personLine("call.get.account", 14, "/accounts/*", TO_LEDGER),
    );
    await appendFile(join(root, "workspace", WM, CAMEL), "<!-- touched -->\n");
    const r = await pairLoose(root, { runner });
    expect(prompts).toHaveLength(2);
    expect(sentIn(prompts[1]!)).not.toContain("call.get.account");
    expect(r.withdrawn).toEqual([]);
    const facts = await proxyCalls();
    const newest = linksFor(
      facts.find((f) => f.id === "call.get.account")!,
      await lines(),
    )[0]!;
    expect(newest.by).toBe("pat@forge.example");
  });

  it("what the model said is checked again before it is written: a line changed meanwhile is dropped", async () => {
    const asked = await pairAsk(root, { runner });
    expect(await lines()).toEqual([]);
    const file = join(root, "workspace", LM, CAMEL);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace('<get uri="/{statementId}">', '<get uri="/{id}">'),
    );
    const r = await pairApply(root, asked);
    expect(r.paired.map((p) => p.call)).not.toContain(`${W} call.get.statement`);
    expect(r.paired).toHaveLength(3);
    expect(r.dropped.some((d) => d.call === `${W} call.get.statement` && /quote/.test(d.why))).toBe(
      true,
    );
  });

  it("a person's line written while the model runs wins", async () => {
    during = () =>
      appendFile(
        join(root, `facts/${W}.corrections.jsonl`),
        personLine("call.get.holds", 20, "/accounts/*/holds", TO_LEDGER),
      );
    const r = await pairLoose(root, { runner });
    expect(r.paired.map((p) => p.call)).not.toContain(`${W} call.get.holds`);
    const facts = await proxyCalls();
    const newest = linksFor(
      facts.find((f) => f.id === "call.get.holds")!,
      await lines(),
    )[0]!;
    expect(newest.by).toBe("pat@forge.example");
    expect(await lines()).toHaveLength(4);
  });

  it.each([
    ["AI off", ["ai: off"], /AI is off/],
    ["apply.pair off", ["apply: { pair: off }"], /apply\.pair/],
    ["the budget spent", ["budgets: { limits: [{ per: run, tokens: 1 }] }"], /budget|would pass/i],
  ])("%s: nothing is sent, the calls stay listed, nothing fails", async (_, more, why) => {
    await writeFile(join(root, "org-pack/runtime.yaml"), RUNTIME(more));
    const r = await pairLoose(root, { runner });
    expect(prompts).toEqual([]);
    expect(r.paired).toEqual([]);
    expect(r.loose).toHaveLength(5);
    expect(r.why).toMatch(why);
    expect(pairLines(r)[0]).toBe("Paired 0 calls; 5 left loose.");
    expect(await lines()).toEqual([]);
  });

  it.each([
    ["absent", [], true],
    ["apply: {}", ["apply: {}"], true],
    ["apply.pair on", ["apply: { pair: on }"], true],
  ])("apply %s: on for copilot-acp; hand-off never pairs", async (_, more, acp) => {
    const rt = Runtime.parse(parse(RUNTIME(more)));
    expect(pairNot(rt) === undefined).toBe(acp);
    const handOff = Runtime.parse(
      parse(
        RUNTIME(more).replace(
          "[hand-off, copilot-acp], default: copilot-acp",
          "[hand-off], default: hand-off",
        ),
      ),
    );
    expect(pairNot(handOff)).toMatch(/hand-off/);
  });

  it("calls past the model's limit go in more requests, each within it, planned as one", async () => {
    const { root: big, repos } = await makeBigEstate(
      await mkdtemp(join(tmpdir(), "atticus-apply-pair-big-")),
      { repos: 6, entries: 20, calls: 30, checkouts: 6 },
    );
    await writeFile(
      join(big, "org-pack/runtime.yaml"),
      RUNTIME(["budgets: { defaultTokens: 450 }"]),
    );
    // An entry in each repo that the deploy-token calls (GET /v1/<noun>s/{id}) could reach.
    for (const repo of repos) {
      const other = JSON.stringify({
        kind: "entry",
        id: "e-other",
        repo,
        commit: "1111aaa",
        entryType: "rest",
        method: "GET",
        path: "/v1/others/{id}",
        cite: { file: "src/Other.java", line: 1, value: "/v1/others/{id}" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      });
      for (const f of [`facts/${repo}.jsonl`, `catalog/sources/facts/${repo}.jsonl`])
        await appendFile(join(big, f), `${other}\n`);
    }
    const said: string[] = [];
    const sizes: number[] = [];
    const quiet: AcpStepRunner = async (s) => {
      sizes.push(estimateTokens(s.line));
      return { stopReason: "end_turn", runId: `r${sizes.length}` } as never;
    };
    const r = await withRunIo({ say: (l) => said.push(l) }, () =>
      pairLoose(big, { runner: quiet }),
    );
    expect(sizes.length).toBeGreaterThan(1);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(450);
    expect(said[0]).toMatch(new RegExp(`plans ${sizes.length} sessions`));
    expect(r.paired).toEqual([]);
  });

  it("Apply pairs inside its one write: the line, the arrows in the catalog, one undo copy each", async () => {
    applyPairHooks.runner = runner;
    // The model runs before the write takes its lock: another write takes it and lets it go.
    const free: boolean[] = [];
    during = async () => {
      free.push((await readLock(root, "scan")) === undefined);
      await (await acquireLock(root, "scan", "another write")).release();
    };
    await rm(join(root, "catalog"), { recursive: true });
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    try {
      for (const repo of [WM, LM, W])
        expect(
          await verifyCommand(root, repo, { write: true, dir: join(root, "workspace", repo) }, io),
        ).toBe(0);
      expect(err.join("\n")).not.toMatch(/Pairing after Apply/);
    } finally {
      delete applyPairHooks.runner;
    }
    expect(out).toContain("Paired 4 calls; 1 left loose.");
    expect(prompts).toHaveLength(1);
    expect(free).toEqual([true]);
    const dir = join(root, "catalog/generated/interface");
    const texts = await Promise.all(
      (await readdir(dir)).map((n) => readFile(join(dir, n), "utf8")),
    );
    expect(texts.filter((t) => t.includes("joined-by-ai"))).toHaveLength(4);
    // One undo copy an Apply: the pairing went into the proxy's own write.
    expect(await readdir(await undoDirOf(root))).toHaveLength(3);
  });
});
