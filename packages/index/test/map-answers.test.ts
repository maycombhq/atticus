import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  impact,
  namedRecord,
  nearestIds,
  notInMap,
  openIndex,
  receiversOf,
  runContextTool,
  severalNamed,
  translate,
} from "../src/index.js";
import { retrievalRoot } from "./helpers.js";

// The real-model run of the starter personas on the field estate (2.0.0-beta.30): what the map
// tools answered wrongly or not at all. Each finding is a test here; the same answers through
// the commands and the MCP server are in packages/cli/test (mcp-proof-run.test.ts).

const KINDS: Record<string, string> = {
  "forge-svc-05": "Component",
  "forge-svc-06": "Component",
  "forge-svc-06.put-rate-2": "Endpoint",
  "forge-svc-03.on-forge-items-settled": "Endpoint",
};
const lookup = (w: string) =>
  KINDS[w]
    ? { id: w, kind: KINDS[w] }
    : w === "forge.items.settled"
      ? { id: "forge-svc-03.on-forge-items-settled", kind: "Endpoint", byName: true }
      : undefined;

describe("ask, as the personas asked it", () => {
  it("reads who calls an entry as the interfaces that name it as their endpoint", () => {
    // An Interface's `to` is the component: `to:<endpoint>` matched nothing.
    for (const q of ["who calls forge-svc-06.put-rate-2?", "what uses forge-svc-06.put-rate-2"])
      expect(translate(q, lookup), q).toEqual({
        action: "query",
        query: "kind:interface endpoint:forge-svc-06.put-rate-2",
        explanation:
          'Read as: the interfaces that call forge-svc-06.put-rate-2; each one\'s "from" is the caller.',
      });
    // A component's callers are read as they were.
    expect(translate("who calls forge-svc-06?", lookup).query).toBe(
      "kind:interface to:forge-svc-06",
    );
  });

  it("reads who publishes a topic, by its id or its name, as the interfaces on that endpoint", () => {
    for (const q of [
      "who publishes forge.items.settled?",
      "who publishes to the topic forge.items.settled",
      "what produces forge-svc-03.on-forge-items-settled?",
      "who sends forge.items.settled",
    ])
      expect(translate(q, lookup), q).toEqual({
        action: "query",
        query: "kind:interface endpoint:forge-svc-03.on-forge-items-settled",
        explanation:
          'Read as: the interfaces that publish to forge-svc-03.on-forge-items-settled; each one\'s "from" is the publisher.',
      });
  });

  it("says a topic or a repo the map lacks is not in the map, never an empty word search", () => {
    for (const [q, query, read, name] of [
      [
        "who consumes the topic forge.rates.updated?",
        "kind:endpoint pathOrTopic:forge.rates.updated",
        "who receives forge.rates.updated",
        "forge.rates.updated",
      ],
      [
        "who publishes forge.rates.updated?",
        "kind:endpoint pathOrTopic:forge.rates.updated",
        "who publishes to forge.rates.updated",
        "forge.rates.updated",
      ],
      [
        "what does forge-approvals-api call?",
        "kind:interface from:forge-approvals-api",
        "the interfaces forge-approvals-api calls",
        "forge-approvals-api",
      ],
    ] as const) {
      const t = translate(q, lookup);
      expect(t, q).toEqual({
        action: "query",
        query,
        explanation: `Read as: ${read}. ${name} is not in the map: planned or not read.`,
      });
      // Only of a map that was read whole (the amendment's rule), through the same fault.
      const fault = "The map holds no records in this metarepo yet.";
      expect(
        translate(q, lookup, () => fault),
        q,
      ).toEqual({
        action: "query",
        query,
        explanation: `Read as: ${read}. ${fault}`,
        fault,
      });
      // The caller says which of the three it is, where it can tell.
      expect(
        translate(
          q,
          lookup,
          () => undefined,
          (id) => notInMap(id, { plannedBy: ["add-rates"] }),
        ).explanation,
        q,
      ).toBe(
        `Read as: ${read}. ${name} is not in the map: planned or not read. ${name} is planned by change add-rates.`,
      );
    }
    // What a record the map has calls is read as it was, and so is a question with no one name.
    expect(translate("what does forge-svc-05 call?", lookup).query).toBe(
      "kind:interface from:forge-svc-05",
    );
    expect(translate("who receives the money and the goods", lookup).query).toBe(
      "receives money goods",
    );
  });

  it("marks who consumes a topic as a question about its receivers", () => {
    expect(translate("who consumes the topic forge.items.settled?", lookup)).toEqual({
      action: "impact",
      id: "forge-svc-03.on-forge-items-settled",
      query: "impact forge-svc-03.on-forge-items-settled",
      explanation:
        "Read as: who receives forge-svc-03.on-forge-items-settled: the receivers first, then what a change reaches past them.",
      receivers: true,
    });
  });
});

