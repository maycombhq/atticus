import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HOSTS_OUTSIDE_VENDOR,
  HOSTS_STEP,
  JOIN_IGNORE_LABEL,
  listQuestions,
  NO_TARGET,
  parseFacts,
  readQuestion,
  roleOfQuestion,
  TARGETS_STEP_ID,
  type Question,
} from "@maycombhq/core";
import { projectFactsIntoCatalog } from "../src/map-render-commands.js";
import { questionsFiles } from "../src/question-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.24 review: the estate join's questions (a host nothing resolves, several entries that
 * could answer a call) are question files, not only a count: a gateway's forwarding call to a
 * token target URL no file sets is asked with the hint to read the gateway repo again; a host in
 * no-one's domain is a hosts question; two proxies on one BasePath make a targets question whose
 * options are the two entries, each with its line. Each offers Ignore, is asked once, is honoured
 * by the next write, and retires once the join no longer asks it. On the invented Forge estate of
 * fixtures/gateway-facts/join-questions; files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "join-questions");
const COMMIT: Record<string, string> = {
  "forge-fx-v1": "7777aaa",
  "forge-fx-v1-canary": "6666aaa",
  "northwind_rates_1-0": "9999aaa",
  "forge-teller": "5555aaa",
};
const PROXY = "northwind_rates_1-0";
const TELLER = "forge-teller";
const AT = new Date("2026-11-10T10:00:00.000Z");
const TOKEN = "@targetVendorUrl@";
const AMBIGUOUS =
  "Which repo or system answers GET /forge/fx/v1/rates, which forge-teller calls through fx.gateway-url?";
const CACHE = "Which repo answers on rates-cache:8080?";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-join-questions-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  return root;
}

async function verify(root: string, repo: string): Promise<string[]> {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
  return out;
}

async function verifyAll(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of Object.keys(COMMIT)) out.push(...(await verify(root, r)));
  return out;
}

async function answer(root: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await questionsFiles(
    root,
    ["questions", "answer", ...args, "--by", "pat"],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { now: AT },
  );
  expect(code, err.join("\n")).toBe(0);
  return out;
}

const option = (q: Question, label: string) => {
  const i = q.options.findIndex((o) => o.label === label);
  expect(i, `${label} in ${q.options.map((o) => o.label).join(" | ")}`).toBeGreaterThanOrEqual(0);
  return String(i + 1);
};

async function asked(root: string) {
  const qs = (await listQuestions(root)).questions;
  return {
    all: qs,
    token: qs.find((q) => q.askedBy.step === TARGETS_STEP_ID && q.question.includes(TOKEN)),
    ambiguous: qs.find((q) => q.question === AMBIGUOUS),
    cache: qs.find((q) => q.askedBy.step === HOSTS_STEP && q.question === CACHE),
  };
}

async function joinOf(root: string, repo: string) {
  const facts = parseFacts(readFileSync(join(root, "facts", `${repo}.jsonl`), "utf8"));
  if (!facts.ok) throw new Error("facts don't parse");
  return projectFactsIntoCatalog(root, repo, facts.facts);
}

