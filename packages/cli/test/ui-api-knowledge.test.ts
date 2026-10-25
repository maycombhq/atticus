import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, Profile, recordPath, serializeRecord } from "@maycombhq/core";
import { saveFind, type KnowledgeRecord } from "@maycombhq/knowledge";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiKnowledgeRoutes } from "../src/ui-api-knowledge.js";

/**
 * ADR 0102: the knowledge API, over a metarepo with a Markdown wiki, three knowledge items, a
 * saved search, a change with its needs and a platform profile. The app's user is given, so
 * no Git is read; nothing reaches the network.
 */

const NOW = new Date("2026-10-22T10:00:00Z");
const quote = (page: string, section: string, text: string) => ({
  source: "platform",
  page,
  section,
  text,
  snapshot: "2026-10-20",
});
const rec = (r: Record<string, unknown>) => {
  const p = parseRecord({
    schemaVersion: 2,
    status: "current",
    confidence: "inferred",
    evidence: [{ source: "document", path: "knowledge/snapshots/platform/2026-10-20/x.md" }],
    ...r,
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record as KnowledgeRecord;
};

const KAFKA = rec({
  kind: "ProcessDefinition",
  id: "kafka-topic-request",
  title: "Kafka topic",
  processKind: "request",
  appliesWhen: "A service publishes to a topic that does not exist yet.",
  leadTime: "5 working days",
  handledBy: "Messaging team",
  steps: ["Open the platform catalogue", "Pick Kafka topic"],
  quote: quote("how-to/kafka.md", "The request", "Handled by: Messaging team."),
});
const LOGGING = rec({
  kind: "Pattern",
  id: "json-logging",
  code: "json-logging",
  name: "Log as JSON",
  patternKind: "standard",
  patternStatus: "to-review",
  rules: ["Log as JSON"],
  quote: quote("standards/logging.md", "Logging", "Log as JSON."),
});
const NORTHWIND = rec({
  kind: "Party",
  id: "northwind-pay",
  name: "Northwind Pay",
  partyKind: "vendor",
  owner: "Payments team",
  aliases: ["NWP"],
  quote: quote("vendors.md", "Vendors", "Northwind Pay is the card processor."),
});
const STARTER = rec({
  kind: "ProcessDefinition",
  id: "new-starter-request",
  title: "New starter request",
  processKind: "request",
  appliesWhen: "A new joiner needs a laptop.",
  quote: quote("joiners.md", "Getting a laptop", "Raise the new starter request."),
});

const NEEDS = `schemaVersion: 1
change: add-chat-export
updatedAt: 2026-10-22T09:00:00Z
needs:
  - item: kafka-topic-request
    kind: request
    title: Kafka topic
    for: story:s1-export-chat
    why: The story publishes on a new topic.
    because: { file: stories/s1-export-chat.md, quote: "on the chat-exports topic", line: 3 }
    from: assistant
    leadTime: 5 working days
    handledBy: Messaging team
    status: open
  - item: json-logging
    kind: standard
    title: Log as JSON
    for: change
    why: Every backend service logs.
    from: assistant
    status: open
`;

let srv: RunningServer;
let root: string;
let base: string;

/** ADR 0124, Part 5: what a change's stages picked from the org's knowledge, and a near-miss. */
const KNOWLEDGE_APPLIES = `schemaVersion: 1
change: add-chat-export
items:
  - id: json-logging
    kind: Pattern
    status: suggested
    stages: [feature]
    score: 4
    why: named in the brief
    file: knowledge/items/pattern/json-logging.yaml
  - id: "platform/how-to/webhooks.md#Signatures"
    kind: WikiSection
    status: suggested
    stages: [feature]
    score: 1.2
    why: 'search (words #3, the model''s "transfer status" #5, title #1)'
    file: knowledge/snapshots/platform/2026-10-20/how-to/webhooks.md
    title: Webhooks › Signatures
nearMisses:
  - id: northwind-pay
    kind: Party
    score: 1.5
    stage: feature
`;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "atticus-ui-knowledge-"));
  await mkdir(join(base, "wiki"), { recursive: true });
  await writeFile(
    join(base, "wiki", "joiners.md"),
    "# Joiners\n\n## Getting a laptop\n\nRaise the new starter request two weeks before the start date.\n",
  );
  root = join(base, "meta");
  await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `# Where things are.\nschemaVersion: 1\nwikis:\n  - { id: platform, type: markdown-folder, location: ${JSON.stringify(join(base, "wiki").split("\\").join("/"))}, owner: platform-team, tags: { kinds: [change-process], frameworks: [] } }\n`,
  );
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "profile.yaml"),
    "# The Forge platform.\nschemaVersion: 1\nplatform: forge\nname: Forge\nsystems:\n  - id: ledger\n    name: Ledger\n    boundary: product\n",
  );
  for (const r of [KAFKA, LOGGING, NORTHWIND]) {
    const f = join(root, "knowledge", "items", ...recordPath(r).split("/"));
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  await saveFind(
    root,
    {
      status: "found",
      phrase: "new starter",
      matches: [
        {
          source: "platform",
          page: "joiners.md",
          section: "Getting a laptop",
          line: 5,
          excerpt: "Raise the new starter request two weeks before the start date.",
        },
      ],
      candidates: [{ record: STARTER }, { record: KAFKA, known: "kafka-topic-request" }],
      failed: [],
      problems: [],
    },
    "2026-10-22T09:30:00Z",
  );
  const change = join(root, "openspec", "changes", "add-chat-export");
  await mkdir(change, { recursive: true });
  await writeFile(join(change, "needs.yaml"), NEEDS);
  await writeFile(join(change, "knowledge.yaml"), KNOWLEDGE_APPLIES);
  await mkdir(join(root, "openspec", "changes", "add-transfer-limit"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "bad-knowledge"), { recursive: true });
  await writeFile(
    join(root, "openspec", "changes", "bad-knowledge", "knowledge.yaml"),
    "schemaVersion: 7\n",
  );
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiKnowledgeRoutes(r, ctx, { now: () => NOW }),
  });
});
afterAll(() => srv?.close());

