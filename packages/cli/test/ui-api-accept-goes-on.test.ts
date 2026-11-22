import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * ADR 0203 A (addendum 2026-11-22), the app's half: after an Accept the app goes on with the
 * stage, whoever started it. A stage started in a terminal, its draft handed in there for a
 * person, is read in and ends done with nothing else pressed; a stage that stopped for a person
 * in a terminal is run again and ends done with no new draft; while something else still holds
 * the stage the app doesn't go on, and says what to press; and an answer the stage waits on that
 * still fails is said so, with the stage's resume kept, so the app finishes the stage once the
 * answer passes. On the invented Forge metarepo (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const REASON = "forge-limits is created in this release";

/** The assistant's placement: a new flow in a repo nobody has read. */
const ANSWER = `summary: Each account gets a daily transfer limit, checked by a new limits service.
features: []
flows: []
newFlows:
  - name: Check the daily transfer limit
    repo: forge-limits
    why: A limits service checks each transfer against the account's limit.
`;
/** Two new flows, each in a repo nobody has read: two findings a person may accept. */
const TWO = `${ANSWER}  - name: Keep the daily totals
    repo: forge-quotas
    why: A quotas service keeps each account's total for the day.
`;
/** The same placement and a flow nobody knows, which no one may accept. */
const MIXED = ANSWER.replace(
  "flows: []\nnewFlows:",
  "flows:\n  - { id: forge-ledger.no-such-flow, how: changed, why: The limit is checked first. }\nnewFlows:",
);

beforeAll(async () => {
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "atticus-accept-on-state-"));
});

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-accept-on-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  await cp(join(FIXTURES, "forge/inputs"), join(root, "inputs"), { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

/** `atticus <args>` in a terminal: the command line's own code. */
async function terminal(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, text: [...out, ...err].join("\n") };
}

/** The stage started in a terminal, its prompt handed to the assistant, which writes `answer`. */
async function started(root: string, answer: string): Promise<string> {
  await terminal(root, "change", "feature", CHANGE, "--handoff");
  const runs = join(root, ".runs", CHANGE);
  for (const id of (await readdir(runs)).sort().reverse()) {
    const r = JSON.parse(await readFile(join(runs, id, "run.json"), "utf8")) as {
      state: string;
      request: { outputPath: string };
    };
    if (r.state !== "waiting") continue;
    await writeFile(join(runs, id, r.request.outputPath), answer);
    return id;
  }
  throw new Error("The stage handed nothing off.");
}

const loopState = async (root: string) =>
  /^state: (\S+)$/m.exec(await readFile(join(root, REL, "stage/feature.yaml"), "utf8"))?.[1];
const runsOf = (root: string) => readdir(join(root, ".runs", CHANGE));

const servers: RunningServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});
async function app(root: string) {
  const s = await startServer({
    root,
    port: 0,
    user: "priya",
    watch: false,
    extend: (r, ctx) => extendUiRoutes(r, ctx, { autoDone: { off: true } }),
  });
  servers.push(s);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(s.url + path, {
      method,
      headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const thread = async () =>
    Api.StageThreadView.parse(
      (await call("GET", `/api/changes/${CHANGE}/stages/feature/thread`)).body,
    );
  /** The stage's own open findings, as the thread shows them. */
  const open = async () =>
    (await thread()).items.flatMap((i) =>
      i.kind === "finding" &&
      i.view.finding.gate === "stage-feature" &&
      i.view.finding.state === "open"
        ? [i.view.finding]
        : [],
    );
  const accept = async (finding: string) => {
    const r = await call("POST", `/api/changes/${CHANGE}/stages/feature/accept`, {
      finding,
      reason: REASON,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return Api.StageAcceptResult.parse(r.body);
  };
  return { call, thread, open, accept };
}

const T = 300_000;

describe("after an Accept the app goes on with a stage started in a terminal", () => {
  it(
    "its draft handed in there for a person: read in, and the stage is done with nothing else pressed",
    async () => {
      const root = await metarepo();
      const run = await started(root, ANSWER);
      expect((await terminal(root, "handoff", "done", run)).text).toContain(
        "feature-answer.yaml is handed in for a person",
      );
      const a = await app(root);
      const [f] = await a.open();
      expect(f?.rule).toBe("feature.unknown-repo");
      const r = await a.accept(f!.id);
      expect(r.goesOn).toEqual(expect.objectContaining({ kind: "done" }));
      expect(await loopState(root)).toBe("done");
      expect(await runsOf(root)).toEqual([run]);
      expect(r.thread.state).toBe("done");
    },
    T,
  );

  it(
    "stopped for a person in a terminal: run again, and done with no new draft",
    async () => {
      const root = await metarepo();
      const run = await started(root, ANSWER);
      await terminal(root, "handoff", "done", run);
      await terminal(root, "change", "feature", CHANGE, "--handoff", "--resume", run);
      expect(await loopState(root)).toBe("stopped");
      const a = await app(root);
      expect((await a.thread()).headline).toBe(
        "The stage stopped for a person: its draft has a finding below that you may accept. Accept it with a reason, or tell the assistant how to fix the draft.",
      );
      const r = await a.accept((await a.open())[0]!.id);
      expect(r.goesOn).toEqual(expect.objectContaining({ kind: "done" }));
      expect(await loopState(root)).toBe("done");
      expect(await runsOf(root)).toEqual([run]);
    },
    T,
  );

  it(
    "while another finding still holds the stage it doesn't go on, and says so; the last Accept goes on",
    async () => {
      const root = await metarepo();
      const run = await started(root, TWO);
      await terminal(root, "handoff", "done", run);
      const a = await app(root);
      const [one, two] = await a.open();
      expect([one?.rule, two?.rule]).toEqual(["feature.unknown-repo", "feature.unknown-repo"]);
      const first = await a.accept(one!.id);
      expect(first.goesOn).toEqual({ kind: "held", held: 1 });
      expect(await loopState(root)).toBe("waiting");
      const last = await a.accept(two!.id);
      expect(last.goesOn).toEqual(expect.objectContaining({ kind: "done" }));
      expect(await loopState(root)).toBe("done");
      expect(await runsOf(root)).toEqual([run]);
    },
    T,
  );

  it(
    "an answer the stage waits on that still fails: said so, and the app finishes the stage once it passes",
    async () => {
      const root = await metarepo();
      // The first draft went to a person and the stage stopped; a second round was started in the
      // terminal, and the assistant's answer to it keeps the repo and adds a flow nobody knows.
      const run = await started(root, ANSWER);
      await terminal(root, "handoff", "done", run);
      await terminal(root, "change", "feature", CHANGE, "--handoff", "--resume", run);
      const second = await started(root, MIXED);
      expect((await terminal(root, "handoff", "done", second)).code).toBe(1);
      const a = await app(root);
      const r = await a.accept((await a.open())[0]!.id);
      expect(r.goesOn).toEqual(expect.objectContaining({ kind: "failed", runId: second }));
      expect(await loopState(root)).toBe("waiting");
      // The assistant fixes its answer; Done (or the app's own check) passes it, and the app,
      // which kept the stage's resume at the Accept, reads it in: the stage is done.
      await writeFile(join(root, ".runs", CHANGE, second, "feature-answer.yaml"), ANSWER);
      const done = await a.call("POST", `/api/runs/${second}/done`);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(await loopState(root)).toBe("done");
    },
    T,
  );
});
