import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex } from "@maycombhq/index";
import { buildAndWrite } from "@maycombhq/scanner";
import { handleMcp, MCP_TOOLS, type McpRun } from "../src/mcp.js";
import { main } from "../src/main.js";
import {
  FIELD_TOPIC_LISTENER,
  FIELD_TOPIC_PUBLISHER,
  makeFieldEstate,
  writeChangeFiles,
} from "./field-estate.js";

/**
 * The map tools as the starter personas called them in the real-model run of 2.0.0-beta.30 on the
 * field-shaped Forge estate (ADR 0201 addendum, 2026-11-19): 8 services, 3 gateway proxies, a
 * repo whose clone is empty, a repo nobody read, a topic, and two open quick changes that both
 * have tasks under a repo the first one plans. Each test is a call of that run whose answer was
 * wrong or empty, through the MCP server and the commands it wraps. No network, no model.
 */

const T = 300_000;
const TOPIC = "forge.items.settled";
const TOPIC_ID = `${FIELD_TOPIC_LISTENER}.on-forge-items-settled`;
const UNREAD = "forge-audit";
const EMPTY = "forge-deploy";
const API = "forge-approvals-api";
const WEB = "forge-approvals-web";
const NEW_TOPIC = "forge.rates.updated";
const PORTAL = "approvals-portal";
const RATES = "rate-updated-event";
const HEADER =
  "| Question | Evidence | Asked by | Answered by | Answer | State |\n| --- | --- | --- | --- | --- | --- |";

let dir: string;
let root: string;
/** An entry one service calls on another: its id, the component it is on, and its callers. */
let entry: { id: string; component: string; callers: string[]; interfaces: string[] };

const run: McpRun = async (argv) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...argv, "--root", root],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

