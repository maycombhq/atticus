import type { NextRow } from "./next-rows";
import type { NextStep, QueueEntry } from "./types";
import { WORDS } from "./words";

/**
 * What beta.10 added to the command line, as the extension's own commands (the palette, the
 * views' menus and `@atticus`): each runs the command line as Run a command does, a report shown
 * whole in a read-only tab, a write that moves or archives files only after a person's yes, and
 * points to the app page or the Copilot Chat step that goes with it. No `vscode` here, so what
 * each runs is tested outside the editor; jobs-ui.ts asks and runs.
 */

/** What a job is given: picked from the metarepo's lists, a file, or typed. */
export interface JobArgs {
  repo?: string;
  change?: string;
  file?: string;
  source?: string;
  old?: string;
  new?: string;
  /** The model's limit, in tokens (map --all, ADR 0161). */
  maxTokens?: string;
}

/** What a job asks for before it runs. */
export type JobNeeds =
  "repo" | "repo-or-estate" | "change" | "reference" | "sheet" | "traffic" | "rename" | "limit";

export interface Job {
  /** The VS Code command. */
  command: string;
  /** Its title in the Command Palette (package.json says the same; the manifest test holds it). */
  title: string;
  needs?: JobNeeds;
  /** The command line's words, from what was given. */
  argv: (a: JobArgs) => string[];
  /**
   * report: read-only, what it printed shown whole in a tab; run: what it printed in a notice;
   * confirm: a person's yes first (it moves or archives files in the metarepo); chat: only opens
   * Copilot Chat on a step; terminal: a long-running command in a terminal the person sees and
   * types into (map --all waits on Copilot and reads s, r and q, ADR 0161).
   */
  how: "report" | "run" | "confirm" | "chat" | "terminal";
  /** The app page that shows the same, offered after it ran. */
  app?: (a: JobArgs) => string;
  /** The step to open in Copilot Chat (agent mode where its agent file is there). */
  chat?: (a: JobArgs) => { step: string; target?: string };
}

const req = (v: string | undefined, what: string) => {
  if (!v) throw new Error(`a ${what} is needed`);
  return v;
};

/**
 * ADR 0161: runtime.yaml's `maxInput` (under adapters.model), the limit map --all is offered with;
 * undefined when it names none. A line read, not a YAML parse: the editor only pre-fills a box.
 */
