import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import { changesDirOf, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { critic } from "../src/critic-commands.js";
import { completionOf, handoffDone } from "../src/workspace-commands.js";

/**
 * `atticus critic --mode hand-off`: each AI lens waits for the person's assistant, and
 * `atticus handoff done <run>` (or `critic --resume`) reads its answer into the round.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const RECORDINGS = join(FORGE_CHANGE, "recordings");
const CHANGE = "add-transfer-limit";
const NOW = "2026-10-20T09:00:00Z";
const LATER = "2026-10-21T10:00:00Z";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-critic-handoff-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(r, "org-pack"), { recursive: true });
  for (const x of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...x });
    if (!p.ok) throw new Error(String(x.id));
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(r, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return r;
}

interface Json {
  lenses: { lens: string; agent: string; state: string; runId?: string; reason?: string }[];
  mayProceed: boolean;
  open: { blocking: number; gaps: number };
}

/** The critic at the plan gate in hand-off mode, as JSON. */
async function start(r: string) {
  const c = capture();
  const code = await critic(r, CHANGE, { gate: "plan", mode: "hand-off", json: true }, c.io, {
    env: {},
    now: NOW,
  });
  const j = JSON.parse(c.out.join("\n")) as Json;
  return { code, j, waiting: j.lenses.filter((l) => l.state === "waiting") };
}

/** The recorded answer of a lens (a good assistant's), looked up by the run's prompt hash. */
async function recordedAnswer(r: string, l: { agent: string; runId?: string }) {
  const info = JSON.parse(
    await readFile(join(r, ".runs", CHANGE, l.runId!, "run.json"), "utf8"),
  ) as { request: { pack: { manifest: { promptSha256: string } } } };
  const file = join(RECORDINGS, l.agent, `${info.request.pack.manifest.promptSha256}.json`);
  return (JSON.parse(await readFile(file, "utf8")) as { output: string }).output;
}

const write = (r: string, runId: string, lens: string, text: string) =>
  writeFile(join(r, ".runs", CHANGE, runId, `findings-${lens}.yaml`), text);

describe("atticus critic --mode hand-off", () => {
  it("writes the round, marks each AI lens waiting and lists the runs; it is not a failed lens", async () => {
    const r = await root();
    const c = capture();
    const code = await critic(r, CHANGE, { gate: "plan", mode: "hand-off" }, c.io, {
      env: {},
      now: NOW,
    });
    expect(code).toBe(1);
    expect(c.err).toEqual([]);
    const waiting = (await readdir(join(r, ".runs", CHANGE))).sort();
    expect(waiting.length).toBe(5);
    expect(c.out.filter((l) => /^\w+ lens waiting: /.test(l)).length).toBe(5);
    expect(c.out.join("\n")).not.toMatch(/lens failed/);
    expect(c.out.join("\n")).not.toMatch(/the run ended waiting/);
    for (const id of waiting) expect(c.out.join("\n")).toContain(`atticus handoff done ${id}`);
    expect(c.out.at(-1)).toBe(
      "The plan gate is not decided: 5 AI lenses are with your assistant. Run atticus handoff done <run> for each, then look at the findings again.",
    );

    const s = await start(await root());
    expect(s.code).toBe(1);
    expect(s.j.mayProceed).toBe(false);
    expect(s.waiting.map((l) => l.lens)).toEqual([
      "business",
      "architecture",
      "story",
      "ux",
      "delivery",
    ]);
    expect(s.waiting.every((l) => /^run-/.test(l.runId ?? ""))).toBe(true);
  });

  it("handoff done reads a lens's answer into the round and says what is left", async () => {
    const r = await root();
    const { waiting } = await start(r);
    const [first, ...rest] = waiting;
    await write(r, first!.runId!, first!.lens, await recordedAnswer(r, first!));
    const c = capture();
    expect(await handoffDone(r, first!.runId!, c.io, { now: () => new Date(LATER) })).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out[0]).toMatch(
      /^The business lens of round 1 at the plan gate raised \d+ findings?\.$/,
    );
    expect(c.out.at(-1)).toBe(
      `${rest.length} AI lenses are still with your assistant: ${rest.map((l) => `${l.lens} (atticus handoff done ${l.runId})`).join(", ")}.`,
    );
  });

  it("when the last lens is in, the round's verdict is recomputed and printed", async () => {
    const r = await root();
    const { waiting } = await start(r);
    let last = capture();
    for (const l of waiting) {
      await write(r, l.runId!, l.lens, await recordedAnswer(r, l));
      last = capture();
      expect(await handoffDone(r, l.runId!, last.io, { now: () => new Date(LATER) })).toBe(0);
    }
    expect(last.out.at(-1)).toMatch(/^The plan gate is closed: 14 blocking, 13 open gaps?\./);
    // Same verdict as the replay run: a new critic call (round 2) is not needed to read it.
    const again = capture();
    const { findings } = await import("../src/critic-commands.js");
    expect(await findings(r, CHANGE, { json: true }, again.io)).toBe(0);
    const g = JSON.parse(again.out.join("\n")) as {
      mayProceed: boolean;
      open: { blocking: number };
    }[];
    expect(g[0]).toMatchObject({ mayProceed: false });
    expect(g[0]!.open.blocking).toBe(14);
  });

  it("drops what the lens cannot back with a quote on the line it cites, and says so", async () => {
    const r = await root();
    const { waiting } = await start(r);
    const l = waiting.find((x) => x.lens === "architecture")!;
    await write(
      r,
      l.runId!,
      l.lens,
      "findings:\n  - { rule: not-a-rule, artifact: design.md, summary: x, why: y, evidence: [{ path: design.md, line: 1 }] }\n",
    );
    const c = capture();
    expect(await handoffDone(r, l.runId!, c.io, { now: () => new Date(LATER) })).toBe(0);
    expect(c.out[0]).toBe("The architecture lens of round 1 at the plan gate raised 0 findings.");
    expect(c.err).toEqual([
      "Discarded: it names rule not-a-rule, which this lens wasn't asked to apply",
    ]);
  });

  it("an answer that isn't YAML is refused with what is wrong, and can be fixed and sent again", async () => {
    const r = await root();
    const { waiting } = await start(r);
    const l = waiting[0]!;
    await write(r, l.runId!, l.lens, "findings: [unclosed\n");
    let c = capture();
    expect(await handoffDone(r, l.runId!, c.io)).toBe(1);
    expect(c.err[0]).toMatch(/^findings-business.yaml isn't YAML: /);
    await write(r, l.runId!, l.lens, "findings: []\n");
    c = capture();
    expect(await handoffDone(r, l.runId!, c.io, { now: () => new Date(LATER) })).toBe(0);
    expect(c.out[0]).toBe("The business lens of round 1 at the plan gate raised 0 findings.");
  });

  it("an empty answer or a refusal isn't a review: it is refused, and the lens is still waiting", async () => {
    const r = await root();
    const { waiting } = await start(r);
    const [a, b] = waiting;
    await write(r, a!.runId!, a!.lens, "");
    let c = capture();
    expect(await handoffDone(r, a!.runId!, c.io)).toBe(1);
    expect(c.err[0]).toContain("findings-business.yaml: the output has no findings list");
    await write(r, b!.runId!, b!.lens, "I'm sorry, but I can't help with that.\n");
    c = capture();
    expect(await handoffDone(r, b!.runId!, c.io)).toBe(1);
    expect(c.err[0]).toContain("has no findings list");
    const meta = parse(
      await readFile(join(changesDirOf(r), CHANGE, "review/plan/1/meta/round.yaml"), "utf8"),
    ) as { lenses: { lens: string; state: string }[] };
    expect(meta.lenses.filter((l) => l.state === "ran")).toEqual([]);
  });

  it("an answer in a fenced code block is read, as the critic's parser reads it", async () => {
    const r = await root();
    const { waiting } = await start(r);
    const l = waiting[0]!;
    await write(r, l.runId!, l.lens, "```yaml\nfindings: []\n```\n");
    const c = capture();
    expect(await handoffDone(r, l.runId!, c.io, { now: () => new Date(LATER) })).toBe(0);
  });

  it("--resume reads in every answer that is there and leaves the rest waiting", async () => {
    const r = await root();
    const { waiting } = await start(r);
    for (const l of waiting.slice(0, 2))
      await write(r, l.runId!, l.lens, await recordedAnswer(r, l));
    const c = capture();
    const code = await critic(r, CHANGE, { gate: "plan", resume: true }, c.io, {
      env: {},
      now: LATER,
    });
    expect(code).toBe(1);
    expect(c.err).toEqual([]);
    expect(
      c.out.filter((l) => /^The \w+ lens of round 1 at the plan gate raised/.test(l)).length,
    ).toBe(2);
    expect(c.out.at(-1)).toMatch(
      /^The plan gate is not decided: 3 AI lenses are with your assistant\./,
    );
    // Run again with the rest in: the gate is decided.
    for (const l of waiting.slice(2)) await write(r, l.runId!, l.lens, await recordedAnswer(r, l));
    const d = capture();
    expect(
      await critic(r, CHANGE, { gate: "plan", resume: true }, d.io, { env: {}, now: LATER }),
    ).toBe(1);
    expect(d.out.at(-1)).toMatch(/^The plan gate is closed: 14 blocking, 13 open gaps?\./);
    // Nothing left to resume.
    const e = capture();
    expect(
      await critic(r, CHANGE, { gate: "plan", resume: true }, e.io, { env: {}, now: LATER }),
    ).toBe(1);
    expect(e.out[0]).toBe("No AI lens of the plan gate is waiting for your assistant.");
  });

  it("--resume with nothing started says so", async () => {
    const r = await root();
    const c = capture();
    expect(await critic(r, CHANGE, { gate: "plan", resume: true }, c.io, { env: {} })).toBe(1);
    expect(c.out[0]).toBe("No AI lens of the plan gate is waiting for your assistant.");
  });
});

describe("completionOf and the hand-off runs it routes", () => {
  it("recognises a critic lens's run, the glossary definer's and the story writer's", () => {
    expect(
      completionOf({
        change: CHANGE,
        outputPath: "findings-architecture.yaml",
        outputIn: "run",
      }),
    ).toBe("critic-lens");
    expect(
      completionOf({
        change: "glossary",
        outputPath: "catalog/proposals/glossary-definitions.yaml",
      }),
    ).toBe("glossary");
    expect(completionOf({ change: CHANGE, outputPath: "story-prose.yaml", outputIn: "run" })).toBe(
      "story-prose",
    );
    // The old places still mean what they did.
    expect(completionOf({ change: CHANGE, outputPath: "findings-architecture.yaml" })).toBe(
      "artifact",
    );
    expect(completionOf({ change: "x", outputPath: "stories.md" })).toBe("artifact");
  });

  it("the runtime a lens run was prepared with finds the same files", async () => {
    // A guard for the shape the CLI relies on: the answer is in the run folder.
    const r = await root();
    const { waiting } = await start(r);
    const rt = new HandoffRuntime({ root: r, validate: async () => [] });
    const run = await rt.result(waiting[0]!.runId!);
    expect(run.request).toMatchObject({ outputPath: "findings-business.yaml", outputIn: "run" });
    expect(await readdir(changesDirOf(r))).toEqual([CHANGE]);
  });
});

describe("with AI off in the org pack (ADR 0046)", () => {
  const aiOff = async () => {
    const r = await root();
    const f = join(r, "org-pack/runtime.yaml");
    await writeFile(f, `${await readFile(f, "utf8")}ai: off\n`);
    return r;
  };

  it("runs the rule checks alone, records each lens as not run, and the gate waits for nothing", async () => {
    const r = await aiOff();
    const s = await start(r);
    expect(s.waiting).toEqual([]);
    expect(s.j.lenses.every((l) => l.state === "skipped")).toBe(true);
    expect(
      s.j.lenses.filter((l) => /AI is off here/.test(l.reason ?? "")).map((l) => l.lens),
    ).toEqual(["business", "architecture", "story", "ux", "delivery"]);
    await expect(readdir(join(r, ".runs"))).rejects.toThrow();
  });

  it("refuses to start an AI step, saying what to do instead", async () => {
    const r = await aiOff();
    const { main } = await import("../src/main.js");
    const c = capture();
    const code = await main(["plan", "stories", CHANGE, "--root", r], c.io);
    expect(code).not.toBe(0);
    expect(c.err.join("\n")).toMatch(/AI is off here .*Write the artifact yourself/);
  });
});

describe("atticus critic <change> --handoff --json (ADR 0106 addendum)", () => {
  interface Handed {
    state: string;
    runId?: string;
    resultFile?: string;
    doneArgs?: string[];
    resumeArgs?: string[];
    messages?: string[];
  }
  const step = async (argv: string[]) => {
    const { main } = await import("../src/main.js");
    const c = capture();
    const code = await main(argv, c.io, { quiet: true });
    return { code, j: JSON.parse(c.out.join("\n")) as Handed, err: c.err };
  };
  const agentOf = async (r: string, runId: string) =>
    (
      JSON.parse(await readFile(join(r, ".runs", CHANGE, runId, "run.json"), "utf8")) as {
        request: { agent: { id: string } };
      }
    ).request.agent.id;

  it("hands the AI lenses off one at a time, oldest first, and ends with the gate's verdict", async () => {
    const r = await root();
    let s = await step(["critic", CHANGE, "--gate", "plan", "--handoff", "--json", "--root", r]);
    const offered: string[] = [];
    for (let i = 0; s.j.state === "handoff" && i < 10; i++) {
      const runId = s.j.runId!;
      offered.push(/findings-(\w+)\.yaml$/.exec(s.j.resultFile!)![1]!);
      await writeFile(
        join(r, s.j.resultFile!),
        await recordedAnswer(r, { agent: await agentOf(r, runId), runId }),
      );
      const { main } = await import("../src/main.js");
      expect(await main(s.j.doneArgs!, capture().io, { quiet: true })).toBe(0);
      s = await step(s.j.resumeArgs!);
    }
    expect(offered).toEqual(["business", "architecture", "story", "ux", "delivery"]);
    expect(s.j.state).toBe("stopped");
    expect(s.j.messages?.at(-1)).toMatch(/^The plan gate is closed: 14 blocking/);
  });

  it("counts as an AI step, and critic stats doesn't", async () => {
    const { isHandoffStep } = await import("../src/handoff-flag.js");
    expect(isHandoffStep("critic", CHANGE)).toBe(true);
    expect(isHandoffStep("critic", "stats")).toBe(false);
    expect(isHandoffStep("critic", undefined)).toBe(false);
  });
});
