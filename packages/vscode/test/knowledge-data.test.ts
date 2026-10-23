import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidateItems,
  candidatePick,
  correctArgv,
  correctChoices,
  defaultSourceId,
  findFrom,
  findItems,
  groupKnowledge,
  itemTitle,
  keepArgv,
  keepKinds,
  knowledgeGroupItems,
  knowledgeItemRows,
  knowledgeTooltip,
  knowledgeTop,
  lastScanItems,
  listFromText,
  needArgv,
  needDescription,
  needItems,
  needLine,
  needLook,
  needsNode,
  needTooltip,
  newestFind,
  reviewLook,
  scanReportFrom,
  latestSnapshot,
  snapshotCommit,
  snapshotOpen,
  sourcesAddArgv,
  wikiItems,
  type FindSummary,
  type KnowledgeEntry,
  type NeedEntry,
} from "../src/knowledge-data";
import { readYaml } from "../src/yaml-lite";

/**
 * ADR 0101 in the editor: the knowledge section (sources, items by kind with their reviews, what
 * the last scan changed, searches of the wikis), a change's needs, and the commands each runs.
 * Everything here is the invented Forge estate and invented vendors.
 */

const root = join("C:", "meta");
const p = { root, knowledgeRel: "knowledge" };

const quote = {
  source: "forge-wiki",
  page: "messaging/kafka-topics",
  section: "Asking for a topic",
  text: "The Messaging team creates topics within five working days.",
  snapshot: "2026-10-22",
  line: 12,
};

const kafka: KnowledgeEntry = {
  id: "request-kafka-topic",
  kind: "ProcessDefinition",
  knowledgeKind: "request",
  title: "Ask for a Kafka topic",
  appliesWhen: "A change publishes to a new Kafka topic",
  leadTime: "5 working days",
  handledBy: "Messaging team",
  catalogueItem: "CTASK: Kafka topic",
  inputs: ["topic name", "partitions"],
  steps: ["Open the service desk", "Pick Kafka topic"],
  quote,
  urls: [
    { url: "https://desk.northwind.example/catalogue/kafka-topic", label: "Kafka topic form" },
  ],
  review: {
    state: "verified",
    verdict: "verified",
    by: "Ada Lovelace",
    at: "2026-10-22T09:00:00Z",
  },
};
const outbox: KnowledgeEntry = {
  id: "pattern-outbox",
  kind: "Pattern",
  knowledgeKind: "pattern",
  name: "Transactional outbox",
  definition: "Write the event with the change",
  rules: ["One outbox table per service"],
  quote: { ...quote, page: "patterns/outbox.md", line: 3 },
  review: { state: "stale", verdict: "verified", by: "Ada Lovelace", at: "2026-10-01T09:00:00Z" },
};
const messaging: KnowledgeEntry = {
  id: "team-messaging",
  kind: "Party",
  knowledgeKind: "team",
  name: "Messaging team",
  responsibilities: ["Kafka topics"],
  owns: ["forge-bus"],
  uses: ["Northwind Pay"],
  contacts: ["#messaging"],
  quote,
  review: {
    state: "rejected",
    verdict: "rejected",
    by: "Grace Hopper",
    at: "2026-10-22T10:00:00Z",
    note: "That team was merged",
  },
};
const northwind: KnowledgeEntry = {
  id: "vendor-northwind-pay",
  kind: "Party",
  knowledgeKind: "vendor",
  name: "Northwind Pay",
  quote,
};
const decision: KnowledgeEntry = {
  id: "decision-no-shared-db",
  kind: "Decision",
  knowledgeKind: "decision",
  title: "No shared databases",
  // A Decision's own links are other records, not pages: never offered as links to open.
  links: [{ to: "pattern-outbox" }],
  review: {
    state: "corrected",
    verdict: "corrected",
    by: "Grace Hopper",
    at: "2026-10-22T10:00:00Z",
    corrected: ["appliesWhen"],
  },
} as KnowledgeEntry;

