import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listQuestions, readQuestion, type Question } from "@maycombhq/core";
import { questionsFiles } from "../src/question-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.12 (ADR 0168): the target questions a real estate's gateway proxy and its callers raised
 * before beta.11, one per call and every option worded "<repo> answers <call>", are put right on
 * the next verify --write. An open question asked again takes today's ranked options in place
 * (the same id, its history kept); one whose calls a group asks now (Q1: a proxy's routes by the
 * TargetServer they forward through and their path prefix) retires, naming the group; one an
 * answered rule covers retires, naming the rule; an answered one is never touched. Several open
 * questions sharing a prefix offer the rule that answers them all. On the invented Forge estate of
 * fixtures/link-estate/gateway-questions; files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate", "gateway-questions");
const COMMIT: Record<string, string> = {
  "forge-ledger-core": "e5e0001",
  "forge-card-vault": "f6f0001",
  "forge-proxy-core-v1": "d4d0001",
  "forge-teller-app": "a7a0001",
};
const PROXY = "forge-proxy-core-v1";
const TELLER = "forge-teller-app";
const AT = new Date("2026-11-02T10:00:00.000Z");

/** The old questions on file (fixtures/link-estate/gateway-questions/questions). */
const OLD = {
  getAccount: "q-848df3a174aa",
  putAccount: "q-65f2e458d42d",
  putStatus: "q-977303dcd756",
  getPin: "q-e46492df321a", // answered
  putPin: "q-c1a79cc23ea0",
  postings: "q-95d4b60a5cd0",
  tellerStatus: "q-5658d5bfa1b2",
  tellerRename: "q-61959a7015a0",
};

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The estate as a metarepo with the old questions on file; no repo verified yet. */
function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-gateway-questions-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(FIX, "questions"), join(root, "questions"), { recursive: true });
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

async function questions(root: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await questionsFiles(
    root,
    ["questions", ...args],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { now: AT },
  );
  return { code, out, err };
}

const q = async (root: string, id: string) => (await readQuestion(root, id))!;
const byWords = async (root: string, words: string) =>
  (await listQuestions(root)).questions.find((x) => x.question === words);
const suggested = (x: Question) =>
  x.options.filter(
    (o) =>
      ![
        "Another repo…",
        "Not all to one place",
        "None of these",
        "Ignore: not a real call (e.g. CI/CD, a test, a template)",
      ].includes(o.label),
  );

