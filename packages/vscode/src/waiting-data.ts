import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type * as Api from "./api-types";
import { parseJson } from "./cli";
import { needDescription, needItems, type KnowledgeEntry, type NeedEntry } from "./knowledge-data";
import { readKnowledgeList } from "./knowledge-read";
import { questionGroups, SEVERITY_ICON, type Item } from "./sidebar-data";
import type { Cli, OpenQuestion } from "./types";
import { questionLabel } from "./words";

/**
 * The Waiting on you section (ADR 0105): what waits on a person across every change, in one
 * place. The open questions (read with the Next section), the open needs (`atticus needs --all
 * --json`), the manual steps to do (`atticus todo --json`), the open findings of each open change
 * (`atticus findings <change> --json`) and the knowledge no one has verified (`atticus knowledge
 * list --json`). Files and the command line only, read-only. No `vscode` here.
 */

/** One manual step of `atticus todo --json`. */
export interface TodoEntry {
  id: string;
  change?: string;
  system?: string;
  action?: string;
  state: string;
  title: string;
  where?: string;
  waitsFor?: string[];
  procedure?: string;
}

/** What was read; a part that couldn't be read is the reason, in the command line's words. */
export interface WaitingRead {
  needs: NeedEntry[] | string;
  /** Each change's needs.md, for opening a need at its line. */
  needsMd: Record<string, { path: string; text: string }>;
  todo: TodoEntry[] | string;
  findings: Api.Finding[] | string;
  /** Each change's title, by id. */
  titles: Record<string, string>;
  unverified: number | string;
}

/** A row of the section; a group's rows are under it. */
export interface WaitingRow extends Item {
  rows?: WaitingRow[];
  /** A repo's questions, for Answer this repo's questions. */
  questions?: OpenQuestion[];
}

/** The files a read looks at, so the tests give their own. */
export interface WaitingFiles {
  exists: (path: string) => boolean;
  read: (path: string) => string | undefined;
}

