import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { linksFor, listBatches, parseCorrections, parseFacts } from "@maycombhq/core";
import { applyPairHooks, pairLines, pairLoose } from "../src/apply-pair.js";
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
const wallets = [
  {
    repo: W,
    file: "apiproxy/targets/wallets.xml",
    line: 14,
    quote: '<Server name="wallets-fuse"/>',
  },
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
  { repo: LM, file: "deploy/prod.yaml", line: 2, quote: "host: ledger.prod.forge.example" },
];

/** The model's answer: the four true arrows, one wrong quote and one pairing to no candidate. */
const ANSWER = {
  pairs: [
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
      with: wallets,
    },
    {
      call: `${W} call.get.statement`,
      entry: `${LM} entry.get.statement`,
      callLine: flow(23, "/statements/*"),
      entryLine: camel(14, '<get uri="/{statementId}">'),
      with: ledger,
    },
    // Wrong: the ledger module has no limits route; the quote isn't on line 6.
    {
      call: `${W} call.put.limits`,
      entry: `${LM} entry.get.ledger-account`,
      callLine: flow(26, "/accounts/*/limits"),
      entryLine: camel(6, '<put uri="/{accountId}/limits">'),
    },
    // Wrong: an entry no candidate repo has.
    {
      call: `${W} call.put.limits`,
      entry: "forge-edge-config entry.put.limits",
      callLine: flow(26, "/accounts/*/limits"),
      entryLine: { file: "env/prod/targetservers.json", line: 2, quote: '"name": "wallets-fuse"' },
    },
  ],
  none: [`${W} call.put.limits`],
};

let root: string;
let prompts: string[];
const runner: AcpStepRunner = async (s) => {
  prompts.push(s.line);
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

describe("Apply pairs what the join left loose (ADR 0210 part 4)", () => {
  it("draws the pairings both of whose sides check as the AI's, drops the rest and lists them", async () => {
    const r = await pairLoose(root, { runner });
    expect(prompts).toHaveLength(1);
    // Every candidate repo's entries in the one request.
    expect(prompts[0]).toContain(`${WM} entry.get.account`);
    expect(prompts[0]).toContain(`${LM} entry.get.ledger-account`);
    expect(r.paired.map((p) => p.call).sort()).toEqual([
      `${W} call.get.account`,
      `${W} call.get.holds`,
      `${W} call.get.statement`,
      `${W} call.post.accounts`,
    ]);
    expect(r.dropped).toHaveLength(2);
    expect(r.dropped.map((d) => d.why).join("\n")).toMatch(/quote/);
    expect(r.dropped.map((d) => d.why).join("\n")).toMatch(/candidate/);
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
    // One batch, Undo's and Decided by AI's.
    const b = (await listBatches(root)).batches;
    expect(b).toHaveLength(1);
    expect(b[0]!.applied).toHaveLength(4);
    expect(pairLines(r)).toEqual([
      "Paired 4 calls; 1 left loose.",
      expect.stringMatching(/^ {2}Dropped .*call\.put\.limits/),
      expect.stringMatching(/^ {2}Dropped .*call\.put\.limits/),
      `  Left loose: ${W} call.put.limits`,
    ]);
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
    const sent = (/## The calls[\s\S]*?## The entries/.exec(prompts[1]!) ?? [""])[0];
    expect(sent).toContain("call.get.statement");
    expect(sent).toContain("call.put.limits");
    expect(sent).not.toContain("call.get.account");
    expect(sent).not.toContain("call.post.accounts");
    expect(sent).not.toContain("call.get.holds");
    expect(r.paired.map((p) => p.call)).toEqual([`${W} call.get.statement`]);
    // The old line went with the new: one line a call.
    expect(await lines()).toHaveLength(4);
  });

  it("a person's move of an AI arrow is kept on the next Apply", async () => {
    await pairLoose(root, { runner });
    const ai = (await lines()).find((l) => l.fact === "call.get.account")!;
    await appendFile(
      join(root, `facts/${W}.corrections.jsonl`),
      JSON.stringify({
        schemaVersion: 2,
        fact: ai.fact,
        target: ai.target,
        action: "link",
        link: {
          repo: LM,
          entry: "entry.get.ledger-account",
          method: "GET",
          path: "/cxf/api/accounts/{accountId}",
        },
        by: "pat@forge.example",
        at: "2099-01-01T00:00:00.000Z",
      }) + "\n",
    );
    await appendFile(join(root, "workspace", WM, CAMEL), "<!-- touched -->\n");
    await pairLoose(root, { runner });
    expect(prompts).toHaveLength(2);
    expect(/## The calls[\s\S]*?## The entries/.exec(prompts[1]!)![0]).not.toContain(
      "call.get.account",
    );
    const facts = await proxyCalls();
    const newest = linksFor(
      facts.find((f) => f.id === "call.get.account")!,
      await lines(),
    )[0]!;
    expect(newest.by).toBe("pat@forge.example");
    expect(newest.link?.repo).toBe(LM);
  });

  it.each([
    ["AI off", ["ai: off"], /AI is off/],
    ["apply.pair off", ["apply: { pair: off }"], /apply\.pair/],
    ["the budget spent", ["budgets: { limits: [{ per: run, tokens: 1 }] }"], /budget|would pass/i],
    ["no runtime that may decide", [], /copilot-acp/],
  ])("%s: nothing is sent, the calls stay listed, nothing fails", async (_, more, why) => {
    const rt = more.length
      ? RUNTIME(more)
      : RUNTIME().replace(
          "[hand-off, copilot-acp], default: copilot-acp",
          "[hand-off], default: hand-off",
        );
    await writeFile(join(root, "org-pack/runtime.yaml"), rt);
    const r = await pairLoose(root, { runner });
    expect(prompts).toEqual([]);
    expect(r.paired).toEqual([]);
    expect(r.loose).toHaveLength(5);
    expect(r.why).toMatch(why);
    expect(pairLines(r)[0]).toBe("Paired 0 calls; 5 left loose.");
    expect(await lines()).toEqual([]);
  });

  it("hand-off with apply.pair on: the calls become one prompt for the person's assistant", async () => {
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      RUNTIME(["apply: { pair: on }"]).replace(
        "[hand-off, copilot-acp], default: copilot-acp",
        "[hand-off], default: hand-off",
      ),
    );
    const r = await pairLoose(root, { runner });
    expect(prompts).toEqual([]);
    expect(r.prompt).toBe("proposals/matching/apply-pairs.md");
    const text = await readFile(join(root, r.prompt!), "utf8");
    for (const [id] of CALLS) expect(text).toContain(id);
    expect(r.loose).toHaveLength(5);
  });

  it("Apply says its line after the write, and draws the arrows", async () => {
    applyPairHooks.runner = runner;
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
    // The arrows are in the catalog, marked as the AI's.
    const { readdir } = await import("node:fs/promises");
    const dir = join(root, "catalog/generated/interface");
    const texts = await Promise.all(
      (await readdir(dir)).map((n) => readFile(join(dir, n), "utf8")),
    );
    const ai = texts.filter((t) => t.includes("joined-by-ai"));
    expect(ai).toHaveLength(4);
  });
});
