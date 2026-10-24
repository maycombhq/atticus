import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { ApiError } from "../src/api/client.js";
import { COPY } from "../src/copy.js";
import { runChoice, runOnServer, RunStepView, stepArgs } from "../src/app/runstep.js";
import { RunDetail, RunsTable, runsHref, shownRuns } from "../src/screens/runs/Runs.js";
import { AiStep } from "../src/screens/knowledge/shared.js";
import { RunNextPanel } from "../src/screens/work/RunNext.js";

/**
 * ADR 0106: the Model runs screen (what Atticus asked a model and what it answered), and the
 * Run button on an AI step: Run with Copilot in a VS Code panel, Run with the server's model in
 * a browser where runtime.yaml sets one, else the command to copy. Invented Forge data only
 * (CLAUDE.md rule 3); no network (rule 5): the server calls are stubs.
 */

const R = COPY.runs;
const S = COPY.runStep;
const F = COPY.filter;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type Item = Api.RunListItem;
const run = (n: number, over: Partial<Item> = {}): Item => ({
  schemaVersion: 3,
  runId: `run-2026102303400${n}-0001`,
  change: "knowledge-scan",
  agent: "knowledge-reader",
  runtime: "hand-off",
  state: "validated",
  startedAt: `2026-10-23T03:40:0${n}Z`,
  contextManifestSha256: "0".repeat(64),
  errors: [],
  attempt: 1,
  answered: true,
  handedBack: 0,
  ...over,
});
const runs = [
  run(3, { state: "waiting", answered: false }),
  run(2, { attempt: 2, handedBack: 2 }),
  run(1, { change: "add-transfer-limit", agent: "story-writer" }),
];

describe("the list of model runs", () => {
  it("filters on step, agent, run id and state, case aside", () => {
    expect(shownRuns(runs, "").map((r) => r.runId)).toEqual(runs.map((r) => r.runId));
    expect(shownRuns(runs, "STORY").map((r) => r.change)).toEqual(["add-transfer-limit"]);
    expect(shownRuns(runs, "waiting").map((r) => r.runId)).toEqual([runs[0]!.runId]);
    expect(shownRuns(runs, "run-20261023034002")).toHaveLength(1);
    expect(shownRuns(runs, "nothing like it")).toEqual([]);
  });

  it("shows each run newest first with its step, agent, round, state, answer and problems", () => {
    const out = html(
      <RunsTable of={{ state: "ready", data: { runs, serverModel: null } }} text="" />,
    );
    expect(out).toContain(`placeholder="${F.placeholder}"`);
    for (const c of Object.values(R.cols)) expect(out).toContain(c);
    expect(out).toContain(`href="#/runs?run=${runs[1]!.runId}"`);
    expect(out.indexOf(runs[0]!.runId)).toBeLessThan(out.indexOf(runs[2]!.runId));
    expect(out).toContain(R.states.waiting);
    expect(out).toContain(R.problems(2));
    expect(out).toContain(R.notYet);
    expect(out).toContain(">story-writer<");
  });

  it("says what was filtered, and offers to clear it", () => {
    const none = html(
      <RunsTable
        of={{ state: "ready", data: { runs, serverModel: null } }}
        text="nothing like it"
        onClear={() => {}}
      />,
    );
    expect(none).toContain(esc(F.nothingMatches(F.words("nothing like it"))));
    expect(none).toContain(F.clear);
    expect(none).toContain(F.shown(0, 3));
  });

  it("has loading, error and empty states, and says when it shows one change", () => {
    const at = (of: Parameters<typeof RunsTable>[0]["of"], change?: string) =>
      html(<RunsTable of={of} text="" {...(change ? { change } : {})} />);
    expect(at({ state: "loading" })).toContain('aria-busy="true"');
    expect(at({ state: "error", error: "Boom" })).toContain('role="alert"');
    expect(at({ state: "ready", data: { runs: [], serverModel: null } })).toContain(esc(R.empty));
    const one = at({ state: "ready", data: { runs: [], serverModel: null } }, "add-transfer-limit");
    expect(one).toContain(esc(R.emptyFor("add-transfer-limit")));
    expect(one).toContain(esc(R.onlyFor("add-transfer-limit")));
    expect(one).toContain('href="#/runs"');
  });

  it("links a step's page to its runs", () => {
    expect(runsHref({ change: "add-transfer-limit" })).toBe("#/runs?change=add-transfer-limit");
    expect(runsHref({ q: "knowledge" })).toBe("#/runs?q=knowledge");
    expect(runsHref({ run: "run-1-0001" })).toBe("#/runs?run=run-1-0001");
    expect(runsHref({})).toBe("#/runs");
  });
});

