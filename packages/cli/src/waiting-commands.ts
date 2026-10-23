import type { Output } from "./commands.js";

/**
 * `atticus waiting [--by change|kind] [--filter words] [--json]` (ADR 0105): what waits on a person
 * across every change, read from the commands that already list each part (questions, needs,
 * manual steps, findings, knowledge no one has verified). By change, each change lists its open
 * needs, open findings and manual steps, changes with a blocking finding first; what belongs to no
 * change follows. The filter keeps a change whose title or id matches with all it has, and
 * otherwise each item whose words match, case-insensitively.
 */

export type WaitingRun = (argv: string[]) => Promise<{ code: number; out: string; err: string }>;

interface Need {
  item: string;
  title: string;
  kind?: string;
  status?: string;
  for?: string;
  change?: string;
  handledBy?: string;
}
interface Finding {
  id: string;
  summary: string;
  severity: string;
  state?: string;
}
interface Step {
  id: string;
  title: string;
  change?: string;
  state?: string;
  where?: string;
}
interface Question {
  id: string;
  repo: string;
  question: string;
}

export interface WaitingChange {
  change: string;
  title: string;
  state: string;
  needs: Need[];
  findings: Finding[];
  manualSteps: Step[];
}

export interface WaitingView {
  changes: WaitingChange[];
  other: { questions: Question[]; manualSteps: Step[]; knowledgeToVerify: number };
  counts: {
    questions: number;
    needs: number;
    manualSteps: number;
    findings: number;
    knowledgeToVerify: number;
  };
  /** Parts that couldn't be read, with why. */
  problems: string[];
}

const CLOSED = new Set(["released", "archived", "closed"]);