describe("the knowledge items, by kind (ADR 0101)", () => {
  it("groups them in a fixed order, with counts, leaving out empty groups", () => {
    const g = groupKnowledge([outbox, messaging, kafka, northwind, decision]);
    expect(g.map((x) => [x.group.label, x.items.map((i) => i.id)])).toEqual([
      ["Requests and processes", ["request-kafka-topic"]],
      ["Standards and patterns", ["pattern-outbox"]],
      ["Decisions and constraints", ["decision-no-shared-db"]],
      ["Teams", ["team-messaging"]],
      ["Vendors", ["vendor-northwind-pay"]],
    ]);
    const rows = knowledgeGroupItems([outbox, kafka]);
    expect(rows.map((r) => [r.label, r.description])).toEqual([
      ["Requests and processes", "1"],
      ["Standards and patterns", "1 · 1 to check again"],
    ]);
    expect(rows[0]!.expand).toEqual({ kind: "knowledge-group", group: "requests" });
  });

  it("names an item by its title, else its name, else its id", () => {
    expect(itemTitle(kafka)).toBe("Ask for a Kafka topic");
    expect(itemTitle(outbox)).toBe("Transactional outbox");
    expect(itemTitle({ id: "x", kind: "Decision" })).toBe("x");
  });

  it("marks each with its review: a green tick, check again, rejected, or not reviewed", () => {
    expect(reviewLook(kafka.review)).toEqual({
      icon: "pass-filled",
      color: "testing.iconPassed",
      word: "✓ Ada Lovelace",
    });
    expect(reviewLook(decision.review)).toEqual({
      icon: "pass-filled",
      color: "testing.iconPassed",
      word: "✓ corrected by Grace Hopper",
    });
    expect(reviewLook(outbox.review)).toEqual({
      icon: "warning",
      color: "list.warningForeground",
      word: "check again",
    });
    expect(reviewLook(messaging.review)).toEqual({
      icon: "error",
      color: "testing.iconFailed",
      word: "✗ rejected by Grace Hopper",
    });
    expect(reviewLook(undefined)).toEqual({ icon: "circle-large-outline", word: "not reviewed" });
  });

  it("opens the snapshot's copy of the page at the quote's line", () => {
    expect(snapshotOpen(kafka, p)).toEqual({
      kind: "file",
      path: join(
        root,
        "knowledge",
        "snapshots",
        "forge-wiki",
        "2026-10-22",
        "messaging/kafka-topics.md",
      ),
      line: 12,
    });
    expect(snapshotOpen(outbox, p)).toMatchObject({
      path: join(root, "knowledge", "snapshots", "forge-wiki", "2026-10-22", "patterns/outbox.md"),
    });
    // No quote: the item's own file.
    expect(snapshotOpen(decision, p)).toEqual({
      kind: "file",
      path: join(root, "knowledge", "items", "decision", "decision-no-shared-db.yaml"),
    });
  });

  it("says in the tooltip what the item says, where it was read, and who reviewed it", () => {
    const t = knowledgeTooltip(kafka);
    expect(t).toContain("**Ask for a Kafka topic**");
    expect(t).toContain("Applies when: A change publishes to a new Kafka topic");
    expect(t).toContain("Lead time: 5 working days");
    expect(t).toContain("Handled by: Messaging team");
    expect(t).toContain("Catalogue item: CTASK: Kafka topic");
    expect(t).toContain("[Kafka topic form](https://desk.northwind.example/catalogue/kafka-topic)");
    expect(t).toContain("1. Open the service desk");
    expect(t).toContain("> The Messaging team creates topics within five working days.");
    expect(t).toContain(
      "forge-wiki/messaging/kafka-topics, Asking for a topic, line 12 (snapshot 2026-10-22)",
    );
    expect(t).toContain("Verified by Ada Lovelace on 2026-10-22");
    expect(knowledgeTooltip(messaging)).toContain(
      "Rejected by Grace Hopper on 2026-10-22: That team was merged",
    );
    expect(knowledgeTooltip(messaging)).toContain("Owns: forge-bus");
    expect(knowledgeTooltip(outbox)).toContain("Its page changed since Ada Lovelace verified it");
    expect(knowledgeTooltip(decision)).not.toContain("pattern-outbox");
  });

  it("gives each item its row: what clicking opens, and its actions", () => {
    const [k, d] = knowledgeItemRows([kafka, decision], p);
    expect(k).toMatchObject({
      id: "knowledge:request-kafka-topic",
      label: "Ask for a Kafka topic",
      description: "✓ Ada Lovelace",
      icon: "pass-filled",
      color: "testing.iconPassed",
      context: "atticus.knowledgeItem.urls",
      knowledge: { id: "request-kafka-topic" },
    });
    expect(k!.markdown).toBe(true);
    // A Decision's links aren't pages to open.
    expect(d!.context).toBe("atticus.knowledgeItem");
  });
});

