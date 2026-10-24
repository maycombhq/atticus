import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ASSISTANT_FORMATS,
  assistantTier,
  probeFileOf,
  probeTier,
  writeProbe,
  type ProbeResult,
} from "@maycombhq/assistant-files";
import {
  AssistantId,
  loadOrgPack,
  orgPackDirOf,
  runsDirOf,
  runsRelOf,
  type Runtime,
} from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * `atticus probe` and `atticus probe answer` (ADR 0124 §4, addendum A-probe): the tier the
 * person's assistant reads a repo at, measured rather than inferred from runtime.yaml.
 *
 * `atticus probe` writes `.runs/probe/challenge.md` holding a code it never prints, and says what
 * to do in the assistant: `/atticus-probe` asks it to open that file, write the code to
 * `answer.txt` beside it and run `atticus probe answer <code>` itself. The answer proves each
 * capability: the right code (it read the file), the answer file holding it (it wrote one), and
 * the command run without `--pasted` (it ran a command). A wrong code records nothing. The model's
 * limit is what `--max-tokens` states, at the start or on the answer; nothing guesses it.
 *
 * Everything stays on this machine: the challenge in the run folder, the result in
 * `.atticus/probe/<assistant>.yaml` (never committed). No shared system is touched.
 */

export interface ProbeDeps {
  now?: () => Date;
  /** The challenge's code; random unless a test gives one. */
  code?: () => string;
}

/** How long a challenge can be answered. */
const OPEN_HOURS = 24;

const Challenge = z.strictObject({
  schemaVersion: z.literal(1),
  assistant: AssistantId,
  code: z.string().regex(/^[0-9a-f]{8}$/),
  started: z.iso.datetime(),
  maxTokens: z.number().int().min(1000).optional(),
});
type Challenge = z.infer<typeof Challenge>;

const probeDir = (root: string) => join(runsDirOf(root), "probe");
const probeRel = (root: string) => `${runsRelOf(root)}/probe`;

/** How a person starts the probe in each assistant. */
function startIn(id: AssistantId): string {
  const f = ASSISTANT_FORMATS[id];
  return id === "agents-md"
    ? `In ${f.typeIn}, ask it to follow ${f.commandPath("atticus-probe")}.`
    : `In ${f.typeIn}, run /atticus-probe.`;
}

/** atticus probe [--assistant id] [--max-tokens n] [--json] */
export async function probeCommand(
  root: string,
  o: { assistant?: string; maxTokens?: number; json?: boolean },
  io: Output,
  deps: ProbeDeps = {},
): Promise<number> {
  const rt: Runtime = (await loadOrgPack(orgPackDirOf(root))).runtime;
  if (rt.ai === "off") {
    io.err("AI is off here (runtime.yaml): there is no assistant to probe.");
    return 1;
  }
  const want = o.assistant ?? rt.assistants.default;
  const id = AssistantId.safeParse(want);
  if (!id.success || !rt.assistants.allowed.includes(id.data)) {
    io.err(
      `runtime.yaml doesn't allow ${want} here: it allows ${rt.assistants.allowed.join(", ")}.`,
    );
    return 2;
  }
  const assistant = id.data;
  const now = (deps.now ?? (() => new Date()))();
  const challenge: Challenge = {
    schemaVersion: 1,
    assistant,
    code: deps.code?.() ?? randomBytes(4).toString("hex"),
    started: now.toISOString(),
    ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
  };
  const dir = probeDir(root);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "probe.json"), `${JSON.stringify(challenge, null, 2)}\n`, "utf8");
  await writeFile(
    join(dir, "challenge.md"),
    [
      "# Atticus capability probe",
      "",
      `Code: ${challenge.code}`,
      "",
      `Atticus wrote this file at ${challenge.started} for /atticus-probe. The steps of /atticus-probe say what to do with the code.`,
      "",
    ].join("\n"),
    "utf8",
  );
  const rel = probeRel(root);
  const name = ASSISTANT_FORMATS[assistant].name;
  const result = probeFileOf(assistant);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          assistant,
          challenge: `${rel}/challenge.md`,
          answerFile: `${rel}/answer.txt`,
          result,
          started: challenge.started,
          expires: new Date(now.getTime() + OPEN_HOURS * 3600_000).toISOString(),
          ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(`Probing ${name} (another assistant runtime.yaml allows: --assistant <id>).`);
  io.out(
    `${startIn(assistant)} It asks the assistant to open ${rel}/challenge.md, write the code it holds to ${rel}/answer.txt, and run atticus probe answer <code> itself.`,
  );
  io.out(
    "An assistant that can't run commands gives you a line to paste in this terminal instead: atticus probe answer <code> --pasted.",
  );
  io.out(
    "A chat with no /atticus-probe (a web chat) can't open files here: run atticus probe answer none --pasted.",
  );
  if (o.maxTokens === undefined)
    io.out(
      "Give your model's limit, the most tokens it takes in one prompt, with --max-tokens <n> on the answer if you know it: Atticus never guesses it.",
    );
  else io.out(`Model limit: ${o.maxTokens} tokens, as you stated it.`);
  io.out(
    `The probe is open for ${OPEN_HOURS} hours. Nothing leaves this machine: the answer is checked here and kept in ${result}.`,
  );
  return 0;
}