describe("the three ways an id is not in the map (ADR 0201 addendum, 2026-11-19)", () => {
  const said = "forge-audit is not in the map: planned or not read.";
  it("keeps the sentence the personas quote as the start of each", () => {
    expect(notInMap("forge-audit")).toBe(said);
    expect(notInMap("forge-audit", { manifest: true })).toBe(
      `${said} forge-audit is in the manifests and hasn't been read (atticus map forge-audit).`,
    );
    expect(notInMap("forge-audit", { plannedBy: ["add-audit"] })).toBe(
      `${said} forge-audit is planned by change add-audit.`,
    );
    expect(notInMap("forge-audit", { manifest: true, plannedBy: ["a", "b"] })).toBe(
      `${said} forge-audit is in the manifests and hasn't been read (atticus map forge-audit). forge-audit is planned by changes a, b.`,
    );
    expect(notInMap("forge-audit", { nearest: ["forge-audio", "forge-adit"] })).toBe(
      `${said} Neither: no manifest lists forge-audit and no open change plans it. Did you mean forge-audio or forge-adit?`,
    );
    expect(notInMap("forge-audit", {})).toBe(
      `${said} Neither: no manifest lists forge-audit and no open change plans it.`,
    );
  });
});

describe("the map's own lookups", () => {
  it("finds the one record a topic's or an entry's name stands for, and says when several do", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    expect(namedRecord(ix, "transfers.completed")).toEqual({ id: "topic.transfers-completed" });
    expect(namedRecord(ix, "transfers.started")).toBeUndefined();
    expect(severalNamed("/v1/x", ["a.get-x", "b.get-x"])).toBe(
      "/v1/x is the name of several records of the map (a.get-x, b.get-x). Name the id of the one meant.",
    );
    ix.close();
  });

  it("show, walk and show_code take a topic's name, and say which record it is", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const show = await runContextTool(ix, root, "show", { id: "transfers.completed" });
    expect(show.split("\n")[0]).toBe(
      "transfers.completed is the name of topic.transfers-completed.",
    );
    expect(show).toContain("Endpoint topic.transfers-completed (");
    const walk = await runContextTool(ix, root, "walk", { id: "transfers.completed" });
    expect(walk.split("\n")[0]).toBe(
      "transfers.completed is the name of topic.transfers-completed.",
    );
    expect(walk.split("\n")[1]).toBe("Links from topic.transfers-completed, 1 hop:");
    expect(walk).toContain("if-f1cd1f189eaa4b7b");
    expect(
      await runContextTool(ix, root, "show", { id: "topic.transfers-completed" }),
    ).not.toContain("is the name of");
    ix.close();
  });

  it("lets the caller say why an id is not in the map, and names the nearest ids", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const lacks = (id: string) => notInMap(id, { nearest: nearestIds(ix, id) });
    for (const tool of ["show", "walk"])
      await expect(runContextTool(ix, root, tool, { id: "ledger-apy" }, { lacks })).rejects.toThrow(
        "ledger-apy is not in the map: planned or not read. Neither: no manifest lists ledger-apy and no open change plans it. Did you mean ledger-api?",
      );
    // Without it, the sentence is the one it always was.
    await expect(runContextTool(ix, root, "show", { id: "ledger-apy" })).rejects.toThrow(
      /^ledger-apy is not in the map: planned or not read\.$/,
    );
    expect(nearestIds(ix, "ledger-apy", ["ledger-app"])).toEqual(["ledger-api", "ledger-app"]);
    expect(nearestIds(ix, "quillfeather-risk")).toEqual([]);
    ix.close();
  });

  it("impact takes an owner from the caller where the catalog's system has none", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const plain = impact(ix, "ledger-api.post-transfer")!;
    const caller = plain.affected.find((a) => a.id === "portal-bff")!;
    const owned = impact(ix, "ledger-api.post-transfer", 4, {
      owner: (r) => (r.kind === "Component" ? `team-of-${r.id}` : undefined),
    })!;
    expect(owned.affected.find((a) => a.id === "portal-bff")!.owner).toBe(
      caller.owner ?? "team-of-portal-bff",
    );
    expect(owned.affected.map((a) => a.id)).toEqual(plain.affected.map((a) => a.id));
    ix.close();
  });

  it("names a topic's receivers apart from what a change reaches past them", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const r = receiversOf(ix, "topic.transfers-completed")!;
    const walk = impact(ix, "topic.transfers-completed")!;
    expect(r.receivers.map((a) => a.id)).toEqual(["reports-job"]);
    expect(r.receivers[0]!.path).toEqual([
      "topic.transfers-completed",
      "if-f1cd1f189eaa4b7b",
      "reports-job",
    ]);
    // `affected` is the walk as impact gives it (C4 stays additive); `receivers` and `further`
    // are new keys beside it: the receivers, and what the walk reaches past them.
    expect(r.affected).toEqual(walk.affected);
    expect(r.further.map((a) => a.id)).toEqual(
      walk.affected.filter((a) => a.path.length > 3).map((a) => a.id),
    );
    // reports-job has no callers here; the field estate's test has a receiver with some.
    expect(r.further.every((a) => a.path.length > 3)).toBe(true);
    expect(receiversOf(ix, "quillfeather-risk")).toBeUndefined();
    ix.close();
  });
});