describe("knowledge sources (ADR 0102)", () => {
  it("lists the wikis with their tags and owner, and says one never synced is stale", async () => {
    const r = await call("GET", "/api/knowledge/sources");
    expect(r.status).toBe(200);
    const v = Api.KnowledgeSourceList.parse(r.body);
    expect(v.types).toContain("git");
    expect(v.sources).toHaveLength(1);
    expect(v.sources[0]).toMatchObject({
      id: "platform",
      type: "markdown-folder",
      owner: "platform-team",
      tags: { kinds: ["change-process"], frameworks: [] },
      stale: true,
      commands: {
        sync: "atticus sources sync --source platform",
        scan: "atticus knowledge scan --source platform",
        slash: "/atticus-knowledge platform",
      },
    });
    expect(v.sources[0]!.snapshot).toBeUndefined();
  });

  it("syncs one source into a dated snapshot, and 404s one that isn't there", async () => {
    const r = await call("POST", "/api/knowledge/sources/platform/sync");
    expect(r.status).toBe(200);
    expect(Api.CommandOutput.parse(r.body).lines.join("\n")).toMatch(/platform: 1 page read/);
    const v = Api.KnowledgeSourceList.parse((await call("GET", "/api/knowledge/sources")).body);
    expect(v.sources[0]!.snapshot).toMatchObject({ date: "2026-10-22", pages: 1, ageDays: 0 });
    expect(v.sources[0]!.stale).toBe(false);
    expect((await call("POST", "/api/knowledge/sources/nope/sync")).status).toBe(404);
  });

  it("adds a wiki to sources.yaml, keeping its comments, or only gives the entry without save", async () => {
    await mkdir(join(base, "meta", "docs", "runbooks"), { recursive: true });
    const dry = await call("POST", "/api/knowledge/sources", {
      type: "markdown-folder",
      location: "docs/runbooks",
      save: false,
    });
    expect(dry.status).toBe(200);
    expect(Api.CommandOutput.parse(dry.body).lines[0]).toMatch(/Add this under wikis/);
    const saved = await call("POST", "/api/knowledge/sources", {
      type: "markdown-folder",
      location: "docs/runbooks",
      id: "runbooks",
      kinds: ["platform-runbook"],
      owner: "sre-team",
    });
    expect(saved.status).toBe(200);
    const text = await readFile(join(root, "org-pack", "sources.yaml"), "utf8");
    expect(text).toContain("# Where things are.");
    expect(text).toContain("id: runbooks");
    // The same folder again is refused; a git option on a folder is a bad request.
    expect(
      (
        await call("POST", "/api/knowledge/sources", {
          type: "markdown-folder",
          location: "docs/runbooks",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("POST", "/api/knowledge/sources", {
          type: "markdown-folder",
          location: "docs/runbooks",
          ref: "main",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/knowledge/sources", { type: "wiki", location: "x" })).status,
    ).toBe(400);
  });
});

describe("knowledge items and reviews (ADR 0102)", () => {
  it("lists the items with their kind and the fields each may have corrected", async () => {
    const r = await call("GET", "/api/knowledge/items");
    expect(r.status).toBe(200);
    const v = Api.KnowledgeItemList.parse(r.body);
    expect(v.items.map((i) => [i.id, i.kind])).toEqual([
      ["json-logging", "standard"],
      ["kafka-topic-request", "request"],
      ["northwind-pay", "vendor"],
    ]);
    const kafka = v.items.find((i) => i.id === "kafka-topic-request")!;
    expect(kafka.fields).toMatchObject({ leadTime: "text", steps: "list", urls: "links" });
    expect(kafka.fields).not.toHaveProperty("quote");
    const vendors = Api.KnowledgeItemList.parse(
      (await call("GET", "/api/knowledge/items?kind=vendor")).body,
    );
    expect(vendors.items.map((i) => i.id)).toEqual(["northwind-pay"]);
    expect((await call("GET", "/api/knowledge/items?kind=widget")).status).toBe(400);
  });

  it("verifies, corrects (lists as lists, links as label and address) and rejects as the signed-in person", async () => {
    const v = await call("POST", "/api/knowledge/items/json-logging/review", {
      verdict: "verified",
    });
    expect(v.status).toBe(200);
    const verified = Api.ReviewedItem.parse(v.body);
    expect(verified.item.review).toMatchObject({ state: "verified", by: "priya.nair" });
    expect(verified.file).toBe("knowledge/reviews/json-logging.yaml");

    const c = await call("POST", "/api/knowledge/items/kafka-topic-request/review", {
      verdict: "corrected",
      set: {
        leadTime: "3 working days",
        steps: ["Open the catalogue", "Pick Kafka topic", "Name the topic"],
        urls: [{ label: "Form", url: "https://servicedesk.example.com/kafka" }],
      },
    });
    expect(c.status).toBe(200);
    const corrected = Api.ReviewedItem.parse(c.body).item;
    expect(corrected.review).toMatchObject({ state: "corrected", by: "priya.nair" });
    expect(corrected.record).toMatchObject({
      leadTime: "3 working days",
      steps: ["Open the catalogue", "Pick Kafka topic", "Name the topic"],
      urls: [{ label: "Form", url: "https://servicedesk.example.com/kafka" }],
    });
    // Correcting again keeps what the first correction set.
    const again = await call("POST", "/api/knowledge/items/kafka-topic-request/review", {
      verdict: "corrected",
      set: { handledBy: "Streaming team" },
    });
    expect(Api.ReviewedItem.parse(again.body).item.record).toMatchObject({
      leadTime: "3 working days",
      handledBy: "Streaming team",
    });
    const file = parse(
      await readFile(join(root, "knowledge", "reviews", "kafka-topic-request.yaml"), "utf8"),
    ) as { by: string; corrections: Record<string, unknown> };
    expect(file.by).toBe("priya.nair");
    expect(Object.keys(file.corrections).sort()).toEqual([
      "handledBy",
      "leadTime",
      "steps",
      "urls",
    ]);

    // A quote can't be corrected, a reason is needed to reject, and an unknown item is a 404.
    expect(
      (
        await call("POST", "/api/knowledge/items/kafka-topic-request/review", {
          verdict: "corrected",
          set: { quote: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/knowledge/items/northwind-pay/review", { verdict: "rejected" }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/knowledge/items/nope/review", { verdict: "verified" })).status,
    ).toBe(404);
    const rej = await call("POST", "/api/knowledge/items/northwind-pay/review", {
      verdict: "rejected",
      note: "Northwind Pay was replaced last year.",
    });
    expect(Api.ReviewedItem.parse(rej.body).item.review).toMatchObject({
      state: "rejected",
      note: "Northwind Pay was replaced last year.",
    });
    // Rejected items are still listed, marked.
    const all = Api.KnowledgeItemList.parse((await call("GET", "/api/knowledge/items")).body);
    expect(all.items.find((i) => i.id === "northwind-pay")!.review!.state).toBe("rejected");
  });

  it("gives the last scan's report and the reviews to check again, with the scan command", async () => {
    const r = await call("GET", "/api/knowledge/scan");
    expect(r.status).toBe(200);
    const v = Api.KnowledgeScanView.parse(r.body);
    expect(v.command).toBe("atticus knowledge scan");
    expect(v.slash).toBe("/atticus-knowledge");
    expect(v.checkAgain).toEqual([]);
  });
});

describe("searching the wikis (ADR 0102)", () => {
  it("finds the sections that mention a phrase, with the AI step to copy", async () => {
    const r = await call("GET", "/api/knowledge/search?q=new%20starter");
    expect(r.status).toBe(200);
    const v = Api.WikiSearchResult.parse(r.body);
    expect(v.pages).toEqual(["platform/joiners.md"]);
    expect(v.matches[0]).toMatchObject({ section: "Getting a laptop", line: 5 });
    expect(v.command).toBe('atticus knowledge find "new starter"');
    expect(v.slash).toBe("/atticus-find new starter");
    const none = Api.WikiSearchResult.parse(
      (await call("GET", "/api/knowledge/search?q=kubernetes")).body,
    );
    expect(none.matches).toEqual([]);
    expect((await call("GET", "/api/knowledge/search")).status).toBe(400);
    expect((await call("GET", "/api/knowledge/search?q=x&source=nope")).status).toBe(404);
  });

  it("lists the saved searches, new and known, and keeps a candidate as the kind chosen", async () => {
    const list = Api.SavedFindList.parse((await call("GET", "/api/knowledge/finds")).body);
    expect(list.finds.map((f) => f.slug)).toEqual(["new-starter"]);
    const f = list.finds[0]!;
    expect(f.candidates.map((c) => [c.id, c.known ?? null])).toEqual([
      ["new-starter-request", null],
      ["kafka-topic-request", "kafka-topic-request"],
    ]);
    expect(f.candidates[0]!.keepAs).toEqual(["process", "request"]);
    expect((await call("GET", "/api/knowledge/finds/nope")).status).toBe(404);

    // A known one can't be kept again, nor kept as a kind its record can't be.
    expect(
      (await call("POST", "/api/knowledge/finds/new-starter/keep", { item: "kafka-topic-request" }))
        .status,
    ).toBe(422);
    expect(
      (
        await call("POST", "/api/knowledge/finds/new-starter/keep", {
          item: "new-starter-request",
          as: "vendor",
        })
      ).status,
    ).toBe(422);
    const kept = await call("POST", "/api/knowledge/finds/new-starter/keep", {
      item: "new-starter-request",
      as: "process",
    });
    expect(kept.status).toBe(200);
    const k = Api.KeptCandidate.parse(kept.body);
    expect(k.as).toBe("process");
    expect(k.item).toMatchObject({ id: "new-starter-request", kind: "process" });
    expect(k.item.review).toMatchObject({ state: "verified", by: "priya.nair" });
    const after = Api.SavedFindView.parse(
      (await call("GET", "/api/knowledge/finds/new-starter")).body,
    );
    expect(after.candidates[0]!.kept).toMatchObject({ by: "priya.nair", as: "process" });
  });
});

describe("a change's needs (ADR 0102)", () => {
  it("gives the needs with each item's review, and the step to find them when there are none", async () => {
    const r = await call("GET", "/api/changes/add-chat-export/needs");
    expect(r.status).toBe(200);
    const v = Api.ChangeNeedsView.parse(r.body);
    expect(v.present).toBe(true);
    expect(v.needs.map((n) => n.item)).toEqual(["kafka-topic-request", "json-logging"]);
    expect(v.needs[0]!.because).toMatchObject({ file: "stories/s1-export-chat.md", line: 3 });
    expect(v.needs[1]!.review?.state).toBe("verified");
    const none = Api.ChangeNeedsView.parse(
      (await call("GET", "/api/changes/add-transfer-limit/needs")).body,
    );
    expect(none).toMatchObject({
      present: false,
      needs: [],
      command: "atticus change needs add-transfer-limit",
      slash: "/atticus-needs add-transfer-limit",
    });
    expect((await call("GET", "/api/changes/nope/needs")).status).toBe(404);
  });

  it("marks a need done with its ticket, not needed with why, and open again", async () => {
    const done = await call("POST", "/api/changes/add-chat-export/needs/kafka-topic-request", {
      status: "done",
      note: "CTASK0012345",
    });
    expect(done.status).toBe(200);
    expect(Api.MarkedNeed.parse(done.body).need).toMatchObject({
      status: "done",
      note: "CTASK0012345",
      by: "priya.nair",
    });
    expect(
      (
        await call("POST", "/api/changes/add-chat-export/needs/json-logging", {
          status: "not-needed",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/changes/add-chat-export/needs/nope", { status: "done" })).status,
    ).toBe(404);
    expect(
      (await call("POST", "/api/changes/add-transfer-limit/needs/json-logging", { status: "done" }))
        .status,
    ).toBe(422);
    const open = await call("POST", "/api/changes/add-chat-export/needs/kafka-topic-request", {
      status: "open",
    });
    expect(Api.MarkedNeed.parse(open.body).need.status).toBe("open");
    const md = await readFile(
      join(root, "openspec", "changes", "add-chat-export", "needs.md"),
      "utf8",
    );
    expect(md).toContain("Kafka topic");
  });
});

describe("the knowledge that applies to a change (ADR 0124, Part 5)", () => {
  it("gives knowledge.yaml as the stages wrote it, or an empty list before any stage ran", async () => {
    const r = await call("GET", "/api/changes/add-chat-export/knowledge");
    expect(r.status).toBe(200);
    const v = Api.ChangeKnowledgeView.parse(r.body);
    expect(v).toMatchObject({
      change: "add-chat-export",
      file: "openspec/changes/add-chat-export/knowledge.yaml",
      present: true,
      command: "atticus change knowledge add-chat-export",
    });
    expect(v.items).toEqual([
      expect.objectContaining({
        id: "json-logging",
        status: "suggested",
        why: "named in the brief",
        // B2 (e): an item's title from its record when the file has none, and why in words.
        title: "Log as JSON",
        reason: "named in the brief",
      }),
      expect.objectContaining({
        id: "platform/how-to/webhooks.md#Signatures",
        title: "Webhooks › Signatures",
        reason: 'Its words match the change\'s title and words, and "transfer status".',
      }),
    ]);
    expect(v.nearMisses.map((n) => [n.id, n.title])).toEqual([["northwind-pay", "Northwind Pay"]]);
    const none = Api.ChangeKnowledgeView.parse(
      (await call("GET", "/api/changes/add-transfer-limit/knowledge")).body,
    );
    expect(none).toMatchObject({ present: false, items: [], nearMisses: [] });
    expect((await call("GET", "/api/changes/nope/knowledge")).status).toBe(404);
    expect((await call("GET", "/api/changes/bad-knowledge/knowledge")).status).toBe(422);
  });

  it("confirms an item and excludes a near-miss, writing the file and giving the commit command", async () => {
    const yes = await call("POST", "/api/changes/add-chat-export/knowledge/json-logging", {
      status: "confirmed",
    });
    expect(yes.status).toBe(200);
    const set = Api.SetChangeKnowledgeResult.parse(yes.body);
    expect(set.file).toBe("openspec/changes/add-chat-export/knowledge.yaml");
    expect(set.commit).toBe(
      'git add openspec/changes/add-chat-export/knowledge.yaml && git commit -m "add-chat-export: the knowledge that applies"',
    );
    expect(set.knowledge.items[0]).toMatchObject({ id: "json-logging", status: "confirmed" });
    const no = Api.SetChangeKnowledgeResult.parse(
      (
        await call("POST", "/api/changes/add-chat-export/knowledge/northwind-pay", {
          status: "excluded",
        })
      ).body,
    );
    expect(no.knowledge.nearMisses).toEqual([]);
    expect(no.knowledge.items.find((i) => i.id === "northwind-pay")).toMatchObject({
      status: "excluded",
      why: "a person",
      title: "Northwind Pay",
      reason: "A person added it.",
    });
    const file = parse(
      await readFile(join(root, "openspec/changes/add-chat-export/knowledge.yaml"), "utf8"),
    ) as { items: { id: string; status: string }[] };
    expect(file.items.map((i) => [i.id, i.status])).toEqual([
      ["json-logging", "confirmed"],
      ["platform/how-to/webhooks.md#Signatures", "suggested"],
      ["northwind-pay", "excluded"],
    ]);
  });

  it("refuses what it can't do: another status, an item not listed, a change with no list", async () => {
    const at = (change: string, item: string, body: unknown) =>
      call("POST", `/api/changes/${change}/knowledge/${item}`, body);
    expect((await at("add-chat-export", "json-logging", { status: "suggested" })).status).toBe(400);
    expect((await at("add-chat-export", "json-logging", {})).status).toBe(400);
    expect((await at("add-chat-export", "nope", { status: "confirmed" })).status).toBe(404);
    expect((await at("add-transfer-limit", "json-logging", { status: "confirmed" })).status).toBe(
      422,
    );
    expect((await at("nope", "json-logging", { status: "confirmed" })).status).toBe(404);
  });
});

describe("the org pack from the wikis (ADR 0102)", () => {
  it("drafts the profile's systems from the items and accepts only the picked ones", async () => {
    const before = Api.OrgPackDraftView.parse((await call("GET", "/api/orgpack/draft")).body);
    expect(before.platforms).toEqual([
      {
        platform: "forge",
        file: "proposals/orgpack/forge.yaml",
        present: false,
        proposals: [],
        command: "atticus orgpack draft --platform forge",
      },
    ]);
    // Northwind Pay was rejected above, so un-reject it with a verdict: verified.
    await call("POST", "/api/knowledge/items/northwind-pay/review", { verdict: "verified" });
    const d = await call("POST", "/api/orgpack/draft", { platform: "forge" });
    expect(d.status).toBe(200);
    const draft = Api.OrgPackDraftView.parse(d.body).platforms[0]!;
    expect(draft.present).toBe(true);
    expect(draft.proposals.map((p) => [p.system.id, p.verified])).toEqual([
      ["northwind-pay", true],
    ]);
    expect((await call("POST", "/api/orgpack/draft", { platform: "nope" })).status).toBe(422);
    expect((await call("POST", "/api/orgpack/draft/forge/accept", { only: [] })).status).toBe(400);
    expect(
      (await call("POST", "/api/orgpack/draft/nope/accept", { only: ["northwind-pay"] })).status,
    ).toBe(404);
    const a = await call("POST", "/api/orgpack/draft/forge/accept", { only: ["northwind-pay"] });
    expect(a.status).toBe(200);
    expect(Api.AcceptedOrgPack.parse(a.body)).toMatchObject({ added: ["northwind-pay"], left: 0 });
    const text = await readFile(
      join(root, "org-pack", "profiles", "forge", "profile.yaml"),
      "utf8",
    );
    expect(text).toContain("# The Forge platform.");
    expect(Profile.parse(parse(text)).systems.map((s) => s.id)).toEqual([
      "ledger",
      "northwind-pay",
    ]);
  });
});
