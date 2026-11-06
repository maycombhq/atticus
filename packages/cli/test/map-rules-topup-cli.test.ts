import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { FACT_RULES_HASH, RULE_SETS, rulesNow } from "@maycombhq/assistant-files";
import { doctorCounts } from "../src/doctor-counts.js";
import { estateFresh, estateFreshness } from "../src/estate-fresh.js";
import { mapAllCommand, preparedLine, type Clock, type MapAllPlan } from "../src/map-all.js";
import { mapCommand } from "../src/map-commands.js";
import { loadReadPlan } from "../src/map-parts.js";
import { main } from "../src/main.js";
import { nextSteps, readNextState } from "../src/next-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0167: a repo read before beta.11's reading rules (no rules recorded with its read) is in a
 * state of its own, `rules-changed`, and `atticus map --all --stale` (and plain --all) tops it up:
 * a fresh session per part given only the rule sets its read lacked, the files those sets apply
 * to and the facts kept by id. Once verified, the read records the rules it now has, and the repo
 * is fresh again. On the invented Forge estates (fixtures/link-estate, the ledger); files only,
 * no network.
 */

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const LINK = join(FIXTURES, "link-estate");
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const SHA = (c: string) => c.repeat(40).slice(0, 40);
const LIMIT = 100_000;
const T = 120_000;
const BETA11 = ["field-types", "mappings", "message-types", "terms", "call-auth"];