describe("search, as the personas used it", () => {
  it("puts an id that is the text, or starts with it, first", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const out = await runContextTool(ix, root, "search", { text: "ledger-api", by: "words" });
    expect(out.split("\n")[1]).toMatch(/^- Component ledger-api: /);
    const prefix = await runContextTool(ix, root, "search", {
      text: "topic.transfers",
      by: "words",
    });
    expect(prefix.split("\n")[1]).toMatch(/^- Endpoint topic\.transfers-completed: /);
    ix.close();
  });

  it("says when nothing holds the whole term, so hits on one of its words aren't read as it", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const out = await runContextTool(ix, root, "search", {
      text: "ledger-quillfeather",
      by: "words",
    });
    expect(out.split("\n")[0]).toBe(
      'Nothing in the index matches "ledger-quillfeather" whole: no id starts with it and nothing holds all of its words (ledger, quillfeather). The hits below match some of them.',
    );
    expect(out.split("\n")[1]).toMatch(/^\d+ hits? for "ledger-quillfeather", best first:$/);
    // A term something holds whole, and one word, say nothing more than before.
    for (const text of ["ledger-api", "ledger"])
      expect(await runContextTool(ix, root, "search", { text, by: "words" })).toMatch(
        /^\d+ hits? for/,
      );
    ix.close();
  });

  it("says once that similar in meaning is off", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root);
    const both = await runContextTool(ix, root, "search", { text: "ledger", by: "both" });
    expect(both).toMatch(/\(Similar in meaning is off: /);
    expect(both).not.toMatch(/is off: similar in meaning is off/i);
    const meaning = await runContextTool(ix, root, "search", { text: "ledger", by: "meaning" });
    expect(meaning).toMatch(/^Similar in meaning is off: .*\. Search by words instead\.$/);
    expect(meaning).not.toMatch(/is off: similar in meaning is off/i);
    ix.close();
  });
});

describe('show on a change (b30 proof run: a quick change read "systems none named" and no more)', () => {
  it("says its type, the repos its tasks.md names and what its requirements plan", async () => {
    const root = await retrievalRoot();
    const dir = join(root, "openspec/changes/add-rate-event");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "change.yaml"),
      "schemaVersion: 1\nid: add-rate-event\ntitle: Rate-updated event\ntype: quick\nstate: plan\nsystems: []\n",
    );
    await writeFile(
      join(dir, "tasks.md"),
      "# Tasks\n\n## forge-approvals-api\n\n- [ ] t1 Publish it\n\n## forge-ledger\n\n- [ ] t2 Listen (after t1)\n",
    );
    await writeFile(
      join(dir, "requirements.md"),
      "# Rate-updated event\n\n## Planned\n\n- `forge.rates.updated`: the new topic\n- `forge-approvals-api`: not created here, planned by `approvals-portal`\n\n## QA\n\nFree text.\n",
    );
    const ix = await openIndex(root);
    const out = await runContextTool(ix, root, "show", { id: "add-rate-event" });
    expect(out.split("\n").slice(0, 5)).toEqual([
      "Change add-rate-event (not verified by a person or a check), read from openspec/changes/add-rate-event/change.yaml:",
      'Change add-rate-event "Rate-updated event" (openspec/changes/add-rate-event/change.yaml): state plan; systems none named.',
      "Type: quick.",
      "Repos its tasks.md names: forge-approvals-api, forge-ledger.",
      "Planned (requirements.md): forge.rates.updated: the new topic; forge-approvals-api: not created here, planned by `approvals-portal`.",
    ]);
    ix.close();
  });
});