const transcript: Api.RunTranscript = {
  run: runs[1]!,
  prompt: '# Task: read the pages\n<script>alert("no")</script>\n',
  answer: "items:\n  - id: firewall-rule-request\n    title: Network firewall rule\n",
  handedBack: [
    {
      attempt: 1,
      problems: [
        "team ledger-team: quote: the quote is not on the page, word for word",
        "request firewall-rule-request: title: Invalid input",
      ],
      previousAnswer: "items:\n  - id: firewall-rule-request",
    },
  ],
  rounds: [
    { runId: runs[2]!.runId, attempt: 1, state: "validated", startedAt: runs[2]!.startedAt },
    { runId: runs[1]!.runId, attempt: 2, state: "validated", startedAt: runs[1]!.startedAt },
  ],
};

describe("one model run", () => {
  it("shows the prompt and the answer as text in their own scrolling boxes, never as markup", () => {
    const out = html(<RunDetail of={{ state: "ready", data: transcript }} />);
    expect(out).toContain(R.prompt);
    expect(out).toContain(R.answer);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;");
    expect(out).toContain("<pre");
    expect(out).toContain('tabindex="0"');
    expect(out).toContain(`aria-label="${esc(R.textBox(R.prompt))}"`);
    expect(out).toContain("title: Network firewall rule");
  });

  it("shows each earlier round's problems with the answer that failed them", () => {
    const out = html(<RunDetail of={{ state: "ready", data: transcript }} />);
    expect(out).toContain(R.roundProblems(1));
    expect(out).toContain("title: Invalid input");
    expect(out).toContain(R.failedAnswer(1));
    expect(out).toContain("items:\n  - id: firewall-rule-request</pre>");
  });

  it("shows what the model looked up: each tool call, its input and what it gave back, as text (ADR 0107)", () => {
    const out = html(
      <RunDetail
        of={{
          state: "ready",
          data: {
            ...transcript,
            tools: {
              offered: ["search", "show", "walk", "show_code"],
              calls: [
                {
                  round: 1,
                  name: "show",
                  input: { id: "forge-ledger" },
                  output: '<atticus-data id="tool-show">System forge-ledger</atticus-data>',
                  tokens: 9,
                },
                {
                  round: 2,
                  name: "show_code",
                  input: { id: "nope" },
                  output: "There is nothing called nope in the index.",
                  tokens: 11,
                  error: true,
                },
              ],
              stopped: "rounds: the 6 rounds of tool calls a run may make were used",
            },
          },
        }}
      />,
    );
    expect(out).toContain(R.tools.title);
    expect(out).toContain(esc(R.tools.offered("search, show, walk, show_code", 2)));
    expect(out).toContain(esc(R.tools.call(2, "show_code", 11, true)));
    expect(out).toContain("&lt;atticus-data id=&quot;tool-show&quot;&gt;System forge-ledger");
    expect(out).not.toContain("<atticus-data");
    expect(out).toContain(
      esc(R.tools.stopped("rounds: the 6 rounds of tool calls a run may make were used")),
    );
    // A run with no tools shows no tools section.
    expect(html(<RunDetail of={{ state: "ready", data: transcript }} />)).not.toContain(
      R.tools.title,
    );
  });

  it("shows how the context was found: the model's reading of the input and its order of the candidates (ADR 0116)", () => {
    const out = html(
      <RunDetail
        of={{
          state: "ready",
          data: {
            ...transcript,
            retrieval: {
              expansion: {
                run: "run-20261021-0001",
                cached: false,
                terms: ["daily limit"],
                names: [{ name: "Quillfeather Risk", quote: "scored by Quillfeather Risk" }],
                dropped: [{ name: "Ledger", why: "no id ledgr in the index" }],
              },
              rerank: {
                cached: true,
                shown: 40,
                order: ["Column a"],
                dropped: ["System b"],
                used: true,
              },
              meaning: "similar in meaning is off: retrieval.embeddings.model is off",
            },
          },
        }}
      />,
    );
    expect(out).toContain(R.retrieval.title);
    expect(out).toContain(esc(R.retrieval.expansion("run-20261021-0001", false)));
    expect(out).toContain(
      esc(R.retrieval.name("Quillfeather Risk", undefined, false, "scored by Quillfeather Risk")),
    );
    expect(out).toContain(esc(R.retrieval.dropped("Ledger", "no id ledgr in the index")));
    expect(out).toContain(esc(R.retrieval.rerank(40, "Column a", "System b")));
    expect(html(<RunDetail of={{ state: "ready", data: transcript }} />)).not.toContain(
      R.retrieval.title,
    );
  });

  it("links the rounds of the step, marking this one", () => {
    const out = html(<RunDetail of={{ state: "ready", data: transcript }} />);
    expect(out).toContain(`href="#/runs?run=${runs[2]!.runId}"`);
    expect(out).toMatch(new RegExp(`href="#/runs\\?run=${runs[1]!.runId}" aria-current="page"`));
  });

  it("says when there is no answer yet, nothing handed back, or no such run", () => {
    const first = html(
      <RunDetail
        of={{
          state: "ready",
          data: { ...transcript, answer: undefined, handedBack: [], run: runs[0]! },
        }}
      />,
    );
    expect(first).toContain(esc(R.noAnswer));
    expect(first).toContain(esc(R.noneHandedBack));
    expect(html(<RunDetail of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<RunDetail of={{ state: "error", error: "There is no run x." }} />)).toContain(
      'role="alert"',
    );
  });
});