const temps: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-map-rules-${name}-`));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const io = () => {
  const out: string[] = [];
  return {
    out,
    text: () => out.join("\n"),
    io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) },
  };
};

function fakeClock(onTick: (minutes: number) => Promise<void> | void = () => {}): Clock {
  let t = Date.parse("2026-11-02T09:00:00Z");
  const start = t;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await onTick((t - start) / 60_000);
    },
  };
}

const LINK_REPOS = [
  "forge-portal-bff",
  "forge-proxy-accounts-v1",
  "forge-proxy-payments-v1",
  "forge-proxy-northwind-v1",
  "forge-accounts",
  "forge-payments",
  "forge-cards",
  "forge-notifications",
  "forge-starter",
  "forge-deploy-config",
];

/** The link estate as a metarepo, every repo cloned at SHA("a") and read at it, no rules recorded. */
function linkEstate() {
  const root = temp("link");
  cpSync(join(LINK, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const id of LINK_REPOS) {
    cpSync(join(LINK, "repos", id), join(root, "workspace", id), { recursive: true });
    write(root, `workspace/${id}/.git/HEAD`, `${SHA("a")}\n`);
    write(
      root,
      `facts/${id}.jsonl`,
      readFileSync(join(LINK, "facts", `${id}.jsonl`), "utf8").replace(
        /"commit":"[0-9a-f]+"/g,
        `"commit":"${SHA("a")}"`,
      ),
    );
  }
  return root;
}

/** A read plan recording the rules a read was given (ADR 0167). */
const recordRules = (root: string, repo: string, rules: { hash: string; sets: string[] }) =>
  write(
    root,
    `facts/${repo}.read-plan.yaml`,
    stringify({
      schemaVersion: 2,
      repo,
      commit: SHA("a"),
      session: 45000,
      plannedAt: "2026-10-30T10:00:00Z",
      parts: [],
      rules,
    }),
  );

const dryRun = async (root: string, more: Parameters<typeof mapAllCommand>[1] = {}) => {
  const o = io();
  const code = await mapAllCommand(
    root,
    { dryRun: true, json: true, maxTokens: LIMIT, mode: "copilot", ...more },
    o.io,
  );
  expect(code, o.text()).toBe(0);
  return JSON.parse(o.text()) as MapAllPlan;
};

describe("map --all --stale tops up repos read under older rules (ADR 0167)", () => {
  it(
    "plans a top-up per repo read with no rules recorded: the sets it lacked, the files they apply to",
    async () => {
      const root = linkEstate();
      const plan = await dryRun(root, { stale: true });
      expect(plan.items.map((i) => i.kind)).toEqual(LINK_REPOS.map(() => "rules"));
      expect(plan.items.map((i) => i.repo).sort()).toEqual([...LINK_REPOS].sort());
      expect(plan.skipped).toEqual([]);
      const of = (repo: string) => plan.items.find((i) => i.repo === repo)!;
      // A service: its controller and clients for the fields, message types and a call's auth,
      // its settings for terms and a call's TLS; no gateway policy, so no mappings.
      expect(of("forge-accounts")).toMatchObject({
        sets: ["field-types", "message-types", "terms", "call-auth"],
        total: 1,
      });
      expect(of("forge-accounts").parts[0]!.paths).toEqual([
        "src/main/resources/application.yml",
        "src/main/java/forge/accounts/AccountsController.java",
        "src/main/java/forge/accounts/AuditClient.java",
        "src/main/java/forge/accounts/NotifyClient.java",
      ]);
      // A gateway's proxy: its policies for mappings, its config for terms and auth; no DTOs.
      expect(of("forge-proxy-accounts-v1")).toMatchObject({
        sets: ["mappings", "terms", "call-auth"],
      });
      expect(of("forge-proxy-accounts-v1").parts[0]!.paths).toEqual([
        "apiproxy/forge-accounts-v1.xml",
        "apiproxy/proxies/default.xml",
        "apiproxy/targets/accounts.xml",
      ]);
      // A deploy repo: no code, so terms and auth only.
      expect(of("forge-deploy-config").sets).toEqual(["terms", "call-auth"]);
      expect(of("forge-accounts").why).toBe(
        "read before these reading rules: field-types, message-types, terms, call-auth",
      );
      // Plain --all plans the same.
      const all = await dryRun(root);
      expect(all.items.map((i) => [i.repo, i.kind]).sort()).toEqual(
        plan.items.map((i) => [i.repo, i.kind]).sort(),
      );
      // The words.
      const o = io();
      await mapAllCommand(
        root,
        { dryRun: true, stale: true, maxTokens: LIMIT, mode: "copilot" },
        o.io,
      );
      expect(o.text()).toMatch(
        /forge-accounts: top-up for the reading rules added since it was read \(field-types, message-types, terms, call-auth\); 1 part, about [\d,]+ tokens\./,
      );
    },
    T,
  );

  it("skips a repo read under the current rules, and tops up only the sets a recorded read lacks", async () => {
    const root = linkEstate();
    recordRules(root, "forge-accounts", rulesNow());
    recordRules(root, "forge-cards", {
      hash: "0".repeat(64),
      sets: ["field-types", "mappings", "message-types", "terms"],
    });
    const plan = await dryRun(root, { stale: true });
    expect(plan.skipped).toContainEqual({ repo: "forge-accounts", why: "fresh" });
    expect(plan.items.find((i) => i.repo === "forge-cards")).toMatchObject({
      kind: "rules",
      sets: ["call-auth"],
    });
    expect((await dryRun(root)).skipped).toContainEqual({
      repo: "forge-accounts",
      why: "read and fresh",
    });
  });
});

describe("an organisation's reading rule tops up only the files it names (ADR 0176)", () => {
  it("plans a top-up of the rule's files for a repo read before it, and none once recorded", async () => {
    const root = linkEstate();
    recordRules(root, "forge-cards", rulesNow());
    recordRules(root, "forge-accounts", rulesNow());
    write(
      root,
      "org-pack/reading-rules/types/spring-boot.yaml",
      [
        "schemaVersion: 1",
        "rules:",
        "  - key: controller-paths",
        "    rule: \"A controller's class-level @RequestMapping is part of every route's path.\"",
        '    files: ["src/main/java/**/*Controller.java"]',
        "",
      ].join("\n"),
    );
    const plan = await dryRun(root, { stale: true });
    const cards = plan.items.find((i) => i.repo === "forge-cards");
    expect(cards).toMatchObject({ kind: "rules" });
    expect(cards!.sets![0]).toMatch(/^org:controller-paths@[0-9a-f]{8}$/);
    expect(cards!.parts.flatMap((p) => p.paths)).toEqual([
      "src/main/java/forge/cards/CardsController.java",
    ]);
    // Once a read records the rule's id, nothing is lacking.
    recordRules(root, "forge-cards", {
      ...rulesNow(),
      sets: [...rulesNow().sets, cards!.sets![0]!],
    });
    const again = await dryRun(root, { stale: true });
    expect(again.items.find((i) => i.repo === "forge-cards")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the ledger (real git, local)

function gitIn(dir: string) {
  return (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();
}

/** The Forge ledger cloned with git, its facts read at its first commit with no rules recorded. */
function ledgerEstate(o: { move?: boolean } = {}) {
  const root = temp("ledger");
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  const dir = join(root, "workspace", "forge-ledger");
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
  const git = gitIn(dir);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  if (o.move) {
    const p = join(dir, "src/main/java/forge/ledger/AccountController.java");
    writeFileSync(p, `// moved on\n${readFileSync(p, "utf8")}`);
    git("commit", "-q", "-am", "two");
  }
  write(
    root,
    "facts/forge-ledger.jsonl",
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
      '"commit":"0123abc"',
      `"commit":"${one}"`,
    ),
  );
  return { root, dir, one, head: git("rev-parse", "HEAD") };
}

const quiet = { out: () => {}, err: () => {} };