describe("the join's questions are question files (beta.24 review)", () => {
  it("asks each once, in the join's words, with its candidates and Ignore", async () => {
    const root = metarepo();
    const out = (await verifyAll(root)).join("\n");
    const { all, token, ambiguous, cache } = await asked(root);

    // A gateway's token target URL: a targets question with the hint to read the repo again.
    expect(token?.state).toBe("open");
    expect(token!.repo).toBe(PROXY);
    expect(token!.question).toMatch(/^Which repo answers on @targetVendorUrl@\? /);
    expect(token!.question).toMatch(/read northwind_rates_1-0 again with your assistant/);
    expect(token!.evidence).toEqual(["apiproxy/proxies/default.xml:4"]);
    expect(token!.options.map((o) => o.label)).toEqual([
      "forge-fx-v1",
      "forge-fx-v1-canary",
      "An outside system (new): another team's",
      HOSTS_OUTSIDE_VENDOR,
      "None of these",
      JOIN_IGNORE_LABEL,
    ]);
    expect(out).toMatch(/A call goes to @targetVendorUrl@, a token no fact sets: asked q-/);
    // Never a hosts question about a "host" read out of the token.
    expect(all.filter((q) => q.askedBy.step === HOSTS_STEP).map((q) => q.question)).toEqual([
      CACHE,
    ]);

    // Two proxies on one BasePath: the two entries, each with its line, then Ignore.
    expect(ambiguous?.state).toBe("open");
    expect(ambiguous!.askedBy.step).toBe(TARGETS_STEP_ID);
    const labels = ambiguous!.options.map((o) => o.label);
    expect(labels.slice(0, 2)).toEqual(["fx-v1-canary-proxy", "fx-v1-proxy"]);
    expect(labels).not.toContain("northwind-rates-proxy");
    for (const o of ambiguous!.options.slice(0, 2))
      expect(o.means).toMatch(/serves the call \(apiproxy\/proxies\/default\.xml:4\)/);
    expect(labels.at(-1)).toBe(JOIN_IGNORE_LABEL);

    // A host in no-one's domain: a hosts question, Ignore offered from the start.
    expect(cache?.state).toBe("open");
    expect(cache!.options.at(-1)!.label).toBe(JOIN_IGNORE_LABEL);

    // Routed as every other question about where calls go: by the step, as hosts and targets are.
    expect(roleOfQuestion(token!)).toBe(roleOfQuestion(ambiguous!));
    expect(roleOfQuestion(token!)).toBe(roleOfQuestion(cache!));

    // A rerun asks nothing again.
    const again = (await verifyAll(root)).join("\n");
    expect(again).not.toMatch(/asked q-/i);
    const now = (await listQuestions(root)).questions;
    expect(now.map((q) => q.id).sort()).toEqual(all.map((q) => q.id).sort());
    expect(now.every((q) => q.state === "open")).toBe(true);
  }, 60_000);

  it("honours the answers on the next write: a system named, a candidate chosen, Ignore", async () => {
    const root = metarepo();
    await verifyAll(root);
    const { token, ambiguous, cache } = await asked(root);

    await answer(root, [token!.id, "--option", option(token!, HOSTS_OUTSIDE_VENDOR)]);
    await answer(root, [ambiguous!.id, "--option", option(ambiguous!, "fx-v1-proxy")]);
    await answer(root, [cache!.id, "--ignore", "--reason", "a local test cache"]);
    // The vendor named by the token went into the profile, for review.
    const profile = readFileSync(
      join(root, "org-pack", "profiles", "forge", "profile.yaml"),
      "utf8",
    );
    expect(profile).toMatch(/id: targetvendorurl/);
    expect(profile).toMatch(/boundary: vendor/);

    await verify(root, PROXY);
    await verify(root, TELLER);

    const proxy = (await joinOf(root, PROXY)).result.join!;
    expect(proxy.asks).toEqual([]);
    expect(proxy.outside).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ fact: "call.get.quotes-id" }),
        target: "targetvendorurl",
      }),
    ]);

    const teller = await joinOf(root, TELLER);
    const tj = teller.result.join!;
    expect(tj.asks.filter((a) => a.call.repo === TELLER)).toEqual([]);
    const rates = tj.joins.filter((j) => j.call.fact === "call.get.forge-fx-v1-rates");
    expect(rates.map((j) => [j.entry.repo, j.how])).toEqual([["forge-fx-v1", "answer"]]);
    // Ignore: the join leaves the cache call, answered none, and draws nothing for it.
    expect(teller.targets["call.get.cache-key"]).toBe(NO_TARGET);
    expect(tj.joins.some((j) => j.call.fact === "call.get.cache-key")).toBe(false);
    expect((tj.outside ?? []).some((o) => o.call.fact === "call.get.cache-key")).toBe(false);

    // Answered questions stay answered, and nothing is asked again.
    for (const q of [token!, ambiguous!, cache!])
      expect((await readQuestion(root, q.id))!.state).toBe("answered");
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
  }, 60_000);

  it("Ignore on the token's question leaves its calls", async () => {
    const root = metarepo();
    await verifyAll(root);
    const { token } = await asked(root);
    await answer(root, [token!.id, "--ignore"]);
    await verify(root, PROXY);
    const p = await joinOf(root, PROXY);
    expect(p.targets["call.get.quotes-id"]).toBe(NO_TARGET);
    expect(p.result.join!.asks).toEqual([]);
    expect(p.result.join!.outside ?? []).toEqual([]);
  }, 60_000);

  it("retires the token's open question once a read records the deploy file's values", async () => {
    const root = metarepo();
    await verifyAll(root);
    const { token } = await asked(root);
    // The assistant reads the proxy again: the config plugin's config.json sets the token.
    cpSync(
      join(FIX, "reread", "repos", PROXY, "config.json"),
      join(root, "workspace", PROXY, "config.json"),
    );
    writeFileSync(
      join(root, "facts", `${PROXY}.jsonl`),
      readFileSync(join(FIX, "reread", `${PROXY}.jsonl`), "utf8"),
    );
    const out = (await verify(root, PROXY)).join("\n");
    const q = (await readQuestion(root, token!.id))!;
    expect(q.state).toBe("retired");
    expect(q.retired!.why).toMatch(
      /^the join no longer asks about @targetVendorUrl@: the call goes to /,
    );
    expect(out).toContain(`Retired ${token!.id}`);
  }, 60_000);
});