describe("which Run button an AI step gets (ADR 0106)", () => {
  it("takes an AI step's command words and arguments from its command, and nothing else", () => {
    expect(stepArgs("atticus change feature add-transfer-limit")).toEqual([
      "change",
      "feature",
      "add-transfer-limit",
    ]);
    expect(stepArgs("atticus knowledge scan")).toEqual(["knowledge", "scan"]);
    expect(stepArgs('atticus knowledge find "firewall rule"')).toEqual([
      "knowledge",
      "find",
      "firewall rule",
    ]);
    expect(stepArgs("atticus critic add-transfer-limit")).toEqual(["critic", "add-transfer-limit"]);
    expect(stepArgs("atticus critic stats")).toBeUndefined();
    // Not an AI step, an option, a placeholder or not atticus at all: no Run button.
    expect(stepArgs("atticus scan")).toBeUndefined();
    expect(stepArgs("atticus change handoff add-transfer-limit --approve")).toBeUndefined();
    expect(stepArgs("atticus scan survey forge-ledger --force")).toBeUndefined();
    expect(stepArgs('atticus change new "<title>" --type <type>')).toBeUndefined();
    expect(stepArgs("atticus repos discover <folder>")).toBeUndefined();
    expect(stepArgs("/atticus-feature add-transfer-limit")).toBeUndefined();
  });

  it("is Copilot in a VS Code panel, the server's model in a browser that has one, else copy", () => {
    expect(runChoice({ panel: true, serverModel: null })).toEqual({ kind: "copilot" });
    expect(runChoice({ panel: true, serverModel: "anthropic" })).toEqual({ kind: "copilot" });
    expect(runChoice({ panel: false, serverModel: "anthropic" })).toEqual({
      kind: "model",
      model: "anthropic",
    });
    expect(runChoice({ panel: false, serverModel: null })).toEqual({ kind: "copy" });
    // Not known yet: the copy, as today, until the server says.
    expect(runChoice({ panel: false, serverModel: undefined })).toEqual({ kind: "copy" });
  });

  it("shows Run with Copilot, Run with the model, or nothing beside the copy", () => {
    const idle = { phase: "idle" as const, lines: [] };
    expect(html(<RunStepView choice={{ kind: "copilot" }} state={idle} />)).toContain(
      S.withCopilot,
    );
    expect(
      html(<RunStepView choice={{ kind: "model", model: "anthropic" }} state={idle} />),
    ).toContain(S.withModel("anthropic"));
    expect(html(<RunStepView choice={{ kind: "copy" }} state={idle} />)).toBe("");
  });

  it("offers Cancel while a step runs on the server, and says it is stopping (ADR 0119)", () => {
    const state = { phase: "running" as const, lines: ["Started on the server with anthropic."] };
    const model = { kind: "model" as const, model: "anthropic" };
    const can = html(<RunStepView choice={model} state={state} onCancel={() => undefined} />);
    expect(can).toContain(`>${S.cancel}</button>`);
    expect(can).toContain(esc(S.cancelHint));
    const stopping = html(
      <RunStepView choice={model} state={state} onCancel={() => undefined} stopping />,
    );
    expect(stopping).toContain(S.cancelling);
    // Copilot stops in its own chat: no Cancel here.
    expect(html(<RunStepView choice={{ kind: "copilot" }} state={state} />)).not.toContain(
      `>${S.cancel}</button>`,
    );
  });

  it("tells the page the server job's id, so it can cancel it", async () => {
    let told: string | undefined;
    const calls: string[] = [];
    await runOnServer(["change", "feature", "add-transfer-limit"], {
      call: async <R,>(path: string) => {
        calls.push(path);
        if (path === "/api/runs") return { jobId: "job-7", model: "anthropic" } as R;
        return { state: "cancelled", startedAt: "2026-10-23T00:00:00Z", errors: [] } as R;
      },
      wait: async () => undefined,
      onLine: () => undefined,
      onJob: (j) => (told = j),
    });
    expect(told).toBe("job-7");
  });

  it("is disabled while the step runs and says why, shows the lines as they come, then the end", () => {
    const running = html(
      <RunStepView
        choice={{ kind: "copilot" }}
        state={{ phase: "running", lines: ["Copilot is writing the brief"] }}
      />,
    );
    expect(running).toContain("disabled");
    expect(running).toContain(S.running);
    expect(running).toContain(esc(S.busy));
    expect(running).toContain('aria-live="polite"');
    expect(running).toContain("Copilot is writing the brief");
    const ended = html(
      <RunStepView
        choice={{ kind: "copilot" }}
        state={{
          phase: "ended",
          lines: [],
          end: { state: "done", lines: ["Wrote brief.md"], runId: "run-20261023034001-0001" },
        }}
      />,
    );
    expect(ended).not.toContain("disabled");
    expect(ended).toContain(esc(S.ends.done!));
    expect(ended).toContain("Wrote brief.md");
    expect(ended).toContain('href="#/runs?run=run-20261023034001-0001"');
    expect(ended).toContain(S.openRun);
    const noRun = html(
      <RunStepView
        choice={{ kind: "model", model: "anthropic" }}
        state={{ phase: "ended", lines: [], end: { state: "weird", lines: [] } }}
      />,
    );
    expect(noRun).toContain(S.ended("weird"));
    expect(noRun).toContain('href="#/runs"');
  });

  it("says in words when the extension refused the step or couldn't start it, with no run link", () => {
    for (const state of ["refused", "not-started"]) {
      const out = html(
        <RunStepView
          choice={{ kind: "copilot" }}
          state={{
            phase: "ended",
            lines: [],
            end: { state, lines: ["--force would be read as an option"] },
          }}
        />,
      );
      expect(out).toContain(esc(S.refused("--force would be read as an option")));
      expect(out).not.toContain('href="#/runs');
    }
    const long = html(
      <RunStepView
        choice={{ kind: "copilot" }}
        state={{ phase: "ended", lines: [], end: { state: "too-many-rounds", lines: [] } }}
      />,
    );
    expect(long).toContain(esc(S.ends["too-many-rounds"]!));
  });

  it("shows a refusal's detail", () => {
    const out = html(
      <RunStepView
        choice={{ kind: "model", model: "anthropic" }}
        state={{
          phase: "error",
          lines: [],
          error: "This server's runtime.yaml configures no model",
        }}
      />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(S.cantStart("This server's runtime.yaml configures no model")));
  });

  it("keeps the copy buttons beside the Run button on every AI step the app shows", () => {
    const step = html(
      <AiStep command="atticus change needs add-transfer-limit" slash="/atticus-needs x" />,
    );
    expect(step).toContain(COPY.knowledge.ai.copy);
    expect(step).toContain(COPY.knowledge.ai.copySlash);
    const next = html(
      <RunNextPanel
        step={{ command: "atticus change feature add-transfer-limit", why: COPY.work.why.feature }}
      />,
    );
    expect(next).toContain(COPY.runNext.copy);
  });
});