describe("the ledger's rules state and its top-up (ADR 0167)", () => {
  it(
    "a moved clone still gets its re-read, not a top-up",
    async () => {
      const { root } = ledgerEstate({ move: true });
      const plan = await dryRun(root, { stale: true });
      expect(plan.items.map((i) => [i.repo, i.kind])).toEqual([["forge-ledger", "reread"]]);
    },
    T,
  );

  it(
    "estate fresh says rules-changed and its command; doctor --counts counts it; next gives the top-up",
    async () => {
      const { root } = ledgerEstate();
      const v = await estateFreshness(root);
      expect(v.repos[0]).toMatchObject({
        repo: "forge-ledger",
        state: "rules-changed",
        rulesLacking: BETA11,
        command: "atticus map forge-ledger --rules",
        slash: "/atticus-map forge-ledger --rules",
      });
      const o = io();
      await estateFresh(root, {}, o.io);
      expect(o.text()).toContain(
        "  forge-ledger: Its facts are of the clone's commit, but it was read before these reading rules: field-types, mappings, message-types, terms, call-auth. A top-up reads only the files they apply to.",
      );
      expect(o.text()).toMatch(/forge-ledger +rules-changed .* atticus map forge-ledger --rules/);
      const c = await doctorCounts(root);
      expect(c.repos.byState["rules-changed"]).toBe(1);
      const steps = nextSteps(await readNextState(root));
      const s = steps.find((x) => x.step === "rules");
      expect(s).toMatchObject({
        command: "atticus map forge-ledger --rules",
        slash: "/atticus-map forge-ledger --rules",
        repo: "forge-ledger",
      });
    },
    T,
  );

  it(
    "atticus map <repo> --rules writes the top-up prompt; once verified the read records the rules and is fresh",
    async () => {
      const { root, head } = ledgerEstate();
      const o = io();
      expect(await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT }, o.io)).toBe(
        0,
      );
      expect(o.text()).toMatch(
        /^Top-up of forge-ledger for the reading rules added since it was read \(field-types, mappings, message-types, terms, call-auth\): \d+ files?, about [\d,]+ tokens, in 1 session/m,
      );
      const prompt = readFileSync(join(root, "facts", "forge-ledger.rules.md"), "utf8");
      expect(prompt).toContain(`# Top-up of forge-ledger at ${head}`);
      expect(prompt).toContain("This is a top-up (ADR 0167)");
      // beta.16: where the paths are, so the reader needn't look for the checkout.
      expect(prompt).toMatch(
        /The paths are in the repo's checkout, `[^`]*forge-ledger` in this metarepo/,
      );
      // Only the sets it lacked: the term rule is there, an older rule isn't.
      expect(prompt).toContain("A `term` fact is an identifier");
      expect(prompt).not.toContain("A config fact is a setting the running code depends on");
      // The files they apply to, as data; the facts kept, by id.
      expect(prompt).toContain("<atticus-data");
      expect(prompt).toContain("`src/main/java/forge/ledger/EntryRequest.java`");
      expect(prompt).not.toContain("`src/main/resources/db/migration/V2__create_entry.sql`");
      expect(prompt).toMatch(/Facts already kept \(by id; don't write them again\)/);
      // Given again until verified: the same session.
      const again = io();
      await mapCommand(
        root,
        "forge-ledger",
        { rules: true, maxTokens: LIMIT, json: true },
        again.io,
      );
      expect(JSON.parse(again.text())).toMatchObject({ session: 1, sessions: 1 });
      expect((await loadReadPlan(root, "forge-ledger"))?.rules).toBeUndefined();
      // The reader verifies: the read now records the rules, and the repo is fresh.
      expect(await verifyCommand(root, "forge-ledger", { commit: head, json: true }, quiet)).toBe(
        0,
      );
      const plan = await loadReadPlan(root, "forge-ledger");
      expect(plan?.rules).toEqual({ hash: FACT_RULES_HASH, sets: [...RULE_SETS] });
      expect(plan?.topUp).toBeUndefined();
      expect((await estateFreshness(root)).repos[0]!.state).toBe("fresh");
      const done = io();
      await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT }, done.io);
      expect(done.text()).toContain(
        "forge-ledger was read under the reading rules there are now: nothing to top up.",
      );
    },
    T,
  );

  it(
    "plans what is left again when another --models is asked for, keeping the sessions done (beta.15)",
    async () => {
      const { root } = ledgerEstate();
      await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT, json: true }, quiet);
      const first = (await loadReadPlan(root, "forge-ledger"))!.topUp!;
      expect(first.models).toBeUndefined();
      // The same --models (or none) keeps the top-up under way.
      await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT, json: true }, quiet);
      expect((await loadReadPlan(root, "forge-ledger"))!.topUp!.plannedAt).toBe(first.plannedAt);
      // Another plans it again under that one.
      await mapCommand(
        root,
        "forge-ledger",
        { rules: true, maxTokens: LIMIT, json: true, models: "all" },
        quiet,
      );
      const again = (await loadReadPlan(root, "forge-ledger"))!.topUp!;
      expect(again.models).toBe("all");
      expect(again.sessions.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "counts a top-up session done only once something was written for it (beta.17)",
    async () => {
      const { root, head } = ledgerEstate();
      // As map --all has it: verified before the session is given.
      await verifyCommand(root, "forge-ledger", { commit: head, json: true }, quiet);
      await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT, json: true }, quiet);
      // The session stopped over a refusal: nothing written since it was given.
      await verifyCommand(root, "forge-ledger", { commit: head, json: true }, quiet);
      let plan = await loadReadPlan(root, "forge-ledger");
      expect(plan?.topUp?.sessions[0]?.done).toBeUndefined();
      expect(plan?.rules).toBeUndefined();
      // Given again, and this time it says a file has nothing to add: done.
      await mapCommand(root, "forge-ledger", { rules: true, maxTokens: LIMIT, json: true }, quiet);
      const path = plan!.topUp!.sessions[0]!.paths[0]!.replace(/#L.*$/, "");
      appendFileSync(
        join(root, "facts", "forge-ledger.reviewed.jsonl"),
        `${JSON.stringify({ path, why: "nothing to add under these rules" })}\n`,
      );
      await verifyCommand(root, "forge-ledger", { commit: head, json: true }, quiet);
      plan = await loadReadPlan(root, "forge-ledger");
      expect(plan?.rules?.hash).toBe(FACT_RULES_HASH);
    },
    T,
  );

  it(
    "runs from the command line: atticus map <repo> --rules",
    async () => {
      const { root } = ledgerEstate();
      const out: string[] = [];
      const code = await main(
        ["map", "forge-ledger", "--rules", "--max-tokens", "100000", "--root", root],
        { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
        { quiet: true },
      );
      expect(code, out.join("\n")).toBe(0);
      expect(existsSync(join(root, "facts", "forge-ledger.rules.md"))).toBe(true);
    },
    T,
  );

  it(
    "under Copilot: one pasted line per part, waited for, verified; the hash recorded",
    async () => {
      const { root, head } = ledgerEstate();
      const clock = fakeClock(async (m) => {
        if (m === 2) {
          // Copilot reads the prompt Atticus wrote (beta.15: it runs no atticus map), then (nothing
          // to add) its own verify.
          expect(existsSync(join(root, "facts", "forge-ledger.rules.md"))).toBe(true);
          await verifyCommand(root, "forge-ledger", { commit: head, json: true }, quiet);
        }
      });
      const copied: string[] = [];
      const o = io();
      await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot", stale: true }, o.io, {
        clock,
        clipboard: async (t) => {
          copied.push(t);
          return true;
        },
        pollMs: 60_000,
        remindMs: 10 * 60_000,
      });
      const text = o.text();
      expect(copied).toEqual([preparedLine("forge-ledger", "facts/forge-ledger.rules.md")]);
      expect(copied[0]).toContain("run no other atticus command (not assistant-files, not map)");
      expect(text).toContain("===== forge-ledger, the rules top-up (repo 1 of 1) =====");
      expect(text).toMatch(/Done: 1 repo read, 1 part/);
      expect((await loadReadPlan(root, "forge-ledger"))?.rules?.hash).toBe(FACT_RULES_HASH);
      expect((await dryRun(root, { stale: true })).skipped).toContainEqual({
        repo: "forge-ledger",
        why: "fresh",
      });
    },
    T,
  );

  it(
    "in model mode: the batches carry only the new rule parts, and the hash is recorded",
    async () => {
      const { root } = ledgerEstate();
      const prompts: string[] = [];
      const runtime = new MockRuntime(
        (r) => {
          prompts.push(r.pack.prompt);
          return "";
        },
        { now: () => new Date("2026-11-02T09:00:00.000Z") },
      );
      const o = io();
      await mapAllCommand(root, { maxTokens: LIMIT, mode: "model", stale: true }, o.io, {
        clock: fakeClock(),
        runtime,
      });
      expect(o.text()).toMatch(/===== forge-ledger \(repo 1 of 1\): topping up on the model/);
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) {
        expect(p).toContain("This is a top-up (ADR 0167)");
        expect(p).not.toContain("A config fact is a setting the running code depends on");
      }
      expect((await loadReadPlan(root, "forge-ledger"))?.rules?.hash).toBe(FACT_RULES_HASH);
      expect((await estateFreshness(root)).repos[0]!.state).toBe("fresh");
    },
    T,
  );
});
