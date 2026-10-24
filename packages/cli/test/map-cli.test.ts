import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  HandoffRuntime,
  MockRuntime,
  promptBudget,
  ReplayRuntime,
  type AiRequest,
  type AiRuntime,
} from "@maycombhq/ai";
import { parseFacts, type Fact } from "@maycombhq/core";
import type { StepFact } from "../src/commands.js";
import { mapCommand, readAnswer, type MapOptions } from "../src/map-commands.js";

/**
 * atticus map <repo> (ADR 0124 §4): the batched read for an assistant with no file tools (tier 2)
 * and the copy-paste read (tier 3). Every test runs on the hand-off, mock or replay runtime: no
 * model, no network (CLAUDE.md rule 5). The answers are the Forge ledger's reference facts,
 * handed back batch by batch as a model that read each batch would.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";
const NOW = () => new Date("2026-10-24T12:00:00.000Z");
const reference: Fact[] = (() => {
  const r = parseFacts(readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error("fixture");
  return r.facts;
})();

/** A repo adopted in place: `.atticus/org-pack/`, facts under `.atticus/facts/`. */
function adoptedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-map-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  return root;
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  const reported: string[] = [];
  return {
    out,
    err,
    reported,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      report: (f: StepFact) => {
        if ("handoff" in f) reported.push(f.handoff.runId);
      },
    },
  };
};
const factsOf = (root: string) =>
  readFileSync(join(root, ".atticus", "facts", `${REPO}.jsonl`), "utf8")
    .trim()
    .split("\n");

/** The files a prompt carries, from the slice headers it holds. */
const filesIn = (prompt: string) =>
  new Set(
    [...prompt.matchAll(/^(\S+) lines \d+-\d+ of \d+ \(numbered as in the file\)$/gm)].map(
      (m) => m[1]!,
    ),
  );

const idsOf = (f: Fact): string[] => {
  const out: string[] = [];
  if (f.kind === "call" && f.from) out.push(f.from);
  if (f.kind === "store" && f.under) out.push(f.under);
  if (f.kind === "field") out.push(f.owner, ...(f.mappedTo ? [f.mappedTo] : []));
  if (f.kind === "flow") out.push(f.entry, ...f.steps.flatMap((s) => (s.ref ? [s.ref] : [])));
  return out;
};
const filesOf = (f: Fact): string[] =>
  f.kind === "flow"
    ? [f.cite.file, ...f.steps.map((s) => s.cite.file), ...f.errors.map((e) => e.cite.file)]
    : [f.cite.file];

/**
 * A reader that writes, for each batch, the reference facts whose files it has now seen and
 * whose references it can name: what an honest model reading the batches in order would write.
 */
function honestReader(extra: (prompt: string, n: number) => string[] = () => []) {
  const seen = new Set<string>();
  const written = new Set<string>();
  let n = 0;
  return (prompt: string): string => {
    n++;
    for (const f of filesIn(prompt)) seen.add(f);
    const lines: string[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const f of reference) {
        if (written.has(f.id)) continue;
        if (!filesOf(f).every((x) => seen.has(x))) continue;
        if (!idsOf(f).every((id) => written.has(id))) continue;
        written.add(f.id);
        const { verified: _v, by: _b, ...rest } = f;
        lines.push(JSON.stringify(rest));
        changed = true;
      }
    }
    return [...lines, ...extra(prompt, n)].join("\n");
  };
}

describe("atticus map <repo> --estimate: what the first read costs", () => {
  it("prints the checkout, commit, facts file, the source files, the tier and the batches", async () => {
    const root = adoptedRepo();
    const o = io();
    const code = await mapCommand(
      root,
      REPO,
      { estimate: true, commit: COMMIT, maxTokens: 6000 },
      o.io,
    );
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain(`${REPO} at ${COMMIT} in ${root}`);
    expect(text).toContain(`Facts file: .atticus/facts/${REPO}.jsonl`);
    expect(text).toMatch(/12 source files, 190 lines, about \d+ tokens/);
    // runtime.yaml's defaults: Copilot and Claude Code allowed, Copilot the default, in VS Code.
    expect(text).toMatch(/Your assistant: agentic \(tier 1\)\. Copilot in VS Code agent mode/);
    expect(text).toMatch(/In batches at 6000 tokens a prompt: [2-9] prompts/);
  });

  it("says the limit it assumed when none is given, and gives the reading order as JSON", async () => {
    const root = adoptedRepo();
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    expect(o.out.join("\n")).toMatch(
      /at 12078 tokens a prompt \(GPT-4o mini through Copilot; --max-tokens n/,
    );
    const j = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, json: true }, j.io);
    const r = JSON.parse(j.out.join("\n"));
    expect(r.files).toBe(12);
    expect(r.order[0]).toBe("k8s/ledger-api.yaml");
    expect(r.tier.tier).toBe(1);
    expect(r.maxTokensGiven).toBe(false);
  });

  it("refuses without a checkout or a commit", async () => {
    const root = adoptedRepo();
    const o = io();
    expect(await mapCommand(root, REPO, { estimate: true, dir: join(root, "nowhere") }, o.io)).toBe(
      2,
    );
    const p = io();
    expect(await mapCommand(root, REPO, { estimate: true }, p.io)).toBe(2);
    expect(p.err[0]).toMatch(/--commit/);
  });
});