/** A stub of the local API: what each call answers, and the calls made. No network. */
function stubApi(answers: Record<string, unknown[]>) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const call = async <T,>(path: string, o: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: o.method ?? "GET", ...(o.body ? { body: o.body } : {}) });
    const key = `${o.method ?? "GET"} ${path}`;
    const next = answers[key]?.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error(`no answer for ${key}`);
    return next as T;
  };
  return { call, calls };
}

describe("Run with the server's model, in a browser (ADR 0106)", () => {
  const job = (state: string, message: string, result?: unknown) => ({
    id: "job-1",
    kind: "step",
    state,
    progress: { done: state === "running" ? 0 : 1, total: 1, message },
    startedAt: "2026-10-23T03:40:00Z",
    errors: [],
    ...(result ? { result } : {}),
  });

  it("starts the step, follows its job, and ends with the run it made", async () => {
    const api = stubApi({
      "POST /api/runs": [{ jobId: "job-1", model: "anthropic" }],
      "GET /api/jobs/job-1": [
        job("running", "Running atticus scan survey forge-ledger with anthropic"),
        job("running", "Running atticus scan survey forge-ledger with anthropic"),
        job("done", "Done", { code: 0, lines: ["Wrote scan-settings.yaml"] }),
      ],
      "GET /api/runs?limit=1": [{ runs: [run(4, { startedAt: "2026-10-23T03:40:01Z" })] }],
    });
    const lines: string[] = [];
    const end = await runOnServer(["scan", "survey", "forge-ledger"], {
      call: api.call,
      wait: async () => {},
      onLine: (l) => lines.push(l),
    });
    expect(api.calls[0]).toEqual({
      path: "/api/runs",
      method: "POST",
      body: { args: ["scan", "survey", "forge-ledger"] },
    });
    expect(lines).toEqual([
      S.started("anthropic"),
      "Running atticus scan survey forge-ledger with anthropic",
      "Done",
    ]);
    expect(end).toEqual({
      state: "done",
      lines: ["Wrote scan-settings.yaml"],
      runId: "run-20261023034004-0001",
    });
  });

  it("links to the run the server names in the job's result, without guessing", async () => {
    const api = stubApi({
      "POST /api/runs": [{ jobId: "job-1", model: "anthropic" }],
      "GET /api/jobs/job-1": [
        job("done", "Done", { code: 0, lines: ["Wrote scan-settings.yaml"], runId: "run-7" }),
      ],
    });
    const end = await runOnServer(["scan", "survey", "forge-ledger"], {
      call: api.call,
      wait: async () => {},
      onLine: () => {},
    });
    expect(end).toEqual({ state: "done", lines: ["Wrote scan-settings.yaml"], runId: "run-7" });
    expect(api.calls.map((c) => c.path)).not.toContain("/api/runs?limit=1");
  });

  it("says it stopped when the step's exit code isn't 0, and names no older run", async () => {
    const api = stubApi({
      "POST /api/runs": [{ jobId: "job-1", model: "anthropic" }],
      "GET /api/jobs/job-1": [job("done", "Stopped", { code: 1, lines: ["The checks failed"] })],
      "GET /api/runs?limit=1": [{ runs: [run(1, { startedAt: "2026-10-22T00:00:00Z" })] }],
    });
    const end = await runOnServer(["scan", "survey", "forge-ledger"], {
      call: api.call,
      wait: async () => {},
      onLine: () => {},
    });
    expect(end).toEqual({ state: "stopped", lines: ["The checks failed"] });
  });

  it("passes on a 409 or 400 with its detail, and starts nothing", async () => {
    const refused = new ApiError({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "This server's runtime.yaml configures no model, so it can't run an AI step.",
    });
    const api = stubApi({ "POST /api/runs": [refused] });
    await expect(
      runOnServer(["scan", "survey", "forge-ledger"], {
        call: api.call,
        wait: async () => {},
        onLine: () => {},
      }),
    ).rejects.toBe(refused);
    expect(api.calls).toHaveLength(1);
  });
});