describe("the Knowledge section's rows (ADR 0101)", () => {
  it("shows sources, items with their reviews, what the last scan changed, and searches", () => {
    const rows = knowledgeTop({
      sourcesPath: "org-pack/sources.yaml",
      sources: 2,
      items: [kafka, outbox, northwind],
      report: {
        at: "2026-10-22T10:00:00Z",
        added: ["request-kafka-topic"],
        changed: [],
        removed: ["x"],
        snapshots: [],
      },
      finds: [],
    });
    expect(rows.map((r) => [r.label, r.description ?? ""])).toEqual([
      ["Sources (2)", "org-pack/sources.yaml"],
      ["Items (3)", "1 reviewed · 1 to check again"],
      ["What the last scan changed", "2026-10-22 · 1 new, 1 gone · 1 to check again"],
      ["Searches (0)", ""],
    ]);
  });

  it("offers the first step when there is nothing yet", () => {
    const none = knowledgeTop({
      sourcesPath: "org-pack/sources.yaml",
      sources: 0,
      items: [],
      finds: [],
    });
    expect(none.map((r) => r.label)).toEqual(["Sources (0)", "No items yet", "Searches (0)"]);
    expect(none[1]!.command).toEqual({ command: "atticus.addWiki" });
    const unread = knowledgeTop({
      sourcesPath: "org-pack/sources.yaml",
      sources: 1,
      items: [],
      problem: "There are no knowledge items yet.",
      finds: [],
    });
    expect(unread[1]).toMatchObject({
      label: "No items yet: read the sources with Copilot",
      tooltip: "There are no knowledge items yet.",
      command: { command: "atticus.knowledgeScan" },
    });
  });
});

describe("correcting an item (ADR 0101)", () => {
  it("offers the fields its kind allows, each with its value now", () => {
    const c = correctChoices(kafka);
    expect(c.map((x) => x.field)).toEqual([
      "title",
      "appliesWhen",
      "leadTime",
      "handledBy",
      "catalogueItem",
      "inputs",
      "steps",
      "notes",
      "urls",
    ]);
    expect(c.find((x) => x.field === "inputs")).toMatchObject({
      label: "Inputs",
      list: true,
      current: "topic name | partitions",
    });
    expect(c.find((x) => x.field === "notes")!.current).toBe("");
    expect(correctChoices(messaging).map((x) => x.field)).toContain("responsibilities");
    expect(correctChoices({ id: "x", kind: "Unknown" })).toEqual([]);
  });

  it("builds the command, a list joined by |", () => {
    expect(listFromText(" a | b|  | c ")).toEqual(["a", "b", "c"]);
    expect(
      correctArgv(
        "request-kafka-topic",
        [{ field: "inputs", value: ["topic name", "owner"] }],
        "two",
      ),
    ).toEqual([
      "knowledge",
      "correct",
      "request-kafka-topic",
      "--set",
      "inputs=topic name|owner",
      "--note",
      "two",
    ]);
    expect(correctArgv("x", [{ field: "leadTime", value: "3 days" }])).toEqual([
      "knowledge",
      "correct",
      "x",
      "--set",
      "leadTime=3 days",
    ]);
  });
});

