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
  knowledgeReview,
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
    expect(text).toContain("Kept 2 items, each quote checked on its page: 1 request, 1 decision.");
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
    expect(c.out[0]).toMatch(/^KIND\s+ID\s+TITLE\s+REVIEW\s+FROM$/);
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

describe("people's reviews and rescans (ADR 0101)", () => {
  it("a rescan of an unchanged snapshot reads nothing and says so", async () => {
    const c = capture();
    const runtime = new MockRuntime(() => {
      throw new Error("nothing should be read");
    });
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(0);
    expect(c.out[0]).toMatch(
      /^Nothing changed in forge-wiki since the last scan \(snapshot 2026-10-21, 17 pages\)/,
    );
  });

  it("verifies, corrects and rejects items; the list shows a tick, the correction and the rejection", async () => {
    const at = new Date("2026-10-22T10:00:00Z");
    const v = capture();
    expect(
      await knowledgeReview(
        root,
        "verified",
        "no-cross-service-database",
        { by: "tom", now: at },
        v.io,
      ),
    ).toBe(0);
    expect(v.out[0]).toBe("Verified no-cross-service-database, by tom.");
    const fix = capture();
    expect(
      await knowledgeReview(
        root,
        "corrected",
        "firewall-rule-request",
        {
          by: "tom",
          now: at,
          set: ["catalogueItem=CTASK: Firewall rule", "inputs=source|destination|port"],
        },
        fix.io,
      ),
    ).toBe(0);
    expect(fix.out[0]).toBe("Corrected firewall-rule-request (catalogueItem, inputs), by tom.");
    expect(existsSync(join(root, "knowledge/reviews/firewall-rule-request.yaml"))).toBe(true);
    const list = capture();
    expect(await knowledgeList(root, {}, list.io)).toBe(0);
    const rows = list.out.join("\n");
    expect(rows).toMatch(/firewall-rule-request\s.*✓ corrected by tom/);
    expect(rows).toMatch(/no-cross-service-database\s.*✓ tom/);
    const json = capture();
    await knowledgeList(root, { json: true }, json.io);
    const items = JSON.parse(json.out.join("\n")) as {
      id: string;
      catalogueItem?: string;
      inputs?: string[];
      review?: { state: string };
    }[];
    expect(items.find((i) => i.id === "firewall-rule-request")).toMatchObject({
      catalogueItem: "CTASK: Firewall rule",
      inputs: ["source", "destination", "port"],
      review: { state: "corrected" },
    });

    const bad = capture();
    expect(
      await knowledgeReview(
        root,
        "rejected",
        "firewall-rule-request",
        { by: "tom", now: at },
        bad.io,
      ),
    ).toBe(2);
    expect(bad.err[0]).toMatch(/Say why/);
    const rej = capture();
    expect(
      await knowledgeReview(
        root,
        "rejected",
        "firewall-rule-request",
        { by: "tom", now: at, note: "Moved to the network portal." },
        rej.io,
      ),
    ).toBe(0);
    const after = capture();
    await knowledgeList(root, {}, after.io);
    expect(after.out.join("\n")).toMatch(/firewall-rule-request\s.*✗ rejected by tom/);
  });

  it("says which item there is none of", async () => {
    const c = capture();
    expect(await knowledgeReview(root, "verified", "no-such-item", { by: "tom" }, c.io)).toBe(1);
    expect(c.err[0]).toMatch(/There is no knowledge item no-such-item/);
  });
  it("correcting again keeps the earlier correction, as the app does", async () => {
    const at = new Date("2026-10-23T10:00:00Z");
    expect(
      await knowledgeReview(
        root,
        "corrected",
        "no-cross-service-database",
        { by: "tom", now: at, set: ["handledBy=Architecture board"] },
        capture().io,
      ),
    ).toBe(0);
    expect(
      await knowledgeReview(
        root,
        "corrected",
        "no-cross-service-database",
        { by: "tom", now: at, set: ["reason=Shared databases couple releases."] },
        capture().io,
      ),
    ).toBe(0);
    const json = capture();
    await knowledgeList(root, { json: true }, json.io);
    const item = (
      JSON.parse(json.out.join("\n")) as {
        id: string;
        handledBy?: string;
        reason?: string;
        review?: { corrected?: string[] };
      }[]
    ).find((i) => i.id === "no-cross-service-database")!;
    expect(item).toMatchObject({
      handledBy: "Architecture board",
      reason: "Shared databases couple releases.",
    });
    expect(item.review!.corrected).toEqual(["handledBy", "reason"]);
  });
});