export async function readWaiting(run: WaitingRun, o: { filter?: string }): Promise<WaitingView> {
  const problems: string[] = [];
  const json = async <T>(argv: string[], fallback: T): Promise<T> => {
    const r = await run(argv);
    try {
      return JSON.parse(r.out) as T;
    } catch {
      problems.push(`atticus ${argv.join(" ")}: ${r.err.trim().split("\n")[0] || "no answer"}`);
      return fallback;
    }
  };
  const questions =
    (await json<{ questions?: Question[] }>(["questions", "list", "--state", "open", "--json"], {}))
      .questions ?? [];
  const needs = (await json<Need[]>(["needs", "--all", "--json"], [])).filter(
    (n) => (n.status ?? "open") === "open",
  );
  const steps = (await json<Step[]>(["todo", "--json"], [])).filter(
    (s) => (s.state ?? "open") === "open",
  );
  const changes = (
    await json<{ id: string; title: string; state: string }[]>(["change", "list", "--json"], [])
  ).filter((c) => !CLOSED.has(c.state));
  const findings = new Map<string, Finding[]>();
  for (const c of changes)
    findings.set(
      c.id,
      (await json<Finding[]>(["findings", c.id, "--json"], [])).filter(
        (f) => (f.state ?? "open") === "open",
      ),
    );
  const unverified = await json<unknown[]>(["knowledge", "list", "--unverified", "--json"], []);

  const words = o.filter?.trim().toLowerCase();
  const hit = (...fields: (string | undefined)[]) =>
    !words || fields.some((f) => f !== undefined && f.toLowerCase().includes(words));

  const byChange: WaitingChange[] = [];
  for (const c of changes) {
    const whole = hit(c.id, c.title);
    const w: WaitingChange = {
      change: c.id,
      title: c.title,
      state: c.state,
      needs: needs.filter(
        (n) => n.change === c.id && (whole || hit(n.item, n.title, n.kind, n.handledBy)),
      ),
      findings: (findings.get(c.id) ?? []).filter((f) => whole || hit(f.id, f.summary, f.severity)),
      manualSteps: steps.filter((s) => s.change === c.id && (whole || hit(s.id, s.title, s.where))),
    };
    if (w.needs.length + w.findings.length + w.manualSteps.length) byChange.push(w);
  }
  const blocking = (w: WaitingChange) => w.findings.some((f) => f.severity === "blocking");
  byChange.sort(
    (a, b) => Number(blocking(b)) - Number(blocking(a)) || a.title.localeCompare(b.title),
  );
  const known = new Set(changes.map((c) => c.id));
  const other = {
    questions: questions.filter((q) => hit(q.id, q.repo, q.question)),
    manualSteps: steps.filter(
      (s) => (!s.change || !known.has(s.change)) && hit(s.id, s.title, s.where, s.change),
    ),
    knowledgeToVerify: words ? 0 : unverified.length,
  };
  const sum = (f: (w: WaitingChange) => number) => byChange.reduce((n, w) => n + f(w), 0);
  return {
    changes: byChange,
    other,
    counts: {
      questions: other.questions.length,
      needs: sum((w) => w.needs.length),
      manualSteps: sum((w) => w.manualSteps.length) + other.manualSteps.length,
      findings: sum((w) => w.findings.length),
      knowledgeToVerify: other.knowledgeToVerify,
    },
    problems,
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const stepId = (s: Step) => (s.change ? `${s.change}/${s.id}` : s.id);

function byChangeLines(w: WaitingView): string[] {
  const out: string[] = [];
  for (const c of w.changes) {
    const parts = [
      c.needs.length && plural(c.needs.length, "need"),
      c.findings.length && plural(c.findings.length, "finding"),
      c.manualSteps.length && plural(c.manualSteps.length, "manual step"),
    ].filter(Boolean);
    out.push(`${c.title} (${c.change}): ${parts.join(", ")}`);
    for (const n of c.needs) out.push(`  need     ${n.item}: ${n.title}`);
    for (const f of c.findings) out.push(`  finding  ${f.id} (${f.severity}): ${f.summary}`);
    for (const s of c.manualSteps) out.push(`  step     ${stepId(s)}: ${s.title}`);
  }
  const o = w.other;
  if (o.questions.length || o.manualSteps.length || o.knowledgeToVerify) {
    out.push("Not tied to a change:");
    for (const q of o.questions) out.push(`  question ${q.id} (${q.repo}): ${q.question}`);
    for (const s of o.manualSteps) out.push(`  step     ${stepId(s)}: ${s.title}`);
    if (o.knowledgeToVerify)
      out.push(
        `  ${plural(o.knowledgeToVerify, "knowledge item")} no one has verified: atticus knowledge list --unverified`,
      );
  }
  return out;
}

function byKindLines(w: WaitingView): string[] {
  const out: string[] = [];
  const group = (title: string, lines: string[]) => {
    if (lines.length) out.push(`${title} (${lines.length})`, ...lines.map((l) => `  ${l}`));
  };
  group(
    "Questions",
    w.other.questions.map((q) => `${q.id} (${q.repo}): ${q.question}`),
  );
  group(
    "Needs",
    w.changes.flatMap((c) => c.needs.map((n) => `${n.item} (${c.change}): ${n.title}`)),
  );
  group(
    "Manual steps",
    [...w.changes.flatMap((c) => c.manualSteps), ...w.other.manualSteps].map(
      (s) => `${stepId(s)}: ${s.title}`,
    ),
  );
  group(
    "Findings",
    w.changes.flatMap((c) =>
      c.findings.map((f) => `${f.id} (${c.change}, ${f.severity}): ${f.summary}`),
    ),
  );
  if (w.other.knowledgeToVerify)
    out.push(
      `Knowledge to verify (${w.other.knowledgeToVerify}): atticus knowledge list --unverified`,
    );
  return out;
}

export async function waitingCli(
  o: { by?: "change" | "kind"; filter?: string; json?: boolean },
  io: Output,
  run: WaitingRun,
): Promise<number> {
  const by = o.by ?? "change";
  const w = await readWaiting(run, o.filter ? { filter: o.filter } : {});
  if (o.json) {
    io.out(JSON.stringify({ by, ...w }, null, 2));
    return 0;
  }
  const lines = by === "kind" ? byKindLines(w) : byChangeLines(w);
  if (!lines.length)
    io.out(o.filter ? `Nothing waits on you that matches "${o.filter}".` : "Nothing waits on you.");
  else for (const l of lines) io.out(l);
  for (const p of w.problems) io.err(`Couldn't read ${p}`);
  return 0;
}