describe("atticus map <repo>: hand-off batches (tier 2)", () => {
  const handoff = (root: string) =>
    new HandoffRuntime({ root, validate: async () => [], now: NOW });
  const opts: MapOptions = { commit: COMMIT, maxTokens: 6000 };

  it("hands one batch at a time, verifies each answer at once, feeds back what was rejected", async () => {
    const root = adoptedRepo();
    const reader = honestReader((prompt, n) =>
      n === 1
        ? [
            // a fabricated line: the route isn't on line 3 of the controller
            JSON.stringify({
              kind: "entry",
              id: "e-made-up",
              entryType: "rest",
              method: "DELETE",
              path: "/accounts/{accountId}",
              cite: {
                file: "src/main/java/forge/ledger/AccountController.java",
                line: 3,
                value: "/accounts/{accountId}",
              },
            }),
            // not a fact at all
            "Here are the facts I found:",
            // a question the code can't settle
            JSON.stringify({
              question: "Is ledger-api deployed to one cluster or to every region?",
              options: [
                { label: "One", means: "a single cluster", changes: "one deploy fact" },
                {
                  label: "Every region",
                  means: "one per region",
                  changes: "a deploy fact per region",
                },
              ],
              evidence: ["k8s/ledger-api.yaml:1"],
            }),
          ]
        : [],
    );
    const runtime = handoff(root);
    const first = io();
    expect(await mapCommand(root, REPO, opts, first.io, { runtime, now: NOW })).toBe(0);
    expect(first.out[0]).toMatch(/Reading forge-ledger at 0123abc in ([2-9]) batches/);
    const batches = Number(/in (\d) batches/.exec(first.out[0]!)![1]);
    expect(first.out[1]).toMatch(/Handed batch 1 of \d to your assistant \(run (run-[\w-]+)\)/);
    expect(first.reported).toHaveLength(1);

    let runId = first.reported[0]!;
    const runsDir = join(root, ".atticus", ".runs", `map-${REPO}`);
    expect(existsSync(join(runsDir, "state.json"))).toBe(true);
    let prompts = 0;
    for (;;) {
      const prompt = readFileSync(join(runsDir, runId, "prompt.md"), "utf8");
      const manifest = JSON.parse(
        readFileSync(join(runsDir, runId, "context-manifest.json"), "utf8"),
      );
      // Every prompt fits the model's limit, frame and all (ADR 0112).
      expect(manifest.totalTokens).toBeLessThanOrEqual(promptBudget(6000));
      prompts++;
      if (prompts === 2) {
        // What was rejected comes back with the lines it cited, and the kept facts by id.
        expect(prompt).toContain("e-made-up was rejected (claim-not-on-line)");
        expect(prompt).toMatch(/^3\| /m);
        expect(prompt).toContain("Lines of your last answer that weren't kept");
        expect(prompt).toContain("Facts already kept");
        expect(prompt).toContain("Questions already on file");
      }
      writeFileSync(join(runsDir, runId, "facts.jsonl"), reader(prompt));
      const o = io();
      const code = await mapCommand(root, REPO, { ...opts, next: true }, o.io, {
        runtime,
        now: NOW,
      });
      if (!o.reported.length) {
        expect(code).toBe(0);
        expect(o.out.at(-2) ?? o.out.at(-1)).toMatch(
          /Read forge-ledger in \d batches: 17 facts kept/,
        );
        break;
      }
      expect(o.out[0]).toMatch(/^(Batch \d of \d|The fix round): /);
      runId = o.reported[0]!;
    }
    expect(prompts).toBe(batches);
    expect(factsOf(root)).toHaveLength(17);
    expect(readdirSync(join(root, ".atticus", "questions"))).toHaveLength(1);
    expect(existsSync(join(root, ".atticus", "facts", `${REPO}.rejected.jsonl`))).toBe(false);
    const report = parse(
      readFileSync(join(root, ".atticus", "facts", `${REPO}.verify.yaml`), "utf8"),
    );
    expect(report.accepted).toBe(17);
  });

  it("says a read is under way instead of starting another, re-offers its run, and --force starts again", async () => {
    const root = adoptedRepo();
    const runtime = handoff(root);
    const a = io();
    await mapCommand(root, REPO, opts, a.io, { runtime, now: NOW });
    const b = io();
    expect(await mapCommand(root, REPO, opts, b.io, { runtime, now: NOW })).toBe(0);
    expect(b.out[0]).toMatch(
      /A read of forge-ledger is under way \(batch 1 of \d, waiting for run/,
    );
    expect(b.reported).toEqual(a.reported);
    // --next before the answer is written: still waiting.
    const c = io();
    expect(await mapCommand(root, REPO, { ...opts, next: true }, c.io, { runtime, now: NOW })).toBe(
      0,
    );
    expect(c.out[0]).toMatch(/still waiting for its result file/);
    const d = io();
    await mapCommand(root, REPO, { ...opts, force: true }, d.io, { runtime, now: NOW });
    expect(d.out[0]).toMatch(/^Reading forge-ledger/);
    expect(d.reported[0]).not.toBe(a.reported[0]);
  });

  it("gives the rejected facts of the last batch one round of their own", async () => {
    const root = adoptedRepo();
    const runtime = handoff(root);
    const bad = JSON.stringify({
      kind: "config",
      id: "cfg-made-up",
      key: "ledger.retries",
      cite: { file: "src/main/resources/application.yml", line: 1, value: "ledger.retries" },
    });
    const a = io();
    await mapCommand(root, REPO, opts, a.io, { runtime, now: NOW });
    let runId = a.reported[0]!;
    const runsDir = join(root, ".atticus", ".runs", `map-${REPO}`);
    const state = () => JSON.parse(readFileSync(join(runsDir, "state.json"), "utf8"));
    let fixPrompt = "";
    for (;;) {
      const s = state();
      const last = s.waiting.batch === s.batches.length - 1;
      const fix = s.waiting.batch === s.batches.length;
      if (fix) fixPrompt = readFileSync(join(runsDir, runId, "prompt.md"), "utf8");
      writeFileSync(join(runsDir, runId, "facts.jsonl"), last || fix ? bad : "");
      const o = io();
      const code = await mapCommand(root, REPO, { ...opts, next: true }, o.io, {
        runtime,
        now: NOW,
      });
      if (!o.reported.length) {
        expect(code).toBe(1);
        expect(o.out.join("\n")).toMatch(/1 still rejected/);
        break;
      }
      runId = o.reported[0]!;
    }
    expect(fixPrompt).toContain("This is the last round: no new files");
    expect(fixPrompt).toContain("cfg-made-up was rejected");
  });
});

describe("atticus map <repo> in model mode: every batch in one call", () => {
  it("reads the whole repo through the runtime, each prompt within the limit", async () => {
    const root = adoptedRepo();
    const reader = honestReader();
    const prompts: AiRequest[] = [];
    const runtime = new MockRuntime(
      (r) => {
        prompts.push(r);
        return reader(r.pack.prompt);
      },
      { now: NOW },
    );
    const o = io();
    const code = await mapCommand(root, REPO, { commit: COMMIT, maxTokens: 6000 }, o.io, {
      runtime,
      now: NOW,
    });
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(prompts.length).toBeGreaterThan(1);
    for (const p of prompts)
      expect(p.pack.manifest.totalTokens).toBeLessThanOrEqual(promptBudget(6000));
    expect(factsOf(root)).toHaveLength(17);
    expect(o.out.at(-2) ?? o.out.at(-1)).toMatch(/17 facts kept/);
  });

  it("replays recorded answers to the same prompts, byte for byte the same facts", async () => {
    const recorded: { agent: string; promptSha256: string; output: string }[] = [];
    const reader = honestReader();
    const live = new MockRuntime(
      (r) => {
        const output = reader(r.pack.prompt);
        recorded.push({ agent: r.agent.id, promptSha256: r.pack.manifest.promptSha256, output });
        return output;
      },
      { now: NOW },
    );
    const a = adoptedRepo();
    await mapCommand(a, REPO, { commit: COMMIT, maxTokens: 6000 }, io().io, {
      runtime: live,
      now: NOW,
    });
    const replay: AiRuntime = new ReplayRuntime(
      recorded.map((r) => ({
        schemaVersion: 1,
        ...r,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "recorded",
        recordedAt: NOW().toISOString(),
      })),
      { now: NOW },
    );
    const b = adoptedRepo();
    const o = io();
    expect(
      await mapCommand(b, REPO, { commit: COMMIT, maxTokens: 6000 }, o.io, {
        runtime: replay,
        now: NOW,
      }),
    ).toBe(0);
    expect(readFileSync(join(b, ".atticus", "facts", `${REPO}.jsonl`), "utf8")).toBe(
      readFileSync(join(a, ".atticus", "facts", `${REPO}.jsonl`), "utf8"),
    );
  });
});

describe("atticus map <repo> --copy: copy-paste (tier 3)", () => {
  it("prints the prompt to paste and reads the answer back from a file or stdin", async () => {
    const root = adoptedRepo();
    const runtime = new HandoffRuntime({ root, validate: async () => [], now: NOW });
    const reader = honestReader();
    const opts: MapOptions = { commit: COMMIT, maxTokens: 6000, copy: true };
    const a = io();
    expect(await mapCommand(root, REPO, opts, a.io, { runtime, now: NOW })).toBe(0);
    const between = (out: string[]) =>
      out
        .slice(out.indexOf("----- copy from here -----") + 1, out.indexOf("----- to here -----"))
        .join("\n");
    let prompt = between(a.out);
    expect(prompt).toContain("This is batch 1 of");
    expect(prompt).toMatch(/^1\| /m);
    expect(a.out.at(-1)).toMatch(/atticus map forge-ledger --copy --answer <file>/);
    const answerFile = join(root, "answer.jsonl");
    for (let n = 0; ; n++) {
      const o = io();
      const text = reader(prompt);
      let code: number;
      if (n % 2 === 0) {
        writeFileSync(answerFile, text);
        code = await mapCommand(root, REPO, { ...opts, answer: answerFile }, o.io, {
          runtime,
          now: NOW,
        });
      } else
        code = await mapCommand(root, REPO, { ...opts, answer: "-" }, o.io, {
          runtime,
          now: NOW,
          stdin: async () => text,
        });
      if (!o.out.includes("----- copy from here -----")) {
        expect(code).toBe(0);
        break;
      }
      prompt = between(o.out);
    }
    expect(factsOf(root)).toHaveLength(17);
  });
});

describe("readAnswer: what a model's answer holds", () => {
  it("keeps facts as the assistant's and unverified, whatever the line claims, and says what it couldn't read", () => {
    const r = readAnswer(
      [
        "```jsonl",
        JSON.stringify({
          kind: "config",
          id: "cfg-db-password",
          key: "spring.datasource.password",
          value: "hunter2",
          cite: { file: "src/main/resources/application.yml", line: 9, value: "password" },
        }),
        JSON.stringify({
          kind: "deploy",
          id: "d-ledger",
          platform: "kubernetes",
          resourceName: "ledger-api",
          verified: "person",
          by: "person",
          cite: { file: "k8s/ledger-api.yaml", line: 4, value: "ledger-api" },
        }),
        "```",
      ].join("\n"),
      REPO,
      COMMIT,
    );
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]).toMatchObject({
      verified: "none",
      by: "assistant",
      repo: REPO,
      commit: COMMIT,
    });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/cfg-db-password.*looks like a secret/);
  });
});