const FS: WaitingFiles = {
  exists: existsSync,
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** No one has verified, corrected or rejected it. */
export const isUnverified = (k: Pick<KnowledgeEntry, "review">) => {
  const st = k.review?.state;
  return st !== "verified" && st !== "corrected" && st !== "rejected";
};

/** A change that is over: nothing on it waits on anyone. */
const OVER = new Set(["released", "archived"]);

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const why = (r: { stdout: string; stderr: string; code: number }, what: string) =>
  firstLine(r.stderr) || firstLine(r.stdout) || `atticus ${what} exited ${r.code}`;

/** Run a command and read its JSON list; the reason when it can't be. */
async function list<T>(cli: Cli, root: string, args: string[]): Promise<T[] | string> {
  try {
    const r = await cli([...args, "--root", root]);
    const j = parseJson<T[]>(r.stdout);
    return r.code === 0 && Array.isArray(j) ? j : why(r, args.slice(0, 2).join(" "));
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

export async function readWaiting(
  cli: Cli,
  root: string,
  files: WaitingFiles = FS,
): Promise<WaitingRead> {
  const [needs, todo, changes, knowledge] = await Promise.all([
    list<NeedEntry>(cli, root, ["needs", "--all", "--json"]),
    list<TodoEntry>(cli, root, ["todo", "--json"]),
    list<{ id: string; title?: string; state?: string }>(cli, root, ["change", "list", "--json"]),
    readKnowledgeList(cli, root).catch((e: unknown) => ({
      items: [] as KnowledgeEntry[],
      problem: (e as Error)?.message ?? String(e),
      failed: true,
    })),
  ]);
  const titles: Record<string, string> = {};
  if (Array.isArray(changes)) for (const c of changes) if (c.title) titles[c.id] = c.title;

  // Each open change's findings; the first reason one can't be read stands for them all.
  let findings: Api.Finding[] | string;
  if (typeof changes === "string") findings = changes;
  else {
    const each = await Promise.all(
      changes
        .filter((c) => !OVER.has(c.state ?? ""))
        .map((c) =>
          list<{ findings?: Api.Finding[] }>(cli, root, ["findings", c.id, "--json"]).then((g) =>
            typeof g === "string"
              ? g
              : g.flatMap((s) =>
                  (s.findings ?? []).map((f) => ({ ...f, change: f.change ?? c.id })),
                ),
          ),
        ),
    );
    const bad = each.find((x): x is string => typeof x === "string");
    findings =
      bad ?? (each as Api.Finding[][]).flat().filter((f) => (f.state ?? "open") === "open");
  }

  const open = Array.isArray(needs)
    ? needs
        .filter((n) => n.status === "open")
        .map((n) => ({ ...n, inputs: n.inputs ?? [], steps: n.steps ?? [], rules: n.rules ?? [] }))
    : needs;
  // Each change's needs.md, where its needs.yaml is: openspec/, or .atticus/openspec/ when adopted.
  const needsMd: WaitingRead["needsMd"] = {};
  if (Array.isArray(open))
    for (const c of new Set(open.map((n) => n.change))) {
      const dirs = ["openspec", join(".atticus", "openspec")].map((d) =>
        join(root, d, "changes", c),
      );
      const dir = dirs.find((d) => files.exists(join(d, "needs.yaml"))) ?? dirs[0]!;
      const path = join(dir, "needs.md");
      needsMd[c] = { path, text: files.read(path) ?? "" };
    }

  // No knowledge items yet is nothing to verify, not a failure.
  const unverified =
    "failed" in knowledge
      ? knowledge.problem
      : knowledge.items.filter((k) => isUnverified(k)).length;

  return { needs: open, needsMd, todo, findings, titles, unverified };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const errorRow = (id: string, message: string): WaitingRow => ({
  id: `waiting:${id}:error`,
  label: message,
  tooltip: `${message}\n\nClick to see the commands run, in the Atticus output. Refresh to read it again.`,
  icon: "warning",
  command: { command: "atticus.showLog" },
});

function questionRows(qs: OpenQuestion[]): WaitingRow[] {
  return questionGroups(qs).map((g) => ({
    id: `questions:${g.repo}`,
    label: g.repo,
    description: `${g.questions.length} open`,
    icon: "repo",
    context: "atticus.questionRepo",
    questions: g.questions,
    rows: g.questions.map((q) => {
      const l = questionLabel(q.question);
      return {
        id: `question:${q.id}`,
        label: l.label,
        description: [l.description, q.options.length ? `${q.options.length} options` : ""]
          .filter(Boolean)
          .join(" · "),
        tooltip: `${q.question}\n\n${q.options.map((o, i) => `${i + 1}. **${o.label}**${o.means ? `: ${o.means}` : ""}`).join("\n")}\n\nClick to answer.`,
        markdown: true,
        icon: "question",
        command: { command: "atticus.answerQuestion", args: [q.id] },
      };
    }),
  }));
}

const SEVERITY_ORDER: Record<string, number> = { blocking: 0, gap: 1, risk: 2, idea: 3 };

/**
 * The section's rows: a group for each kind with its count, an empty group left out, a part that
 * couldn't be read said in its place, and one row when nothing waits.
 */
export function waitingRows(questions: OpenQuestion[] | string, w: WaitingRead): WaitingRow[] {
  const rows: WaitingRow[] = [];
  const titleOf = (c: string) => w.titles[c] ?? c;

  if (typeof questions === "string") rows.push(errorRow("questions", questions));
  else if (questions.length)
    rows.push({
      id: "waiting:questions",
      label: "Questions",
      description: `${questions.length} to answer`,
      tooltip: "Questions only a person can answer. Click one to answer it.",
      icon: "question",
      rows: questionRows(questions),
    });

  if (typeof w.needs === "string")
    rows.push(errorRow("needs", `Couldn't read the needs: ${w.needs}`));
  else if (w.needs.length) {
    const by = new Map<string, NeedEntry[]>();
    for (const n of w.needs) by.set(n.change, [...(by.get(n.change) ?? []), n]);
    const needRows = [...by].flatMap(([c, ns]) => {
      const md = w.needsMd[c];
      return needItems(ns, md?.path ?? "", md?.text ?? "").map((r) => ({
        ...r,
        description: `${titleOf(c)} · ${needDescription(r.need!)}`,
      }));
    });
    rows.push({
      id: "waiting:needs",
      label: "Needs",
      description: `${w.needs.length} open`,
      tooltip:
        "What your changes need from the organisation and is still open. Raise each, then mark it Done or Not needed.",
      icon: "inbox",
      rows: needRows,
    });
  }

  if (typeof w.todo === "string")
    rows.push(errorRow("todo", `Couldn't read the manual steps: ${w.todo}`));
  else if (w.todo.length)
    rows.push({
      id: "waiting:todo",
      label: "Manual steps",
      description: `${w.todo.length} to do`,
      tooltip: "Steps a person does in systems Atticus can't reach. Click one to see it.",
      icon: "checklist",
      rows: w.todo.map((t) => {
        const ref = t.change ? `${t.change}/${t.id}` : t.id;
        const waits = t.waitsFor ?? [];
        return {
          id: `todo:${ref}`,
          label: t.title,
          description: [
            t.change ? titleOf(t.change) : "",
            t.system ?? "",
            waits.length ? `after ${waits.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          tooltip: [
            t.title,
            t.where ? `Where: ${t.where}` : "",
            waits.length ? `It waits for ${waits.join(", ")}.` : "",
            `${ref}. Click to see the step (atticus todo show ${ref}).`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          icon: waits.length ? "lock" : "circle-large-outline",
          command: { command: "atticus.showManualStep", args: [ref] },
        };
      }),
    });

  if (typeof w.findings === "string")
    rows.push(errorRow("findings", `Couldn't read the findings: ${w.findings}`));
  else if (w.findings.length)
    rows.push({
      id: "waiting:findings",
      label: "Findings",
      description: `${w.findings.length} open`,
      tooltip: "The critic's open findings on your changes. Click one to open its change.",
      icon: "warning",
      rows: [...w.findings]
        .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
        .map((f) => ({
          id: `finding:${f.change}:${f.id}`,
          label: f.summary,
          description: `${titleOf(f.change)} · ${f.severity}`,
          tooltip: `${f.summary}\n\nWhy: ${f.why}\n\nFix: ${f.fix?.text ?? ""}\n\n${f.change}, ${f.artifact}. Click to open the change.`,
          icon: SEVERITY_ICON[f.severity] ?? "circle-small",
          context: "atticus.finding",
          finding: f,
          open: { kind: "app" as const, hash: `#/changes/${encodeURIComponent(f.change)}` },
        })),
    });

  if (typeof w.unverified === "string")
    rows.push(errorRow("knowledge", `Couldn't read the knowledge items: ${w.unverified}`));
  else if (w.unverified)
    rows.push({
      id: "waiting:knowledge",
      label: "Knowledge to verify",
      description: plural(w.unverified, "item"),
      tooltip: `${plural(w.unverified, "knowledge item")} no person has verified. Click to check them against their pages, one after another.`,
      icon: "pass",
      command: { command: "atticus.reviewUnverified" },
    });

  if (!rows.length)
    rows.push({
      id: "waiting:none",
      label: "Nothing waits on you.",
      tooltip:
        "No question to answer, no open need, no manual step, no open finding and no knowledge to verify.",
      icon: "check",
    });
  return rows;
}