async function call(name: string, args: Record<string, unknown>) {
  const r = (await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    run,
    "1",
  )) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: r.result.content[0]!.text, isError: r.result.isError === true };
}
const json = async <T>(name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text}`).toBe(false);
  return JSON.parse(r.text) as T;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-proof-run-"));
  const e = await makeFieldEstate(dir, {
    services: 8,
    gateways: 3,
    entries: 6,
    calls: 4,
    fieldNames: 60,
    legacy: 1,
    questions: 6,
    links: 2,
    suppressed: 2,
    emptyRepo: EMPTY,
    unreadRepo: UNREAD,
    topic: TOPIC,
  });
  root = e.root;
  const built = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(built.guard.refused).toBeUndefined();
  const state = (id: string, title: string) =>
    `schemaVersion: 1\nid: ${id}\ntitle: ${title}\ntype: quick\nstate: plan\nauthors: {}\ncreatedAt: 2026-11-19T05:00:00Z\ncreatedBy: pat\nhandoffs: []\nhistory:\n  - from: draft\n    to: plan\n    at: 2026-11-19T05:00:00Z\n    by: pat\n    reason: Created from requirements.md\nowners: {}\nsystems: []\ntouches:\n  dataStores: []\n  interfaces: []\n  records: []\n  repos: []\n  tables: []\n`;
  await writeChangeFiles(root, PORTAL, {
    "change.yaml": state(PORTAL, "Approvals portal"),
    "requirements.md": `# Approvals portal\n\n## Planned\n\n- \`${WEB}\`: the portal's screens, a new repo\n- \`${API}\`: the portal's backend, a new repo\n\n## QA\n\nFree text.\n`,
    "tasks.md": `# Tasks\n\n## ${API}\n\n- [ ] t1 Add the service\n\n## ${WEB}\n\n- [ ] t2 Add the screens (after t1)\n`,
  });
  await writeChangeFiles(root, RATES, {
    "change.yaml": state(RATES, "Rate-updated event"),
    "requirements.md": `# Rate-updated event\n\n## Planned\n\n- \`${NEW_TOPIC}\`: the new topic\n- \`${API}\`: not created here, planned by \`${PORTAL}\`\n\n## QA\n\nFree text.\n\n${HEADER}\n| Is the audit told? | \`${UNREAD}\` | qa-naysayer | noor | Yes | answered |\n`,
    "tasks.md": `# Tasks\n\n## ${API}\n\n- [ ] t1 Publish the event\n\n## ${UNREAD}\n\n- [ ] t2 Record it (after t1)\n`,
  });
  // A call between two services, read from the catalog: its entry and who calls it.
  const ix = await openIndex(root);
  try {
    const calls = ix.records(
      ix.query("kind:interface has:endpoint", { limit: 500 }).rows,
    ) as unknown as {
      id: string;
      from: string;
      to: string;
      endpoint: string;
      sync?: string;
    }[];
    const first = calls.find((c) => c.sync !== "async" && c.from.startsWith("forge-svc-"))!;
    const same = calls.filter((c) => c.endpoint === first.endpoint);
    entry = {
      id: first.endpoint,
      component: first.to,
      callers: [...new Set(same.map((c) => c.from))].sort(),
      interfaces: same.map((c) => c.id).sort(),
    };
  } finally {
    ix.close();
  }
}, T);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ask", () => {
  it(
    "names who calls an entry, as impact does (it read to:<entry> and found none)",
    async () => {
      const a = await json<{
        readAs: string;
        query: string;
        total: number;
        records: { id: string; from: string }[];
      }>("ask", { question: `who calls ${entry.id}?` });
      expect(a.query).toBe(`kind:interface endpoint:${entry.id}`);
      expect(a.readAs).toBe(
        `Read as: the interfaces that call ${entry.id}; each one's "from" is the caller.`,
      );
      expect(a.records.map((r) => r.id).sort()).toEqual(entry.interfaces);
      expect([...new Set(a.records.map((r) => r.from))].sort()).toEqual(entry.callers);
      const walked = (await call("impact", { id: entry.id })).text;
      for (const c of entry.callers) expect(walked).toContain(c);
    },
    T,
  );

  it(
    "names who publishes a topic, by the topic's name",
    async () => {
      const a = await json<{
        query: string;
        total: number;
        records: { from: string; to: string }[];
      }>("ask", { question: `who publishes ${TOPIC}?` });
      expect(a.query).toBe(`kind:interface endpoint:${TOPIC_ID}`);
      expect(a.records.map((r) => [r.from, r.to])).toEqual([
        [FIELD_TOPIC_PUBLISHER, FIELD_TOPIC_LISTENER],
      ]);
    },
    T,
  );

  it(
    "says a topic and a repo an open change plans are planned, by which change",
    async () => {
      for (const [question, id, change] of [
        [`who consumes the topic ${NEW_TOPIC}?`, NEW_TOPIC, RATES],
        [`who publishes ${NEW_TOPIC}?`, NEW_TOPIC, RATES],
        [`what does ${API} call?`, API, PORTAL],
        [`who calls ${API}?`, API, PORTAL],
      ] as const) {
        const a = await json<{ readAs: string; total: number }>("ask", { question });
        expect(a.total, question).toBe(0);
        expect(a.readAs, question).toMatch(
          new RegExp(
            ` ${id.replace(/\./g, "\\.")} is not in the map: planned or not read\\. ${id.replace(/\./g, "\\.")} is planned by change ${change}\\.$`,
          ),
        );
      }
      // A manifest's repo nobody read, and a name nothing has.
      const unread = await json<{ readAs: string }>("ask", { question: `who calls ${UNREAD}?` });
      expect(unread.readAs).toContain(
        `${UNREAD} is not in the map: planned or not read. ${UNREAD} is in the manifests and hasn't been read (atticus map ${UNREAD}).`,
      );
    },
    T,
  );

  it(
    "answers who consumes a topic with its receivers, and what lies past them apart",
    async () => {
      const a = await json<{
        readAs: string;
        named?: string;
        receivers: { id: string; owner?: string }[];
        affected: { id: string; path: string[] }[];
        further: { id: string; path: string[] }[];
      }>("ask", { question: `who consumes the topic ${TOPIC}?` });
      expect(a.readAs).toBe(
        `Read as: who receives ${TOPIC_ID}: the receivers first, then what a change reaches past them.`,
      );
      expect(a.receivers.map((r) => r.id)).toEqual([FIELD_TOPIC_LISTENER]);
      // The run's answer had the listener's own callers in `affected`, beside the listener, with
      // nothing to tell them apart. `affected` keeps what it held (the whole walk); the receivers
      // and what lies past them are new keys.
      const walked = JSON.parse((await run(["impact", TOPIC_ID, "--json"])).out) as {
        affected: unknown[];
      };
      expect(a.affected).toEqual(walked.affected);
      expect(a.affected.some((x) => x.path.length > 3)).toBe(true);
      expect(a.further.length).toBeGreaterThan(0);
      expect(
        a.further.every((x) => x.path.length > 3 && x.path.includes(FIELD_TOPIC_LISTENER)),
      ).toBe(true);
      const text = await run(["ask", `who consumes the topic ${TOPIC}?`]);
      expect(text.out).toContain(`${TOPIC_ID} is received by 1 component:`);
      expect(text.out).toMatch(/Further, through a receiver \(\d+ records that don't receive /);
    },
    T,
  );
});