export function runtimeMaxInput(runtimeYaml: string | undefined): string | undefined {
  const m = /^\s*maxInput:\s*(\d+)\s*(#.*)?$/m.exec(runtimeYaml ?? "");
  return m?.[1];
}

/** A limit as typed: a whole number of tokens, at least 1,000 (commas and spaces allowed). */
export function limitOf(typed: string): string | undefined {
  const n = typed.replace(/[,_\s]/g, "");
  return /^\d+$/.test(n) && Number(n) >= 1000 ? String(Number(n)) : undefined;
}

export const JOBS: readonly Job[] = [
  {
    command: "atticus.mapEstate",
    title: "Map the estate, one part at a time (map --all)",
    needs: "limit",
    argv: (a) => ["map", "--all", "--max-tokens", req(a.maxTokens, "model limit")],
    how: "terminal",
  },
  {
    command: "atticus.estateFresh",
    title: "Which repos are stale (estate fresh)",
    argv: () => ["estate", "fresh"],
    how: "report",
    app: () => "#/trust",
  },
  {
    command: "atticus.nextQueue",
    title: "The onboarding queue, with each read's cost (next --queue)",
    argv: () => ["next", "--queue"],
    how: "report",
  },
  {
    command: "atticus.mapGaps",
    title: "Plan a second pass on a repo's gaps (map --gaps)",
    needs: "repo",
    argv: (a) => ["map", req(a.repo, "repo"), "--gaps"],
    how: "run",
    chat: (a) => ({ step: "map", target: `${req(a.repo, "repo")} --gaps` }),
  },
  {
    command: "atticus.joinMeasure",
    title: "Measure the links against your reference (join measure)",
    needs: "reference",
    argv: (a) => ["join", "measure", req(a.file, "reference file")],
    how: "report",
  },
  {
    command: "atticus.auditReport",
    title: "The sample audit's precision (verify audit --report)",
    needs: "repo-or-estate",
    argv: (a) => ["verify", "audit", ...(a.repo ? [a.repo] : []), "--report"],
    how: "report",
    app: () => "#/trust",
  },
  {
    command: "atticus.changeImpact",
    title: "What a change breaks, up the chain (change impact)",
    needs: "change",
    argv: (a) => ["change", "impact", req(a.change, "change")],
    how: "report",
    app: (a) => `#/architecture?change=${encodeURIComponent(a.change ?? "")}`,
  },
  {
    command: "atticus.specSeed",
    title: "Seed a repo's starting spec from its verified flows (spec seed)",
    needs: "repo",
    argv: (a) => ["spec", "seed", req(a.repo, "repo")],
    how: "run",
  },
  {
    command: "atticus.specAccept",
    title: "Accept a repo's seeded spec (spec accept)",
    needs: "repo",
    argv: (a) => ["spec", "accept", req(a.repo, "repo")],
    how: "confirm",
  },
  {
    command: "atticus.questionsSheet",
    title: "Write every open question to one answer sheet (questions sheet)",
    argv: () => ["questions", "sheet"],
    how: "run",
  },
  {
    command: "atticus.questionsApply",
    title: "Answer from a filled answer sheet (questions sheet --apply)",
    needs: "sheet",
    argv: (a) => ["questions", "sheet", "--apply", req(a.file, "sheet")],
    how: "report",
  },
  {
    command: "atticus.questionsProposed",
    title: "Check the proposed answers' citations (questions proposed)",
    argv: () => ["questions", "proposed"],
    how: "report",
  },
  {
    command: "atticus.propose",
    title: "Propose answers from the code with Copilot (/atticus-propose)",
    argv: () => [],
    how: "chat",
    chat: () => ({ step: "propose" }),
  },
  {
    command: "atticus.intakeTraffic",
    title: "Keep a gateway's traffic export as evidence (intake traffic)",
    needs: "traffic",
    argv: (a) => [
      "intake",
      "traffic",
      req(a.file, "traffic export"),
      "--source",
      req(a.source, "source"),
    ],
    how: "report",
  },
  {
    command: "atticus.repoRename",
    title: "Rename a repo's id with its facts (repo rename)",
    needs: "rename",
    argv: (a) => ["repo", "rename", req(a.old, "repo"), req(a.new, "new id")],
    how: "confirm",
  },
];

export const jobByCommand = (command: string): Job | undefined =>
  JOBS.find((j) => j.command === command);

export const jobArgv = (j: Job, a: JobArgs): string[] => j.argv(a);

/** The sources `atticus intake traffic` reads (ADR 0151). */
export const TRAFFIC_SOURCES = ["apigee", "catalog"] as const;

/**
 * F5: a step for a repo with no facts names a near id that has some, and the rename that keeps
 * one id. Read off the step's why, as `atticus next` writes it.
 */
export function renameHint(s: Pick<NextStep, "why">): { from: string; to: string } | undefined {
  const m = /atticus repo rename (\S+) (\S+?)[\s.,)]/.exec(`${s.why} `);
  return m ? { from: m[1]!, to: m[2]! } : undefined;
}

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}K`
      : String(n);

/** A repo of the onboarding queue as a row: its place, why it sits there, its cost; click reads. */
export function queueRow(q: QueueEntry): NextRow {
  const e = q.cost?.estimated;
  const cost = e
    ? `about ${tokens(e.tokens)} tokens in ${e.sessions} session${e.sessions === 1 ? "" : "s"}${e.reread ? " (a re-read)" : ""}`
    : WORDS.notEstimated;
  const step: NextStep = { step: "map", command: q.command, why: q.why, repo: q.repo };
  return {
    id: `next:queue:${q.repo}`,
    label: `${q.order}. ${q.repo}`,
    description: `${WORDS.queueReason(q.reason)} · ${cost}`,
    tooltip: `${q.why}\n\nCost: ${e ? `estimated ${cost}` : `${cost} (atticus map ${q.repo} --estimate)`}. Estimates are counted from the source; Atticus meters nothing.\n\n\`${q.command}\`\n\nClick to read it.`,
    icon: "repo",
    command: { command: "atticus.runStep", title: "Read it", args: [step] },
  };
}

/** What @atticus does with a plain request about one of the new jobs. */
export interface Route {
  /** The extension's command that does it. */
  command: string;
  /** What the request named: a repo or a change of the metarepo's. */
  args?: JobArgs;
  /** What to say, in a sentence, beside the command line's words. */
  says: string;
}

