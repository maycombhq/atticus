import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseRecord,
  recordPath,
  serializeRecord,
  SPEC_HEADER_SCHEMA_VERSION,
  writeSpecHeader,
} from "@maycombhq/core";
import { main } from "../src/main.js";
import type { NextStep } from "../src/next-commands.js";
import { queueOrder, queueWhy, type QueueRepo } from "../src/onboarding-queue.js";

/**
 * Plan item P6 (ADR 0141): `atticus next` reads the repos in the order that lands links early
 * (callees and gateways first), says what each read is estimated to cost and what each read so
 * far took, and never recommends a repo already mapped unless its clone has moved past its facts.
 * On the invented bank-shaped Forge estate (fixtures/link-estate). Files only, no network.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const LINK = join(FIXTURES, "link-estate");
const REPOS = [
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
const SHA = (c: string) => c.repeat(40).slice(0, 40);

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out, err };
};

/** A record of the catalog citing `repo` from its facts, as verify --write leaves one. */
async function fromFacts(root: string, repo: string) {
  const p = parseRecord({
    kind: "Component",
    schemaVersion: 2,
    id: `${repo}-c`,
    status: "current",
    confidence: "verified",
    evidence: [{ source: "code", repo, path: "README.md", line: 1, by: "assistant" }],
    system: "platform",
    repo,
    type: "service",
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  const file = join(root, "catalog", "generated", recordPath(p.record));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeRecord(p.record));
}

/**
 * The bank-shaped estate as a metarepo, every repo cloned (its HEAD at `head`), the repos in
 * `mapped` read and written: their facts on file, their verify report at `factsAt`, and a
 * catalog record from their facts.
 */
async function estate(mapped: string[], o: { head?: string; factsAt?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-queue-"));
  await cp(join(LINK, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const id of REPOS) {
    await mkdir(join(root, "workspace", id, ".git"), { recursive: true });
    await writeFile(join(root, "workspace", id, ".git", "HEAD"), `${o.head ?? SHA("a")}\n`);
  }
  await mkdir(join(root, "facts"), { recursive: true });
  for (const id of mapped) {
    await cp(join(LINK, "facts", `${id}.jsonl`), join(root, "facts", `${id}.jsonl`));
    await writeFile(
      join(root, "facts", `${id}.verify.yaml`),
      `accepted: 3\nrejected: 0\ncommit: ${o.factsAt ?? o.head ?? SHA("a")}\n`,
    );
    await fromFacts(root, id);
  }
  return root;
}

const steps = async (root: string) => {
  const r = await run(["next", "--json", "--all", "--root", root]);
  expect(r.code, r.err.join("\n")).toBe(0);
  return (JSON.parse(r.out.join("\n")) as { steps: NextStep[] }).steps;
};
const mapSteps = (s: NextStep[]) => s.filter((x) => x.step === "map").map((x) => x.repo);

describe("atticus next: the onboarding queue (P6, ADR 0141)", () => {
  it("with nothing read, puts the gateways first, then the rest in the manifests' order", async () => {
    const root = await estate([]);
    expect(mapSteps(await steps(root))).toEqual([
      "forge-proxy-accounts-v1",
      "forge-proxy-payments-v1",
      "forge-proxy-northwind-v1",
      "forge-portal-bff",
      "forge-accounts",
      "forge-payments",
      "forge-cards",
      "forge-notifications",
      "forge-starter",
      "forge-deploy-config",
    ]);
  });

  it("puts the repos the read repos call first, so their links land, and says why", async () => {
    // The portal and the payments service are read: the portal calls the accounts and payments
    // proxies; the payments service calls the Northwind proxy and the notifications service.
    const root = await estate(["forge-portal-bff", "forge-payments"]);
    const s = await steps(root);
    const order = mapSteps(s);
    expect(order).not.toContain("forge-portal-bff");
    expect(order).not.toContain("forge-payments");
    expect(order).toEqual([
      "forge-proxy-accounts-v1",
      "forge-proxy-payments-v1",
      "forge-proxy-northwind-v1",
      // Called by forge-payments, so ahead of forge-accounts, listed before it.
      "forge-notifications",
      "forge-accounts",
      "forge-cards",
      "forge-starter",
      "forge-deploy-config",
    ]);
    expect(s.find((x) => x.repo === "forge-notifications")!.why).toContain(
      "1 read repo calls it (forge-payments): read it next and that link lands.",
    );
    const first = s.find((x) => x.repo === "forge-proxy-accounts-v1")!;
    expect(first.why).toContain(
      "1 read repo calls it (forge-portal-bff), and it is a gateway: read it next and that link lands.",
    );
    // A repo nothing read calls, and no gateway, waits in the manifests' order, saying no more.
    expect(s.find((x) => x.repo === "forge-starter")!.why).toBe(
      "forge-starter isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify forge-starter checks them.",
    );
  });

  it("never recommends a mapped repo, whatever its spec header says, unless it is stale", async () => {
    const root = await estate(["forge-portal-bff"]);
    // A spec header left by an earlier draft (another template) no longer hides that it is mapped.
    await writeSpecHeader(root, {
      schemaVersion: SPEC_HEADER_SCHEMA_VERSION,
      repo: "forge-portal-bff",
      template: "spring-boot@1",
      templateReviewed: false,
      flows: [],
      files: {},
      questions: [],
    });
    const s = await steps(root);
    expect(s.filter((x) => x.repo === "forge-portal-bff")).toEqual([]);
  });

  it("asks for a re-read of a mapped repo whose clone moved past its facts' commit", async () => {
    const root = await estate(["forge-portal-bff"], { head: SHA("b"), factsAt: SHA("a") });
    const s = await steps(root);
    const again = s.find((x) => x.repo === "forge-portal-bff")!;
    expect(again).toMatchObject({
      step: "reread",
      command: "atticus map forge-portal-bff",
      slash: "/atticus-map forge-portal-bff",
    });
    expect(again.why).toBe(
      `forge-portal-bff's clone moved past its facts' commit (facts ${SHA("a").slice(0, 12)}, clone ${SHA("b").slice(0, 12)}): atticus estate fresh says how many facts to read again; your assistant reads only the files that changed.`,
    );
  });

  it("says each repo's estimated cost and what each read took, as the read plans record them", async () => {
    const root = await estate(["forge-portal-bff"]);
    await writeFile(
      join(root, "facts", "forge-accounts.read-plan.yaml"),
      [
        "schemaVersion: 2",
        "repo: forge-accounts",
        `commit: ${SHA("a")}`,
        "session: 61200",
        "plannedAt: 2026-10-30T09:00:00Z",
        "estimate: { files: 40, tokens: 90000, sessions: 2 }",
        "parts:",
        "  - { part: 1, paths: [src/**], files: 30, tokens: 60000 }",
        "  - { part: 2, paths: [config/**], files: 10, tokens: 30000 }",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "facts", "forge-portal-bff.read-plan.yaml"),
      [
        "schemaVersion: 2",
        "repo: forge-portal-bff",
        `commit: ${SHA("a")}`,
        "session: 150000",
        "plannedAt: 2026-10-29T09:00:00Z",
        "estimate: { files: 12, tokens: 21000, sessions: 1 }",
        "parts: []",
        `read: { at: 2026-10-29T11:00:00Z, commit: ${SHA("a")}, sessions: 1 }`,
        "reported:",
        `  - { at: 2026-10-29T11:05:00Z, commit: ${SHA("a")}, tokens: 48000, sessions: 1 }`,
        "",
      ].join("\n"),
    );
    const s = await steps(root);
    expect(s.find((x) => x.repo === "forge-accounts")!.why).toContain(
      "Estimated about 90K tokens in 2 sessions (atticus map forge-accounts --estimate; an estimate, not a meter).",
    );
    const q = await run(["next", "--queue", "--root", root]);
    expect(q.code, q.err.join("\n")).toBe(0);
    const text = q.out.join("\n");
    expect(q.out[0]).toBe(
      "9 repos to read, in the order that lands links early (callees and gateways first):",
    );
    expect(q.out[1]).toMatch(/^ {2}1\. forge-proxy-accounts-v1: /);
    expect(text).toMatch(/forge-accounts: .*estimated about 90K tokens in 2 sessions/);
    expect(text).toContain("not estimated yet (atticus map forge-starter --estimate)");
    expect(text).toContain("1 repo read:");
    expect(text).toContain(
      "  forge-portal-bff: estimated about 21K tokens in 1 session; read in 1 part; reported 48K tokens in 1 session",
    );
    expect(text).toContain(
      "Tokens estimated are counted from the source; reported ones are your assistant's word (atticus map <repo> --spent); Atticus meters neither.",
    );
    const j = await run(["next", "--queue", "--json", "--root", root]);
    const parsed = JSON.parse(j.out.join("\n")) as {
      queue: { repo: string; reason: string; cost?: unknown }[];
      read: { repo: string; cost?: { reported?: { tokens: number } } }[];
    };
    expect(parsed.queue[0]).toMatchObject({ repo: "forge-proxy-accounts-v1", reason: "called" });
    expect(parsed.read[0]!.cost!.reported!.tokens).toBe(48_000);
    expect(
      await readFile(join(root, "facts", "forge-portal-bff.read-plan.yaml"), "utf8"),
    ).toContain("tokens: 48000");
  });

  it("orders reads under way, then callees by how many call them, then gateways, then the rest", () => {
    const r = (repo: string, index: number, o: Partial<QueueRepo> = {}): QueueRepo => ({
      repo,
      index,
      ...o,
    });
    const q = [
      r("a", 0),
      r("b", 1, { gateway: true }),
      r("c", 2, { callers: ["x"] }),
      r("d", 3, { callers: ["x", "y"] }),
      r("e", 4, { started: true }),
      r("f", 5, { callers: ["x"], gateway: true }),
    ].sort(queueOrder);
    expect(q.map((x) => x.repo)).toEqual(["e", "d", "f", "c", "b", "a"]);
    expect(queueWhy(r("g", 0, { callers: ["p", "q", "r", "s"] }))).toBe(
      "4 read repos call it (p, q, r and 1 more): read it next and those links land.",
    );
  });
});