describe("impact, show and walk", () => {
  it(
    "take a topic's name where one record has it, and say which record it is",
    async () => {
      const first = `${TOPIC} is the name of ${TOPIC_ID}.`;
      const impact = await call("impact", { id: TOPIC });
      expect(impact.isError).toBe(false);
      expect(impact.text.split("\n").slice(0, 2)).toEqual([
        first,
        expect.stringMatching(
          new RegExp(`^Changing ${TOPIC_ID.replace(/\./g, "\\.")} reaches \\d+ records:$`),
        ),
      ]);
      expect(impact.text).toContain(FIELD_TOPIC_LISTENER);
      const show = await call("show", { id: TOPIC });
      expect(show.isError).toBe(false);
      expect(show.text.split("\n")[0]).toBe(first);
      expect(show.text).toContain(`Endpoint ${TOPIC_ID} (`);
      const walk = await call("walk", { id: TOPIC });
      expect(walk.isError).toBe(false);
      expect(walk.text.split("\n")[0]).toBe(first);
      expect(walk.text).toContain(`Links from ${TOPIC_ID}, 1 hop:`);
    },
    T,
  );

  it(
    "tell a manifest's unread repo, an id an open change plans and a slip apart",
    async () => {
      const start = (id: string) => `${id} is not in the map: planned or not read.`;
      for (const tool of ["impact", "show", "walk"]) {
        const unread = await call(tool, { id: UNREAD });
        expect(unread, tool).toEqual({
          isError: false,
          text: `${start(UNREAD)} ${UNREAD} is in the manifests and hasn't been read (atticus map ${UNREAD}).`,
        });
        const empty = await call(tool, { id: EMPTY });
        expect(empty.text, tool).toBe(
          `${start(EMPTY)} ${EMPTY} is in the manifests and hasn't been read (atticus map ${EMPTY}).`,
        );
        const planned = await call(tool, { id: API });
        expect(planned, tool).toEqual({
          isError: false,
          text: `${start(API)} ${API} is planned by change ${PORTAL}.`,
        });
        const slip = await call(tool, { id: "forge-svc-9" });
        expect(slip.isError, tool).toBe(false);
        expect(slip.text, tool).toMatch(
          /^forge-svc-9 is not in the map: planned or not read\. Neither: no manifest lists forge-svc-9 and no open change plans it\. Did you mean forge-svc-0\d, forge-svc-0\d or forge-svc-0\d\?$/,
        );
      }
    },
    T,
  );

  it(
    "impact names each record's owner, from the manifest where the catalog has none",
    async () => {
      const r = await call("impact", { id: entry.id });
      const rows = r.text.split("\n").filter((l) => /^\s+(Component|Interface)\s/.test(l));
      expect(rows.length).toBeGreaterThan(1);
      for (const l of rows) expect(l).toMatch(/\steam-(forge|platform)\s/);
      const j = JSON.parse((await run(["impact", entry.id, "--json"])).out) as {
        affected: { kind: string; owner?: string }[];
      };
      expect(
        j.affected.filter((a) => a.kind === "Component").every((a) => a.owner?.startsWith("team-")),
      ).toBe(true);
      // A record with no system to own it says so, never an empty cell.
      const topic = await call("impact", { id: `${FIELD_TOPIC_PUBLISHER}-db` });
      expect(topic.text).not.toMatch(/^\s+\S+\s+\S+\s{3,}(calls|reads|writes|receives)/m);
    },
    T,
  );
});

