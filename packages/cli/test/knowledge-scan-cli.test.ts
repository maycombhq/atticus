import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { KNOWLEDGE_SCAN_OUTPUT } from "@maycombhq/knowledge";
import { sourcesSync } from "../src/knowledge-commands.js";
import {
  benchKnowledge,
  knowledgeAsk,
  knowledgeList,
  knowledgeScan,
  sourcesTag,
} from "../src/knowledge-scan-commands.js";
import { main } from "../src/main.js";

// ADR 0083: atticus sources tag, sources sync (snapshots), knowledge scan|list|ask, bench knowledge.

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "../../../bench/knowledge");
const WIKI = join(BENCH, "forge-wiki").split("\\").join("/");
const NOW = new Date("2026-10-21T09:00:00Z");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A hand-written assistant answer: two items, one conflict, the superseded page. */
const ANSWER = `items:
  - kind: request
    id: firewall-rule-request
    title: Network firewall rule
    applies_when: A workload needs to reach a host or port it cannot reach today.
    lead_time: 10 working days
    handled_by: Network team
    catalogue_item: Network firewall rule
    source: { page: service-desk-catalogue.md, section: Network firewall rule, quote: "Handled by: Network team. Lead time: 10 working days." }
  - kind: decision
    id: no-cross-service-database
    title: No reads from another service's database (AD-15)
    applies_when: A service or job wants data owned by another service.
    status: banned
    source: { page: architecture-decisions.md, section: "AD-15: No reads from another service's database", quote: "Status: banned. A service never connects to a database owned by another service, even read-only; use the owning service's API or its events." }
conflicts:
  - about: firewall-rule-request
    pages: [service-desk-catalogue.md, network-firewall-guide.md]
    says: ["Handled by: Network team. Lead time: 10 working days.", "Standard firewall rules are implemented within 5 working days."]
superseded:
  - { old: anvil-logging-2023.md, new: anvil-service-standard.md, quote: "It replaces the Anvil 2 logging and health guide (anvil-logging-2023), which no longer applies to any service." }
`;

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "atticus-cli-kscan-"));
  root = join(base, "metarepo");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\n# Forge's wiki\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ${JSON.stringify(WIKI)} }\n`,
  );
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("atticus sources tag", () => {
  it("writes the tags into sources.yaml", async () => {
    const c = capture();
    expect(
      await sourcesTag(
        root,
        "forge-wiki",
        {
          kinds: ["change-process", "enterprise-architecture"],
          frameworks: ["anvil"],
          owner: "Enterprise Architecture",
        },
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe(
      "Tagged forge-wiki: kinds change-process, enterprise-architecture; frameworks anvil; owner Enterprise Architecture.",
    );
    const text = readFileSync(join(root, "org-pack", "sources.yaml"), "utf8");
    expect(text).toContain("# Forge's wiki");
    expect(text).toMatch(/kinds: \[ change-process, enterprise-architecture \]/);
  });

  it("refuses a source that isn't there", async () => {
    const c = capture();
    expect(await sourcesTag(root, "nope", { kinds: ["framework"] }, c.io)).toBe(1);
    expect(c.err[0]).toMatch(/There is no source nope in sources.yaml \(there is forge-wiki\)/);
  });
});

describe("atticus knowledge scan, list and ask", () => {
  it("says to sync first when there is no snapshot", async () => {
    const c = capture();
    const runtime = new MockRuntime(() => ANSWER);
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(2);
    expect(c.err[0]).toMatch(/Run atticus sources sync first/);
  });

  it("sync copies the wiki to a dated snapshot", async () => {
    const c = capture();
    await sourcesSync(root, c.io, { now: "2026-10-21T09:00:00Z" });
    expect(c.out.join("\n")).toContain("Snapshot: knowledge/snapshots/forge-wiki/2026-10-21/");
    expect(existsSync(join(root, "knowledge/snapshots/forge-wiki/2026-10-21/snapshot.yaml"))).toBe(
      true,
    );
  });

  it("scans the snapshot, checks every quote and says what it flagged", async () => {
    const c = capture();
    let prompt = "";
    const runtime = new MockRuntime((r) => {
      prompt = r.pack.prompt;
      return ANSWER;
    });
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("Read 17 pages of forge-wiki (snapshot 2026-10-21).");
    expect(text).toContain(
      "Kept 2 items, each quote checked on its page: 0 pattern, 0 standard, 0 process, 1 request, 1 decision, 0 constraint.",
    );
    expect(text).toMatch(/1 conflict between pages/);
    expect(text).toContain(
      "Superseded: anvil-logging-2023.md is replaced by anvil-service-standard.md; nothing on it was kept as a current rule.",
    );
    expect(text).toMatch(
      /forge-wiki\/broker-topics-runbook.md:15 \(Creating a topic\), hidden from readers/,
    );
    expect(prompt).toContain(
      "tagged change-process, enterprise-architecture; frameworks anvil; owner Enterprise Architecture",
    );
  });

  it("lists items by kind and tag", async () => {
    const c = capture();
    expect(await knowledgeList(root, { kind: "request" }, c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^KIND\s+ID\s+TITLE\s+FROM$/);
    expect(c.out[1]).toMatch(
      /^request\s+firewall-rule-request !\s+Network firewall rule\s+forge-wiki\/service-desk-catalogue.md \(Network firewall rule\)$/,
    );
    const t = capture();
    // A page tag: the source tags every item of the source.
    await knowledgeList(root, { tag: "platform-runbook", json: true }, t.io);
    expect((JSON.parse(t.out.join("\n")) as { id: string }[]).map((i) => i.id)).toEqual([
      "firewall-rule-request",
    ]);
    const bad = capture();
    expect(await knowledgeList(root, { kind: "policy" }, bad.io)).toBe(2);
  });

  it("is wired into atticus", async () => {
    const c = capture();
    expect(await main(["knowledge", "list", "--kind", "decision", "--root", root], c.io)).toBe(0);
    expect(c.out[1]).toMatch(/^decision\s+no-cross-service-database/);
  });

  it("answers from the items, citing them, and refuses without a cite", async () => {
    const c = capture();
    const runtime = new MockRuntime(
      () =>
        "answers:\n  - question: 1\n    answer: No. AD-15 bans reading another service's database, even read-only.\n    cites: [no-cross-service-database]\n",
    );
    expect(
      await knowledgeAsk(
        root,
        "Can the reports job read the ledger's database directly?",
        {},
        { runtime },
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe("No. AD-15 bans reading another service's database, even read-only.");
    expect(c.out[3]).toMatch(
      /^ {2}no-cross-service-database: No reads from another service's database \(AD-15\), forge-wiki\/architecture-decisions.md/,
    );
    const r = capture();
    const none = new MockRuntime(
      () => "answers:\n  - question: 1\n    answer: Probably yes.\n    cites: []\n",
    );
    expect(
      await knowledgeAsk(
        root,
        "Can the reports job read the ledger's database?",
        {},
        { runtime: none },
        r.io,
      ),
    ).toBe(1);
    expect(r.out[0]).toMatch(
      /^Atticus can't answer that from the knowledge items: the answer cites no item/,
    );
  });
});

describe("atticus bench knowledge", () => {
  it("scans the bench's wiki, asks its questions and prints the score", async () => {
    const c = capture();
    const runtime = new MockRuntime((r) =>
      r.outputPath === KNOWLEDGE_SCAN_OUTPUT
        ? ANSWER
        : "answers:\n  - question: 6\n    answer: No; AD-15 bans it.\n    cites: [no-cross-service-database]\n",
    );
    expect(
      await benchKnowledge(
        root,
        { bench: BENCH, cache: join(base, "cache") },
        { runtime, now: NOW },
        c.io,
      ),
    ).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("Items: 2 found, 35 missed, 0 wrong (precision 100%, recall 5%)");
    expect(text).toContain("Quotes: 2 of 2 on the right page and heading, word for word");
    expect(text).toContain("Conflicts: 1 of 2 flagged (missed: data-retention)");
    expect(text).toContain("Superseded pages: 1 of 1 flagged; no item from an old page");
    expect(text).toContain("Injections: 1 of 1 flagged; not followed");
    expect(text).toContain("Questions: 1 of 8 answered citing the right items");
    expect(existsSync(join(base, "cache", "knowledge-results"))).toBe(true);
  });
});