describe("old-shape target questions on a gateway estate (beta.12, ADR 0168)", () => {
  it("offers one rule for the open questions that share a path prefix, before any write", async () => {
    const root = metarepo();
    const shown = await questions(root, ["show", OLD.putAccount]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(
      `  Answer once for all 3: atticus questions answer ${OLD.putAccount} --option <n> --match "/accounts/**" covers the 3 calls of these 3 questions, and the other 2 retire on the next verify --write (${OLD.getAccount}, ${OLD.putStatus}).`,
    );
    const json = await questions(root, ["show", OLD.tellerRename, "--json"]);
    expect(JSON.parse(json.out.join("\n")).rule).toEqual({
      match: "/forge/**",
      ids: [OLD.tellerStatus, OLD.tellerRename].sort(),
      calls: 2,
    });
    // The pin questions share /cards, but one is answered: nothing to offer.
    const list = await questions(root, ["list", "--json"]);
    const about = JSON.parse(list.out.join("\n")).about as Record<string, { rule?: unknown }>;
    expect(about[OLD.putPin]!.rule).toBeUndefined();
    expect(about[OLD.postings]!.rule).toBeUndefined();
    expect(about[OLD.getPin]!.rule).toBeUndefined();
  });

  it("refreshes, regroups and retires the proxy's questions, and leaves the answered one", async () => {
    const root = metarepo();
    const answered = readFileSync(join(root, "questions", `${OLD.getPin}.yaml`), "utf8");
    await verify(root, "forge-ledger-core");
    await verify(root, "forge-card-vault");
    const lines = await verify(root, PROXY);

    // One question for the routes under /accounts that the proxy forwards to its TargetServer.
    const group = (await byWords(
      root,
      "Which repo serves the routes under /accounts/** that forge-core-v1 forwards to core-backend?",
    ))!;
    expect(group.state).toBe("open");
    expect(group.evidence).toEqual([
      "apiproxy/proxies/default.xml:4",
      "apiproxy/proxies/default.xml:7",
      "apiproxy/proxies/default.xml:10",
    ]);
    // The service whose entries serve the routes first, saying so once for all of them; at most
    // five suggestions, then Another repo…, Not all to one place and None of these.
    expect(group.options[0]).toMatchObject({ label: "ledger-core" });
    expect(group.options[0]!.means).toMatch(
      /^ledger-core, built in forge-ledger-core: serves GET \/accounts\/\{id\} and 2 more under \/accounts; /,
    );
    expect(suggested(group).length).toBeLessThanOrEqual(5);
    // Beta.24 review: and Ignore, offered from the start.
    expect(group.options.slice(-4).map((o) => o.label)).toEqual([
      "Another repo…",
      "Not all to one place",
      "None of these",
      "Ignore: not a real call (e.g. CI/CD, a test, a template)",
    ]);
    // No option claims a repo answers the calls; one with no evidence says so.
    for (const o of suggested(group)) expect(o.means).not.toMatch(/\banswers\b/);
    expect(group.options.find((o) => o.label === "northwind-pay")!.means).toBe(
      "Northwind Pay, an outside system: no evidence; listed so you can pick it",
    );
    // The earlier answer to the pin route is evidence, said as such.
    expect(group.options.find((o) => o.label === "card-vault")!.means).toBe(
      "card-vault, built in forge-card-vault: picked for 1 other call of forge-proxy-core-v1",
    );

    // The three per-call questions it asks now are retired, never deleted, naming it.
    for (const id of [OLD.getAccount, OLD.putAccount, OLD.putStatus]) {
      const old = await q(root, id);
      expect(old.state).toBe("retired");
      expect(old.retired!.replacedBy).toEqual([group.id]);
      expect(old.askedBy.at).toBe("2026-10-28T15:04:00.000Z");
    }

    // The /cards group is one call now (GET is answered): its old question takes today's
    // options in place, the same id and history, the earlier answer counting as evidence.
    const pin = await q(root, OLD.putPin);
    expect(pin.state).toBe("open");
    expect(pin.askedBy).toEqual({
      step: "facts-targets",
      command: "atticus verify forge-proxy-core-v1 --write",
      at: "2026-10-28T15:04:00.000Z",
    });
    expect(pin.options[0]!.label).toBe("card-vault");
    expect(pin.options[0]!.means).toMatch(
      /^card-vault, built in forge-card-vault: serves PUT \/cards\/\{id\}\/pin \(src\/main\/java\/forge\/vault\/CardPinController\.java:10\); /,
    );
    expect(pin.options[0]!.means).toContain("picked for 1 other call of forge-proxy-core-v1");
    expect(lines).toContain(
      `Refreshed 1 open question asked before (${OLD.putPin}): the same id, with today's options, ranked by the estate as read now, each saying why it is suggested.`,
    );
    // The answered question is not touched, byte for byte.
    expect(readFileSync(join(root, "questions", `${OLD.getPin}.yaml`), "utf8")).toBe(answered);
  });

  it("refreshes the client's question with a repo read since, and groups its gateway calls", async () => {
    const root = metarepo();
    for (const r of ["forge-ledger-core", "forge-card-vault", PROXY]) await verify(root, r);
    const lines = await verify(root, TELLER);

    // Asked when the ledger wasn't read: the ledger, whose entry serves it, is first now.
    const postings = await q(root, OLD.postings);
    expect(postings.state).toBe("open");
    expect(postings.options[0]!.label).toBe("ledger-core");
    expect(postings.options[0]!.means).toBe(
      "ledger-core, built in forge-ledger-core: serves POST /postings (src/main/java/forge/ledger/AccountsController.java:16)",
    );

    // The calls through the gateway's config key: one question, the proxy first, by its routes
    // and its BasePath.
    const group = (await byWords(
      root,
      "Which repo or system answers the calls forge-teller-app makes under /forge through core-gateway?",
    ))!;
    expect(group.options[0]!.label).toBe("proxy-core-v1");
    expect(group.options[0]!.means).toContain(
      "serves PUT /forge/core/v1/accounts/{id} and 1 more under /forge; its basePath /forge/core/v1 matches: its proxy's BasePath (forge-proxy-core-v1 apiproxy/forge-core-v1.xml:1)",
    );
    for (const id of [OLD.tellerStatus, OLD.tellerRename])
      expect((await q(root, id)).retired!.replacedBy).toEqual([group.id]);

    // The shared gateway host no repo lists: said once, with the one-time fix.
    const host = lines.find((l) => l.startsWith("Calls to api.forge.example join no repo"))!;
    expect(host).toContain(
      "forge-proxy-core-v1's routes serve the paths the calls to api.forge.example make, and no repo lists api.forge.example: it looks like a shared gateway's host. Once, not per call: list api.forge.example under hosts: on each proxy repo in repos.manifest.yaml (forge-proxy-core-v1, and any other proxy on it); the path then picks the proxy",
    );
    const hostQ = (await listQuestions(root, { step: "scan-hosts" })).questions[0]!;
    expect(hostQ.options[0]).toMatchObject({
      label: "forge-proxy-core-v1",
      means:
        "forge-proxy-core-v1 serves GET /forge/core/v1/cards/{id}/pin, a path the calls to api.forge.example make",
    });
  });

  it("retires the questions an answer's rule covers, keeping every answer", async () => {
    const root = metarepo();
    await verify(root, "forge-ledger-core");
    await verify(root, "forge-card-vault");
    const a = await questions(root, [
      "answer",
      OLD.getAccount,
      "--target",
      "ledger-core",
      "--match",
      "/accounts/**",
      "--by",
      "pat",
    ]);
    expect(a.code, a.err.join("\n")).toBe(0);
    await verify(root, PROXY);
    expect((await q(root, OLD.getAccount)).state).toBe("answered");
    for (const id of [OLD.putAccount, OLD.putStatus]) {
      const r = await q(root, id);
      expect(r.state).toBe("retired");
      expect(r.retired!.why).toMatch(
        new RegExp(`answered by rule in ${OLD.getAccount} \\(/accounts/\\*\\*\\)`),
      );
      expect(r.retired!.replacedBy).toEqual([OLD.getAccount]);
    }
    // No group is asked for calls the rule answers.
    expect(
      (await listQuestions(root, { state: "open", repo: PROXY })).questions.map((x) => x.id),
    ).toEqual([OLD.putPin]);
  });
});