describe("conflicts, show and the lists", () => {
  it(
    "find two open quick changes with tasks under the same planned repo",
    async () => {
      const pairs = await json<{ changes: string[]; overlap: Record<string, string[]> }[]>(
        "conflicts",
        {},
      );
      expect(pairs).toEqual([
        {
          changes: [PORTAL, RATES],
          overlap: {
            systems: [],
            interfaces: [],
            dataStores: [],
            tables: [],
            records: [API],
            repos: [API],
            flows: [],
          },
        },
      ]);
      // The persona check of beta.30: with an id, the pairs, then each open change whose
      // tasks.md names it, with its heading and tasks.
      expect(await json("conflicts", { id: API })).toEqual([
        ...pairs,
        {
          change: PORTAL,
          touches: API,
          where: [{ file: "tasks.md", line: 3, heading: API, tasks: ["t1"], text: `## ${API}` }],
        },
        {
          change: RATES,
          touches: API,
          where: [{ file: "tasks.md", line: 3, heading: API, tasks: ["t1"], text: `## ${API}` }],
        },
      ]);
      expect(await json("conflicts", { id: WEB })).toEqual([
        {
          change: PORTAL,
          touches: WEB,
          where: [{ file: "tasks.md", line: 7, heading: WEB, tasks: ["t2"], text: `## ${WEB}` }],
        },
      ]);
      const said = await run(["change", "conflicts"]);
      expect(said.code).toBe(1);
      expect(said.out).toBe(`${PORTAL} and ${RATES} both touch records ${API}; repos ${API}`);
    },
    T,
  );

  it(
    "show a quick change with its type, its tasks.md's repos and what it plans",
    async () => {
      const r = await call("show", { id: RATES });
      expect(r.isError).toBe(false);
      expect(r.text).toContain(`Change ${RATES} "Rate-updated event"`);
      expect(r.text).toContain("Type: quick.");
      expect(r.text).toContain(`Repos its tasks.md names: ${API}, ${UNREAD}.`);
      expect(r.text).toContain(
        `Planned (requirements.md): ${NEW_TOPIC}: the new topic; ${API}: not created here, planned by \`${PORTAL}\`.`,
      );
    },
    T,
  );

  it(
    "answer that there are no knowledge items, not an error",
    async () => {
      for (const args of [{}, { kind: "standard" }]) {
        const r = await call("knowledge_items", args);
        expect(r).toEqual({
          isError: false,
          text: "There are no knowledge items yet. Run atticus sources sync, then atticus knowledge scan.",
        });
      }
      // A kind that is none is still an error.
      expect((await call("knowledge_items", { kind: "rumour" })).isError).toBe(true);
    },
    T,
  );

  it(
    "search puts the id asked for first, and says when nothing holds the whole term",
    async () => {
      const exact = await call("search", { text: entry.component });
      expect(exact.text.split("\n")[1]).toMatch(
        new RegExp(`^- (Component|System) ${entry.component}: `),
      );
      const prefix = await call("search", { text: "forge-svc-0" });
      expect(prefix.text.split("\n")[1]).toMatch(/^- (Component|System) forge-svc-00: /);
      // The run's search: twenty settings named forge.* and no word that nothing is forge-approvals.
      const none = await call("search", { text: "forge-approvals" });
      expect(none.text.split("\n")[0]).toBe(
        'Nothing in the index matches "forge-approvals" whole: no id starts with it and nothing holds all of its words (forge, approvals). The hits below match some of them.',
      );
      for (const r of [exact, prefix, none])
        expect(r.text).not.toMatch(/is off: similar in meaning is off/i);
    },
    T,
  );

  it("say in the tools' descriptions what the personas are told of them", () => {
    const d = (name: string) => MCP_TOOLS.find((t) => t.name === name)!.description;
    expect(d("impact")).toContain('"no owner on record"');
    expect(d("impact")).toContain("It gives no file and line: show <id> does.");
    for (const name of ["impact", "show", "walk"])
      expect(d(name), name).toContain("name works where exactly one record has it");
    expect(d("ask")).toContain("who publishes transfers.completed?");
  });
});