describe("atticus map <repo> --handoff: the step the editors and /atticus-* loops run", () => {
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const { main } = await import("../src/main.js");
    const code = await main(
      args,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out, err };
  };

  it("prints the prompt, the result file and the two finishing commands, batch after batch", async () => {
    const root = adoptedRepo();
    const reader = honestReader();
    const base = ["map", REPO, "--commit", COMMIT, "--max-tokens", "6000", "--root", root];
    let r = await cli([...base, "--handoff"]);
    expect(r.err).toEqual([]);
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(10);
      if (!r.out[0]?.startsWith("Prompt: ")) {
        expect(r.code).toBe(0);
        expect(r.out.join("\n")).toMatch(/Read forge-ledger in \d batches: 17 facts kept/);
        break;
      }
      const prompt = r.out[0]!.slice("Prompt: ".length);
      const result = r.out[1]!.slice("Result file: ".length);
      expect(prompt).toMatch(/^\.atticus\/\.runs\/map-forge-ledger\/run-[\w-]+\/prompt\.md$/);
      expect(result).toMatch(/facts\.jsonl$/);
      writeFileSync(join(root, result), reader(readFileSync(join(root, prompt), "utf8")));
      const done = r.out[3]!.trim().split(" ").slice(1);
      expect((await cli(done)).code).toBe(0);
      const resume = r.out[4]!.trim().split(" ").slice(1);
      expect(resume).toContain("--resume");
      r = await cli(resume);
    }
    expect(factsOf(root)).toHaveLength(17);
  });

  it("estimates through the command line, and lists map as an AI command", async () => {
    const root = adoptedRepo();
    const r = await cli(["map", REPO, "--estimate", "--commit", COMMIT, "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/12 source files/);
    const { commandCatalog } = await import("../src/command-catalog.js");
    const { HELP_TEXT } = await import("../src/main.js");
    const map = commandCatalog(HELP_TEXT).find((c) => c.id === "map")!;
    expect(map.runs).toBe("ai");
    expect(map.area).toBe("repos");
    expect(map.flags.map((f) => f.name)).toEqual(
      expect.arrayContaining(["--estimate", "--copy", "--answer", "--next", "--max-tokens"]),
    );
  });
});