const RULES: { test: RegExp; command: string; says: string }[] = [
  {
    test: /\bwhy\b.*\blink|\blink(ed)?\b.*\bwrong\b/,
    command: "atticus.diagram",
    says: "On the Map's canvas, a link's details open Why is this linked?: every call on it, how it was joined and its cited lines at both ends; This link is wrong writes a person's correction.",
  },
  {
    test: /\b(break|breaks|impact|blast)\b/,
    command: "atticus.changeImpact",
    says: "atticus change impact walks up from each caller a change breaks, each hop with its owner; a guessed link only may break. The change's Architecture tab shows the same.",
  },
  {
    test: /\b(stale|fresh|freshness|out of date)\b/,
    command: "atticus.estateFresh",
    says: "atticus estate fresh lists every repo whose clone moved past its facts, most stale first, with the facts to read again; Map › Trust shows it under Freshness.",
  },
  {
    test: /\bpropos/,
    command: "atticus.propose",
    says: "/atticus-propose has your assistant propose an answer to each open question from the code, citing its lines; atticus questions proposed checks them, and you accept one with Accept as my answer.",
  },
  {
    test: /\b(gap|gaps|second pass)\b/,
    command: "atticus.mapGaps",
    says: "atticus map <repo> --gaps plans a second pass on what the last verify left and writes its prompt; /atticus-map <repo> --gaps in a new chat reads it.",
  },
  {
    test: /\b(queue|order)\b|read next/,
    command: "atticus.nextQueue",
    says: "atticus next --queue lists the repos to read in the order that lands links early, each with its estimated cost.",
  },
  {
    test: /\b(audit|precision|precise)\b/,
    command: "atticus.auditReport",
    says: "atticus verify audit <repo> --report gives a sample audit's precision per kind of fact and for links, with a 95% interval; Map › Trust shows it.",
  },
  {
    test: /\b(measure|recall|reference)\b/,
    command: "atticus.joinMeasure",
    says: "atticus join measure <reference> scores your map against the entries and calls you list by hand for a few repos you know (docs/guide/measure.md).",
  },
  {
    test: /\baccept\b.*\bseed|\bseed\b.*\baccept/,
    command: "atticus.specAccept",
    says: "atticus spec accept <repo> validates the seeded spec and archives it into openspec/specs; read the seed first.",
  },
  {
    test: /\bseed/,
    command: "atticus.specSeed",
    says: "atticus spec seed <repo> proposes a repo's starting spec from its verified flows, as the change openspec/changes/seed-<repo>/; nothing is written into openspec/specs until you accept it.",
  },
  {
    test: /\bsheet\b|one sitting/,
    command: "atticus.questionsSheet",
    says: "atticus questions sheet writes every open question to one YAML answer sheet; fill it in, then atticus questions sheet --apply <file> answers the filled ones as you.",
  },
  {
    test: /\btraffic\b/,
    command: "atticus.intakeTraffic",
    says: "atticus intake traffic <file> --source apigee|catalog keeps a gateway or API catalogue export only as counts, with client ids, keys, IPs and tokens dropped, for review in a pull request.",
  },
  {
    test: /\brename\b|near id|same repo/,
    command: "atticus.repoRename",
    says: "atticus repo rename <old> <new> moves a repo's id with its facts, questions and catalog records, in one change you review.",
  },
  {
    test: /\b(mine|my team|my teams|my questions)\b/,
    command: "atticus.questionsMine",
    says: "atticus questions list --mine lists only the questions for your teams (roles.yaml) and the changes that name you under owners; the Questions view's My teams' button does the same.",
  },
];

/**
 * A plain request to `@atticus` about one of beta.10's jobs, routed to the command that does it,
 * with the repo or change it names when it names one of the metarepo's. Undefined: not one of
 * them, and the participant says what is next as before.
 */
export function routeAsk(
  prompt: string,
  known: { repos?: readonly string[]; changes?: readonly string[] } = {},
): Route | undefined {
  const p = prompt.toLowerCase();
  const rule = RULES.find((r) => r.test.test(p));
  if (!rule) return undefined;
  const words = prompt.split(/[\s,;:?!"'`()]+/).map((w) => w.replace(/[.]+$/, ""));
  const repo = known.repos?.find((r) => words.includes(r));
  const change = known.changes?.find((c) => words.includes(c));
  const args: JobArgs = {
    ...(repo ? { repo } : {}),
    ...(change ? { change } : {}),
  };
  return {
    command: rule.command,
    ...(Object.keys(args).length ? { args } : {}),
    says: rule.says,
  };
}