describe("the sources (ADR 0101)", () => {
  it("names a new source after its repository or folder", () => {
    expect(defaultSourceId("https://dev.azure.example/forge/_git/forge.wiki")).toBe("forge");
    expect(defaultSourceId("https://git.example.com/forge/platform-docs.git")).toBe(
      "platform-docs",
    );
    expect(defaultSourceId("C:\\docs\\Forge Runbooks\\")).toBe("forge-runbooks");
    expect(defaultSourceId("https://northwind.atlassian.example/wiki/spaces/FORGE")).toBe("forge");
  });

  it("builds sources add from the answers, saved into sources.yaml", () => {
    expect(
      sourcesAddArgv({
        type: "git",
        location: "https://git.example.com/forge/platform-docs.git",
        id: "platform-docs",
        path: "docs",
        ref: "main",
        submodule: true,
        kinds: ["platform-runbook", "change-process"],
        owner: "team-platform",
        save: true,
      }),
    ).toEqual([
      "sources",
      "add",
      "git",
      "https://git.example.com/forge/platform-docs.git",
      "--id",
      "platform-docs",
      "--path",
      "docs",
      "--ref",
      "main",
      "--submodule",
      "--kind",
      "platform-runbook,change-process",
      "--owner",
      "team-platform",
      "--save",
    ]);
    expect(
      sourcesAddArgv({ type: "markdown-folder", location: "../wiki", kinds: [], save: true }),
    ).toEqual(["sources", "add", "markdown-folder", "../wiki", "--save"]);
    // Confluence only prints the entry: its adapter isn't wired to the command line.
    expect(
      sourcesAddArgv({
        type: "confluence",
        location: "https://x.example/wiki",
        kinds: [],
        save: false,
      }),
    ).toEqual(["sources", "add", "confluence", "https://x.example/wiki"]);
  });

  it("reads each source's latest snapshot and the commit it read", () => {
    expect(latestSnapshot(["2026-10-01", "2026-10-22", "2026-09-30", "notes"])).toBe("2026-10-22");
    expect(latestSnapshot([])).toBeUndefined();
    expect(
      snapshotCommit("schemaVersion: 1\ncommit: 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"),
    ).toBe("4b825dc");
    expect(snapshotCommit("schemaVersion: 1\n")).toBeUndefined();
  });

  it("lists each wiki with its snapshot, for its actions", () => {
    const rows = wikiItems(
      {
        path: "org-pack/sources.yaml",
        present: true,
        wikis: [
          {
            id: "forge-wiki",
            type: "git",
            location: "https://git.example.com/forge/forge.wiki",
            spaces: [],
          },
          {
            id: "runbooks",
            type: "markdown-folder",
            location: "../runbooks",
            spaces: [],
            owner: "team-ops",
          },
        ],
        absorbed: [],
      },
      { "forge-wiki": { date: "2026-10-22", commit: "4b825dc" } },
      p,
    );
    expect(rows.map((r) => [r.label, r.description, r.context])).toEqual([
      ["forge-wiki", "git · snapshot 2026-10-22 at 4b825dc", "atticus.source"],
      ["runbooks", "markdown-folder · not synced yet", "atticus.source"],
    ]);
    expect(rows[0]!.source).toBe("forge-wiki");
  });
});

describe("what the last scan changed (ADR 0101)", () => {
  const report = scanReportFrom(
    readYaml(`schemaVersion: 1
scannedAt: 2026-10-22T10:00:00Z
snapshots:
  - source: forge-wiki
    date: 2026-10-22
    pages: 3
changes:
  at: 2026-10-22T10:00:00Z
  added:
    - request-kafka-topic
  changed:
    - pattern-outbox
  removed:
    - decision-old
`),
  );

  it("reads the report's changes and snapshots", () => {
    expect(report).toEqual({
      at: "2026-10-22T10:00:00Z",
      added: ["request-kafka-topic"],
      changed: ["pattern-outbox"],
      removed: ["decision-old"],
      snapshots: [{ source: "forge-wiki", date: "2026-10-22", pages: 3 }],
    });
    expect(scanReportFrom(undefined)).toBeUndefined();
  });

  it("lists new, changed and gone items, and the reviews to check again", () => {
    const rows = lastScanItems(report!, [kafka, outbox], p);
    expect(rows.map((r) => [r.label, r.icon])).toEqual([
      ["Ask for a Kafka topic", "diff-added"],
      ["Transactional outbox", "diff-modified"],
      ["decision-old", "diff-removed"],
      ["Transactional outbox", "warning"],
    ]);
    expect(rows.map((r) => r.description)).toEqual(["new", "changed", "gone", "check again"]);
    expect(rows[0]!.open).toMatchObject({ kind: "file", line: 12 });
    expect(rows[2]!.open).toBeUndefined();
  });
});