const yesNo = (b: boolean) => (b ? "yes" : "no");

/** atticus probe answer <code|none> [--pasted] [--max-tokens n] [--json] */
export async function probeAnswerCommand(
  root: string,
  given: string | undefined,
  o: { pasted?: boolean; maxTokens?: number; json?: boolean },
  io: Output,
  deps: ProbeDeps = {},
): Promise<number> {
  if (!given) {
    io.err("Usage: atticus probe answer <code|none> [--pasted] [--max-tokens n] [--json]");
    return 2;
  }
  const dir = probeDir(root);
  const rel = probeRel(root);
  const parsed = Challenge.safeParse(
    await readFile(join(dir, "probe.json"), "utf8")
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => undefined),
  );
  if (!parsed.success) {
    io.err("No probe is under way here: start one with atticus probe.");
    return 1;
  }
  const c = parsed.data;
  const now = (deps.now ?? (() => new Date()))();
  if (now.getTime() - Date.parse(c.started) > OPEN_HOURS * 3600_000) {
    io.err(
      `The probe started at ${c.started} is more than ${OPEN_HOURS} hours old: start a new one with atticus probe.`,
    );
    return 1;
  }
  const code = given.trim().toLowerCase();
  if (code !== "none" && code !== c.code) {
    io.err(
      `${given.trim()} isn't the code in ${rel}/challenge.md: the assistant didn't read that file. Nothing was recorded. Run /atticus-probe again, or answer none if the assistant can't open files.`,
    );
    return 1;
  }
  const answerFile = join(dir, "answer.txt");
  const written = existsSync(answerFile)
    ? (await readFile(answerFile, "utf8").catch(() => "")).trim().toLowerCase()
    : undefined;
  const read = code === c.code;
  const write = written === c.code;
  const run = o.pasted !== true;
  const maxTokens = o.maxTokens ?? c.maxTokens;
  const result: ProbeResult = {
    schemaVersion: 1,
    assistant: c.assistant,
    measured: now.toISOString(),
    tier: probeTier({ read, write, run }),
    read,
    write,
    run,
    answered: run ? "command" : "pasted",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  const file = await writeProbe(root, result);
  await rm(dir, { recursive: true, force: true });

  // How the first read runs at the measured tier, said as doctor and map --estimate will say it.
  const rt = (await loadOrgPack(orgPackDirOf(root))).runtime;
  const t = assistantTier(
    { ...rt, assistants: { allowed: [c.assistant], default: c.assistant } },
    { probes: [result], now },
  );
  if (o.json) {
    io.out(JSON.stringify({ ...result, file, how: t.how }, null, 2));
    return 0;
  }
  const name = ASSISTANT_FORMATS[c.assistant].name;
  io.out(
    `Measured ${name}: opened the file Atticus wrote: ${yesNo(read)}; wrote a file: ${
      write ? "yes" : written === undefined ? "no" : `no (${rel}/answer.txt doesn't hold the code)`
    }; ran a command itself: ${run ? "yes" : "no (the line was pasted)"}. That is ${
      result.tier === 1
        ? "agentic (tier 1)"
        : result.tier === 2
          ? "batched hand-off (tier 2)"
          : "copy-paste (tier 3)"
    }.`,
  );
  io.out(`The first read of a repo: ${t.how}`);
  io.out(
    maxTokens !== undefined
      ? `Model limit: ${maxTokens} tokens, as stated.`
      : "No model limit was stated: atticus probe --max-tokens <n> measures again with it, or give --max-tokens <n> on each atticus map.",
  );
  io.out(
    `Kept in ${file}, on this machine only (never committed). atticus doctor, init, adopt and map --estimate say this tier from now on.`,
  );
  return 0;
}
