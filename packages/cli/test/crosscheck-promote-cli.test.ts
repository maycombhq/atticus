import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deserializeRecord, parseFactsLines } from "@maycombhq/core";
import { promotedFactId, promotedStates } from "@maycombhq/scanner";
import { main } from "../src/main.js";

/**
 * ADR 0195 point 3, ticket CS3: promote to assert. On the invented Forge estate, scanned with its
 * base clones, the ledger's facts hold one entry; the readers found two more, and an Interface
 * and the events the facts don't have. A person promotes one: Atticus writes it as their own fact
 * (`by: person`, `verified: none`, the reader's citation and the line's text) into
 * facts/forge-ledger.jsonl, in the facts file's own shape; `atticus verify` checks it on its line
 * (it is kept, `verified: line`); `verify --write` projects it, and the cross-check then agrees.
 * Inside a Copilot session the command is refused (a person's own word). No network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const T = 240_000;
const BALANCE = "Endpoint|GET /accounts/{}/balance";
const PAYMENTS = "Interface|ledger-api POST /v2/payments";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  )
    .toString()
    .trim();
}

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A command that builds, confirmed with the removals' count when its build asks for one. */
async function confirmed(argv: string[]) {
  const first = await run(argv);
  if (first.code === 0) return first;
  const n = /--allow-removals (\d+)/.exec(`${first.out}\n${first.err}`)?.[1];
  expect(n, `${first.out}\n${first.err}`).toBeDefined();
  return run([...argv, "--allow-removals", n!]);
}

let top: string;
let root: string;
let head: string;
const factsFile = () => join(root, "facts", "forge-ledger.jsonl");

beforeAll(async () => {
  top = await mkdtemp(join(tmpdir(), "atticus-promote-"));
  await cp(FORGE, top, { recursive: true });
  root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  const s = await run(["scan", "--no-drift"]);
  expect(s.code, s.err).toBe(0);
  head = git(join(root, "workspace", "forge-ledger"), "rev-parse", "HEAD");
  // What the assistant read: one entry, cited on its line.
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(
    factsFile(),
    JSON.stringify({
      kind: "entry",
      id: "e-post-transfer",
      repo: "forge-ledger",
      commit: head,
      component: "ledger-api",
      entryType: "rest",
      method: "POST",
      path: "/transfers",
      handler: "LedgerEndpoints.transfer",
      cite: {
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 11,
        value: "/transfers",
      },
    }) + "\n",
  );
  const v = await confirmed(["verify", "forge-ledger", "--write"]);
  expect(v.code, `${v.out}\n${v.err}`).toBe(0);
}, T);
afterAll(async () => {
  delete process.env.ATTICUS_ACP_SESSION;
  await rm(top, { recursive: true, force: true });
});

interface Items {
  repos: { repo: string; state: string; items: { key: string; state: string }[] }[];
}
const items = async () => {
  const r = await run(["catalog", "crosscheck", "forge-ledger", "--json"]);
  expect(r.code, r.err).toBe(0);
  return (JSON.parse(r.out) as Items).repos[0]!;
};