const need = (o: Partial<NeedEntry> = {}): NeedEntry => ({
  change: "add-note-tags",
  item: "request-kafka-topic",
  kind: "request",
  title: "Ask for a Kafka topic",
  for: "story:s-2",
  why: "The story publishes tag events",
  because: { file: "stories/s-2.md", quote: "publish a tag-added event", line: 7 },
  from: "assistant",
  leadTime: "5 working days",
  handledBy: "Messaging team",
  catalogueItem: "CTASK: Kafka topic",
  inputs: ["topic name"],
  steps: ["Open the service desk"],
  rules: [],
  page: "forge-wiki/messaging/kafka-topics#Asking for a topic",
  status: "open",
  ...o,
});

describe("what a change needs (ADR 0101)", () => {
  it("says what each need is for, how long it takes and who handles it", () => {
    expect(needDescription(need())).toBe("for story s-2 · 5 working days · Messaging team");
    expect(needDescription(need({ for: "change", verified: "Ada Lovelace" }))).toBe(
      "for the change · 5 working days · Messaging team · ✓ Ada Lovelace",
    );
    expect(needDescription(need({ status: "done", note: "CTASK0012" }))).toContain(
      "done: CTASK0012",
    );
  });

  it("marks each by its state, green when a person verified its item", () => {
    expect(needLook(need())).toEqual({ icon: "circle-large-outline" });
    expect(needLook(need({ verified: "Ada" }))).toEqual({
      icon: "circle-large-outline",
      color: "testing.iconPassed",
    });
    expect(needLook(need({ status: "done" }))).toEqual({ icon: "pass" });
    expect(needLook(need({ status: "not-needed" }))).toEqual({ icon: "circle-slash" });
  });

  it("says why in the tooltip, quoting the change, with the how-to", () => {
    const t = needTooltip(need({ urls: [{ url: "https://desk.northwind.example/k" }] }));
    expect(t).toContain("**Ask for a Kafka topic** · request, for story s-2");
    expect(t).toContain("Why: The story publishes tag events");
    expect(t).toContain("> publish a tag-added event");
    expect(t).toContain("stories/s-2.md:7");
    expect(t).toContain("1. Open the service desk");
    expect(t).toContain("It needs: topic name");
    expect(t).toContain("Catalogue item: CTASK: Kafka topic");
    expect(t).toContain("[https://desk.northwind.example/k](https://desk.northwind.example/k)");
    expect(t).toContain(
      "Found by your assistant; read on forge-wiki/messaging/kafka-topics#Asking for a topic",
    );
  });

  it("shows a Needs node with its open count, or the step that finds them", () => {
    expect(needsNode("add-note-tags", undefined)).toMatchObject({
      label: "Find what it needs",
      command: { command: "atticus.findNeeds", args: ["add-note-tags"] },
    });
    expect(needsNode("add-note-tags", [need(), need({ status: "done" })])).toMatchObject({
      label: "Needs (1 open)",
      expand: { kind: "needs", change: "add-note-tags" },
    });
    expect(needsNode("add-note-tags", [need({ status: "done" })]).label).toBe("Needs (none open)");
  });

  it("lists the needs, open first, each opening needs.md at its line", () => {
    const md = [
      "# What add-note-tags needs from the organisation",
      "",
      "## Requests and processes to raise",
      "",
      "- [x] **Ask for SSO** (the whole change): raise CTASK: SSO",
      "- [ ] **Ask for a Kafka topic** (story s-2): raise CTASK: Kafka topic",
    ].join("\n");
    expect(needLine(md, need())).toBe(6);
    expect(needLine(md, need({ title: "Not there" }))).toBeUndefined();
    const rows = needItems(
      [need({ item: "sso", title: "Ask for SSO", for: "change", status: "done" }), need()],
      join(root, "openspec", "changes", "add-note-tags", "needs.md"),
      md,
    );
    expect(rows.map((r) => [r.label, r.context])).toEqual([
      ["Ask for a Kafka topic", "atticus.need.open"],
      ["Ask for SSO", "atticus.need.closed"],
    ]);
    expect(rows[0]!.open).toEqual({
      kind: "file",
      path: join(root, "openspec", "changes", "add-note-tags", "needs.md"),
      line: 6,
    });
    expect(needItems([need({ urls: [{ url: "https://x.example" }] })], "f", "")[0]!.context).toBe(
      "atticus.need.open.urls",
    );
  });

  it("builds needs done, skip and reopen, for the need's own target", () => {
    expect(needArgv("done", need(), "CTASK0012")).toEqual([
      "needs",
      "done",
      "add-note-tags",
      "request-kafka-topic",
      "--for",
      "story:s-2",
      "--note",
      "CTASK0012",
    ]);
    expect(needArgv("reopen", need())).toEqual([
      "needs",
      "reopen",
      "add-note-tags",
      "request-kafka-topic",
      "--for",
      "story:s-2",
    ]);
  });
});