describe("atticus catalog crosscheck <repo> --promote <key> (ADR 0195 point 3)", () => {
  it(
    "writes a person's fact with the reader's citation, which verify finds on its line and --write projects",
    async () => {
      const before = await items();
      expect(before.state).toBe("compared");
      expect(before.items.find((i) => i.key === BALANCE)?.state).toBe("readers-only");
      const r = await run(["catalog", "crosscheck", "forge-ledger", "--promote", BALANCE]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/promoted Endpoint\|GET \/accounts\/\{\}\/balance to your own fact/);
      expect(r.out).toContain("LedgerEndpoints.java:8");
      const facts = parseFactsLines(await readFile(factsFile(), "utf8")).facts;
      const mine = facts.find((f) => f.id === promotedFactId(BALANCE))!;
      // The facts file's own shape (ADR 0124): a person's entry, not yet verified, cited on the
      // reader's line at the reader's commit, with the line's text as its quote.
      expect(mine).toMatchObject({
        kind: "entry",
        by: "person",
        verified: "none",
        repo: "forge-ledger",
        commit: head,
        component: "ledger-api",
        entryType: "rest",
        method: "GET",
        path: "/accounts/{id}/balance",
        cite: {
          file: "src/main/java/forge/ledger/LedgerEndpoints.java",
          line: 8,
          value: "/accounts/{id}/balance",
          quote: '@ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")',
        },
      });
      expect(facts.find((f) => f.id === "e-post-transfer")).toBeDefined();
      expect((await promotedStates(root, "forge-ledger", [BALANCE])).get(BALANCE)?.state).toBe(
        "written",
      );
      // Promoting it again writes nothing.
      const text = await readFile(factsFile(), "utf8");
      const again = await run(["catalog", "crosscheck", "forge-ledger", "--promote", BALANCE]);
      expect(again.code).toBe(0);
      expect(again.out).toMatch(/promoted already/);
      expect(await readFile(factsFile(), "utf8")).toBe(text);

      // The verifier checks it on its line, like any other fact.
      const v = await run(["verify", "forge-ledger"]);
      expect(v.code, `${v.out}\n${v.err}`).toBe(0);
      expect((await promotedStates(root, "forge-ledger", [BALANCE])).get(BALANCE)).toMatchObject({
        state: "verified",
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 8,
      });
      // --write projects it into the catalog; the cross-check agrees on it now.
      const w = await confirmed(["verify", "forge-ledger", "--write"]);
      expect(w.code, `${w.out}\n${w.err}`).toBe(0);
      const endpoints = join(root, "catalog", "generated", "endpoint");
      const recs = await Promise.all(
        (await readdir(endpoints)).map(async (n) =>
          deserializeRecord(await readFile(join(endpoints, n), "utf8")),
        ),
      );
      const balance = recs.find(
        (x) =>
          x.ok && x.record.kind === "Endpoint" && x.record.pathOrTopic === "/accounts/{id}/balance",
      );
      expect(balance?.ok && balance.record.evidence.some((e) => e.line === 8)).toBe(true);
      const after = await items();
      expect(after.items.find((i) => i.key === BALANCE)).toBeUndefined();
    },
    T,
  );

  it(
    "an Interface becomes a call fact; a kind no one fact says whole is refused, writing nothing",
    async () => {
      const r = await run(["catalog", "crosscheck", "forge-ledger", "--promote", PAYMENTS]);
      expect(r.code, r.err).toBe(0);
      const call = parseFactsLines(await readFile(factsFile(), "utf8")).facts.find(
        (f) => f.id === promotedFactId(PAYMENTS),
      );
      expect(call).toMatchObject({
        kind: "call",
        by: "person",
        callType: "rest",
        method: "POST",
        path: "/v2/payments",
        to: "northwind-pay",
        component: "ledger-api",
        cite: { file: "src/main/java/forge/ledger/NorthwindClient.java", line: 8 },
      });
      const text = await readFile(factsFile(), "utf8");
      const key = (await items()).items.find(
        (i) => i.state === "readers-only" && i.key.startsWith("IndexConstraint|"),
      )!.key;
      const no = await run(["catalog", "crosscheck", "forge-ledger", "--promote", key]);
      expect(no.code).toBe(1);
      expect(no.err).toMatch(/can't be promoted: a IndexConstraint isn't one fact/);
      expect(no.err).toMatch(/Nothing written/);
      const gone = await run([
        "catalog",
        "crosscheck",
        "forge-ledger",
        "--promote",
        "Endpoint|GET /nowhere",
      ]);
      expect(gone.code).toBe(1);
      expect(gone.err).toMatch(/isn't an item the readers found/);
      expect(await readFile(factsFile(), "utf8")).toBe(text);
    },
    T,
  );

  it(
    "is a person's word: refused inside a Copilot session Atticus started",
    async () => {
      const text = await readFile(factsFile(), "utf8");
      process.env.ATTICUS_ACP_SESSION = "s-test";
      try {
        const r = await run([
          "catalog",
          "crosscheck",
          "forge-ledger",
          "--promote",
          "Unresolved|ledger-api.publish.transfers.completed",
        ]);
        expect(r.code).not.toBe(0);
        expect(`${r.out}\n${r.err}`).toMatch(/a person promotes what the readers found/);
      } finally {
        delete process.env.ATTICUS_ACP_SESSION;
      }
      expect(await readFile(factsFile(), "utf8")).toBe(text);
    },
    T,
  );
});