describe("searching the wikis (knowledge find)", () => {
  const found = findFrom(
    readYaml(`phrase: Kafka topic
at: 2026-10-22T11:00:00Z
pages:
  - forge-wiki/messaging/kafka-topics
candidates:
  - id: request-kafka-acl
    kind: request
    title: Ask for a Kafka ACL
    page: forge-wiki/messaging/kafka-topics
    section: Access
    quote: Ask the Messaging team for an ACL before the first deploy.
    urls:
      - url: https://desk.northwind.example/catalogue/kafka-acl
  - id: request-kafka-topic
    kind: request
    title: Ask for a Kafka topic
    page: forge-wiki/messaging/kafka-topics
    section: Asking for a topic
    quote: The Messaging team creates topics within five working days.
    known: request-kafka-topic
`),
  );

  it("reads a saved search, defensively", () => {
    expect(found?.phrase).toBe("Kafka topic");
    expect(found?.pages).toEqual(["forge-wiki/messaging/kafka-topics"]);
    expect(found?.candidates.map((c) => c.id)).toEqual([
      "request-kafka-acl",
      "request-kafka-topic",
    ]);
    expect(found?.candidates[0]!.urls).toEqual([
      { url: "https://desk.northwind.example/catalogue/kafka-acl" },
    ]);
    expect(findFrom({ phrase: "x", candidates: [{ id: "no-kind" }] })?.candidates).toEqual([]);
    expect(findFrom("nonsense")).toBeUndefined();
  });

  it("shows each candidate with its kind, page, quote, and what it is already known as", () => {
    expect(candidatePick(found!.candidates[0]!)).toEqual({
      label: "Ask for a Kafka ACL",
      description: "request · forge-wiki/messaging/kafka-topics",
      detail: "“Ask the Messaging team for an ACL before the first deploy.”",
      picked: true,
    });
    expect(candidatePick(found!.candidates[1]!)).toMatchObject({
      description:
        "request · forge-wiki/messaging/kafka-topics · already known as request-kafka-topic",
      picked: false,
    });
  });

  it("shows one a person kept already as kept, not picked again", () => {
    const k = findFrom({
      phrase: "Kafka topic",
      candidates: [
        {
          id: "request-kafka-acl",
          kind: "request",
          title: "Ask for a Kafka ACL",
          page: "messaging/kafka-topics",
          quote: "Ask the Messaging team for an ACL.",
          kept: { by: "Ada Lovelace", at: "2026-10-22T12:00:00Z", as: "process" },
        },
      ],
    })!.candidates[0]!;
    expect(k.kept).toEqual({ by: "Ada Lovelace", at: "2026-10-22T12:00:00Z", as: "process" });
    expect(candidatePick(k)).toMatchObject({
      description: "request · messaging/kafka-topics · kept as process by Ada Lovelace",
      picked: false,
    });
  });

  it("keeps a candidate as the kind the person chose", () => {
    const c = found!.candidates[0]!;
    expect(keepArgv(c, "kafka-topic")).toEqual([
      "knowledge",
      "keep",
      "request-kafka-acl",
      "--find",
      "kafka-topic",
    ]);
    expect(keepArgv(c, "kafka-topic", "process")).toEqual([
      "knowledge",
      "keep",
      "request-kafka-acl",
      "--find",
      "kafka-topic",
      "--as",
      "process",
    ]);
  });

  it("lists the saved searches, and finds the one just run", () => {
    const finds: FindSummary[] = [
      {
        slug: "kafka-topic",
        phrase: "Kafka topic",
        at: "2026-10-20T10:00:00Z",
        candidates: 2,
        kept: 1,
      },
      {
        slug: "kafka-topic-2",
        phrase: "Kafka topic",
        at: "2026-10-22T10:00:00Z",
        candidates: 3,
        kept: 0,
      },
      { slug: "sso", phrase: "SSO", at: "2026-10-21T10:00:00Z", candidates: 0, kept: 0 },
    ];
    expect(newestFind(finds, "kafka topic")?.slug).toBe("kafka-topic-2");
    expect(newestFind(finds, "nothing")).toBeUndefined();
    const rows = findItems(finds);
    expect(rows.map((r) => [r.label, r.description])).toEqual([
      ["“Kafka topic”", "3 found · 0 kept · 2026-10-22"],
      ["“SSO”", "nothing found · 2026-10-21"],
      ["“Kafka topic”", "2 found · 1 kept · 2026-10-20"],
    ]);
    // A search opens to what it found; its Keep button keeps more.
    expect(rows[0]!.expand).toEqual({ kind: "find", slug: "kafka-topic-2" });
    expect(rows[0]!.context).toBe("atticus.find");
    expect(rows[0]!.command).toBeUndefined();
  });

  it("lists what a search found: new first, then kept, then already known", () => {
    const kept = {
      ...found!.candidates[0]!,
      id: "process-kafka-acl",
      title: "Get a Kafka ACL",
      kept: { by: "Ada Lovelace", at: "2026-10-22T12:00:00Z", as: "process" },
    };
    const rows = candidateItems("kafka-topic", [
      found!.candidates[1]!,
      kept,
      found!.candidates[0]!,
    ]);
    expect(rows.map((r) => [r.label, r.description, r.icon])).toEqual([
      ["Ask for a Kafka ACL", "new · request · forge-wiki/messaging/kafka-topics", "sparkle"],
      ["Get a Kafka ACL", "✓ kept as process by Ada Lovelace", "pass-filled"],
      ["Ask for a Kafka topic", "already known as request-kafka-topic", "book"],
    ]);
    // A new one is kept with a click, or its inline Keep button.
    expect(rows[0]!.command).toEqual({
      command: "atticus.keepCandidate",
      args: ["kafka-topic", "request-kafka-acl"],
    });
    expect(rows[0]!.context).toBe("atticus.findCandidate.new");
    expect(rows[1]!.color).toBe("testing.iconPassed");
    expect(rows[1]!.command).toBeUndefined();
    expect(rows[2]!.command).toBeUndefined();
    expect(rows[0]!.tooltip).toContain(
      "Ask the Messaging team for an ACL before the first deploy.",
    );
  });

  it("offers only the kinds a candidate's record can be kept as, the kind found first", () => {
    expect(keepKinds("request")).toEqual(["request", "process"]);
    expect(keepKinds("process")).toEqual(["process", "request"]);
    expect(keepKinds("standard")).toEqual(["standard", "pattern"]);
    expect(keepKinds("constraint")).toEqual(["constraint", "decision"]);
    expect(keepKinds("vendor")).toEqual(["vendor", "team"]);
    expect(keepKinds("project")).toEqual(["project", "product"]);
    expect(keepKinds("glossary")).toEqual(["glossary"]);
  });
});

describe("correcting an item's links and other names (ADR 0101)", () => {
  it("offers them, a link as label=address", () => {
    const c = correctChoices({
      id: "kafka-topic-request",
      kind: "ProcessDefinition",
      title: "Kafka topic",
      urls: [
        { label: "Form", url: "https://servicedesk.example.com/kafka" },
        { url: "https://wiki.example.com/topics" },
      ],
    } as never);
    expect(c.find((x) => x.field === "urls")).toMatchObject({
      label: "Links (label=address)",
      list: true,
      current: "Form=https://servicedesk.example.com/kafka | https://wiki.example.com/topics",
    });
    const v = correctChoices({
      id: "nwp",
      kind: "Party",
      name: "Northwind Pay",
      aliases: ["NWP"],
    } as never);
    expect(v.find((x) => x.field === "aliases")).toMatchObject({
      label: "Other names",
      current: "NWP",
    });
  });
});
