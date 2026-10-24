import { join } from "node:path";
import { diagramHash } from "./app-panel";
import type * as Api from "./api-types";
import type { KnowledgeEntry, NeedEntry } from "./knowledge-data";
import type { RunEntry } from "./runs-data";

/**
 * What the Atticus sidebar shows (ADR 0093), as plain data: each section's items, what a click
 * opens and what expands underneath. No `vscode` here, so it is tested outside the editor;
 * sidebar.ts turns these into tree items.
 */

/** What clicking an item does. */
export type Open =
  | { kind: "file"; path: string; line?: number }
  | { kind: "app"; hash: string }
  | { kind: "missing"; message: string }
  /** More than one thing to open: the person picks. */
  | { kind: "pick"; title: string; choices: { label: string; detail?: string; open: Open }[] };

/** What an item holds underneath, loaded when it is opened. */
export type Expand =
  | { kind: "repo"; repo: string }
  | { kind: "flows"; repo: string }
  | { kind: "flow"; repo: string; flow: string }
  | { kind: "change"; change: string }
  | { kind: "findings"; change: string }
  | { kind: "targets"; change: string }
  | { kind: "tasks"; change: string }
  | { kind: "sources" }
  | { kind: "knowledge-items" }
  /** ADR 0101: the items of one group of knowledge kinds, what the last scan changed, searches. */
  | { kind: "knowledge-group"; group: string }
  | { kind: "last-scan" }
  | { kind: "finds" }
  /** What one saved search found (0.3.1). */
  | { kind: "find"; slug: string }
  /** A change's needs from the organisation (ADR 0101). */
  | { kind: "needs"; change: string }
  | { kind: "kind"; recordKind: string }
  /** One model run, opening to its prompt, its answer and the app's screen (ADR 0106). */
  | { kind: "run"; run: RunEntry }
  | { kind: "evidence"; repo?: string; evidence: Api.Evidence[] };

export interface Item {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id. */
  icon?: string;
  /** A theme colour for the icon (e.g. testing.iconPassed for a green tick). */
  color?: string;
  /** The tooltip is Markdown. */
  markdown?: boolean;
  /** What clicking runs, in place of opening something: an editor command and its arguments. */
  command?: { command: string; args?: unknown[] };
  expand?: Expand;
  open?: Open;
  /** For the view's inline actions (package.json menus). */
  context?: string;
  /** More words a filter matches (ADR 0105): a change's repos, a question's repo. */
  words?: string[];
  /** A finding's item carries it, for Act on the finding. */
  finding?: Api.Finding;
  /** A task's item carries its change and id, for Run the task. */
  task?: { change: string; id: string };
  /** A knowledge item's row carries it, for Verify, Correct, Reject and its links (ADR 0101). */
  knowledge?: KnowledgeEntry;
  /** A need's row carries it, for Done, Not needed and Reopen (ADR 0101). */
  need?: NeedEntry;
  /** A wiki source's row carries its id, for Sync, Read and Tag. */
  source?: string;
}

export interface Paths {
  root: string;
  /** Where a repo's code is on this machine, if it is. */
  codeRoot: (repo: string) => string | undefined;
  /** The catalog folder relative to the root: catalog, or .atticus/catalog when adopted. */
  catalogRel: string;
  /** Whether a file is there; a change's files that aren't written yet say so. Default: yes. */
  exists?: (path: string) => boolean;
  /** The knowledge folder relative to the root: knowledge, or .atticus/knowledge. */
  knowledgeRel?: string;
}

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
const base = (p: string) => p.split("/").pop() ?? p;
const at = (e: Api.Evidence | undefined) =>
  e?.path ? `${base(e.path)}${e.line !== undefined ? `:${e.line}` : ""}` : undefined;

const CONFIRMED: Record<string, string> = {
  check: "Confirmed by the check",
  ai: "Confirmed by the AI",
  person: "Confirmed by a person",
};

/** An open folder named for the repo, else the base clone at workspace/<repo>. */
export function codeRootFor(
  repo: string,
  root: string,
  folders: { name: string; path: string }[],
  exists: (p: string) => boolean,
): string | undefined {
  const open = folders.find((f) => f.name === repo);
  if (open) return open.path;
  const clone = join(root, "workspace", repo);
  return exists(clone) ? clone : undefined;
}

/** Where a citation is: the file in the repo's code at its line, or why it can't be opened. */
export function codeOpen(e: Api.Evidence, fallbackRepo: string | undefined, p: Paths): Open {
  const repo = e.repo ?? fallbackRepo;
  if (!e.path || !repo) return { kind: "missing", message: "This citation names no file." };
  const dir = p.codeRoot(repo);
  if (!dir)
    return {
      kind: "missing",
      message: `${repo} isn't cloned here. Run atticus workspace sync, or open the repo's folder in this window.`,
    };
  return {
    kind: "file",
    path: join(dir, e.path),
    ...(e.line !== undefined ? { line: e.line } : {}),
  };
}

const file = (p: Paths, rel: string): Open => ({ kind: "file", path: join(p.root, rel) });

// ------------------------------------------------------------------ repos and flows

export function repoItems(v: Api.OnboardingView): Item[] {
  return v.repos.map((r) => ({
    id: `repo:${r.id}`,
    label: r.id,
    // ADR 0123: the branch the catalog is read from, and the commit the last scan read.
    description: [
      r.defaultBranch,
      r.lastScan
        ? `scanned${r.lastScan.commit ? ` at ${r.lastScan.commit.slice(0, 7)}` : ""} · ${plural(r.lastScan.records, "record")}`
        : r.cloned
          ? "not scanned"
          : "not cloned",
    ]
      .filter(Boolean)
      .join(" · "),
    tooltip: `${r.id}: ${r.type}, owned by ${r.owner}. Listed in ${r.manifest}.${r.defaultBranch ? ` Read from ${r.defaultBranch}.` : ""}${r.branches?.length ? ` Other branches: ${r.branches.join(", ")} (Set up › Repos scans them beside it).` : ""}${r.lastScan?.commit ? ` Last scan at ${r.lastScan.commit.slice(0, 7)}.` : ""}`,
    icon: "repo",
    expand: { kind: "repo", repo: r.id },
    context: "atticus.repo",
  }));
}

export function repoChildren(r: Api.OnboardingRepo, flows: number, p: Paths): Item[] {
  return [
    flows > 0
      ? {
          id: `flows:${r.id}`,
          label: `Flows (${num(flows)})`,
          icon: "list-ordered",
          expand: { kind: "flows", repo: r.id },
        }
      : {
          id: `flows:${r.id}`,
          label: "No flows yet: draft its spec",
          description: "with Copilot",
          tooltip: `Click to draft the repo's spec with Copilot (atticus spec draft ${r.id}): a flow per trigger, each step citing its code.`,
          icon: "sparkle",
          command: { command: "atticus.spec", args: [r.id] },
        },
    {
      id: `settings:${r.id}`,
      label: "Scan settings",
      description: r.scanSettings.present ? r.scanSettings.path : "none yet: draft them",
      icon: "settings-gear",
      ...(r.scanSettings.present
        ? { open: file(p, r.scanSettings.path) }
        : {
            tooltip: `Click to draft them with Copilot (atticus scan survey ${r.id}): folders to leave out, path prefixes, client base URLs.`,
            command: { command: "atticus.survey", args: [r.id] },
          }),
    },
    {
      id: `canvas:${r.id}`,
      label: "On the canvas",
      icon: "type-hierarchy",
      open: { kind: "app", hash: diagramHash(r.id) },
    },
  ];
}

const flowHash = (repo: string, flow: string, step?: number) =>
  `#/flows?repo=${encodeURIComponent(repo)}&flow=${encodeURIComponent(flow)}${step !== undefined ? `&step=${step}` : ""}`;

export function flowItems(v: Api.SpecView): Item[] {
  return v.flows.map((f) => ({
    id: `flow:${v.repo}:${f.id}`,
    label: f.name,
    description: `${plural(f.steps, "step")} · ${num(f.confirmed)} confirmed`,
    tooltip: `${f.id}\n${f.trigger.kind}: ${f.trigger.what}${f.errors ? `\n${plural(f.errors, "error path")}` : ""}${f.calls ? `\nCalls ${plural(f.calls, "flow")} in other repos` : ""}`,
    icon: "git-commit",
    expand: { kind: "flow", repo: v.repo, flow: f.id },
    open: { kind: "app", hash: flowHash(v.repo, f.id) },
    context: "atticus.flow",
  }));
}

function fieldLines(s: Api.FlowStep): string[] {
  const d = s.data ?? {};
  const out: string[] = [];
  for (const k of ["sends", "returns", "reads", "checks"] as const)
    if (d[k]?.length) out.push(`${k}: ${d[k].join(", ")}`);
  if (d.from?.length || d.to?.length)
    out.push(`maps: ${(d.from ?? []).join(", ")} → ${(d.to ?? []).join(", ")}`);
  if (s.to) out.push(`to: ${s.to.component} ${s.to.entry}`);
  if (s.store) out.push(`table: ${s.store.table} (${s.store.columns.join(", ")})`);
  return out;
}

export function stepItems(v: Api.FlowView, p: Paths): Item[] {
  const t = v.flow.trigger;
  const start: Item = {
    id: `step:${v.repo}:${v.flow.id}:0`,
    label: `Start: ${t.what}`,
    ...(at(t.evidence[0]) ? { description: `${t.kind} · ${at(t.evidence[0])}` } : {}),
    icon: "debug-start",
    ...(t.evidence[0] ? { open: codeOpen(t.evidence[0], v.repo, p) } : {}),
    context: "atticus.step",
  };
  return [
    start,
    ...v.flow.steps.map((s, i) => {
      const n = i + 1;
      const where = at(s.evidence[0]);
      return {
        id: `step:${v.repo}:${v.flow.id}:${n}`,
        label: `${n}. ${s.what}`,
        description: `${s.kind}${where ? ` · ${where}` : ""}${s.confirmedBy ? " ✓" : ""}`,
        tooltip: [
          `${s.kind}: ${s.what}`,
          ...fieldLines(s),
          s.confirmedBy ? (CONFIRMED[s.confirmedBy] ?? s.confirmedBy) : "Not confirmed yet",
          ...s.evidence.map((e) => `${e.path ?? ""}${e.line !== undefined ? `:${e.line}` : ""}`),
        ].join("\n"),
        icon: s.confirmedBy ? "pass" : "circle-large-outline",
        ...(s.evidence[0] ? { open: codeOpen(s.evidence[0], v.repo, p) } : {}),
        context: "atticus.step",
      } satisfies Item;
    }),
  ];
}

/** The repo, flow and step number in an item id from stepItems (for Show in the diagram). */
export const stepOf = (id: string) => {
  const m = /^step:([^:]+):([^:]+):(\d+)$/.exec(id);
  return m ? { repo: m[1]!, flow: m[2]!, n: Number(m[3]) } : undefined;
};

export { flowHash };

// ------------------------------------------------------------------ changes

export function changeItems(cs: Api.ChangeSummary[]): Item[] {
  return cs.map((c) => ({
    id: `change:${c.id}`,
    label: c.title,
    description: `${c.state}${c.openFindings.blocking ? ` · ${num(c.openFindings.blocking)} blocking` : ""}`,
    tooltip: `${c.id} (${c.type}), updated ${c.updatedAt.slice(0, 10)}`,
    icon: "git-pull-request",
    expand: { kind: "change", change: c.id },
    context: "atticus.change",
    words: c.repos ?? [],
  }));
}

const STATUS_ICON: Record<string, string> = {
  done: "pass",
  ready: "circle-large-outline",
  blocked: "lock",
  "not-required": "dash",
};

export function artifactItems(c: Api.ChangeDetail, p: Paths): Item[] {
  const f = c.openFindings;
  const counts = [
    f.blocking ? `${num(f.blocking)} blocking` : "",
    f.gap ? plural(f.gap, "gap") : "",
    f.risk ? plural(f.risk, "risk") : "",
    f.idea ? plural(f.idea, "idea") : "",
  ].filter(Boolean);
  return [
    ...c.artifacts.map((a) => ({
      id: `artifact:${c.id}:${a.artifact}`,
      label: a.artifact,
      description: `${a.status}${a.openFindings ? ` · ${plural(a.openFindings, "finding")}` : ""}`,
      tooltip: a.path,
      icon: STATUS_ICON[a.status] ?? "file",
      open: (p.exists ?? (() => true))(join(p.root, a.path))
        ? file(p, a.path)
        : {
            kind: "missing" as const,
            message:
              a.status === "blocked"
                ? `${a.artifact} isn't written yet: it is blocked until the steps before it are done.`
                : `${a.artifact} isn't written yet.`,
          },
    })),
    {
      id: `tasks:${c.id}`,
      label: "Tasks",
      tooltip: "The change's tasks, by repo; each can run with AI (atticus task run).",
      icon: "tasklist",
      expand: { kind: "tasks" as const, change: c.id },
    },
    {
      id: `targets:${c.id}`,
      label: "Target flows",
      tooltip: "The flows this change adds, changes or removes, each beside today's (ADR 0095).",
      icon: "git-compare",
      expand: { kind: "targets" as const, change: c.id },
    },
    {
      id: `findings:${c.id}`,
      label: "Findings",
      description: counts.join(", ") || "none open",
      icon: f.blocking ? "warning" : "checklist",
      ...(counts.length ? { expand: { kind: "findings" as const, change: c.id } } : {}),
    },
    {
      id: `app:${c.id}`,
      label: "In the app",
      icon: "link-external",
      open: { kind: "app", hash: `#/changes/${encodeURIComponent(c.id)}` },
    },
  ];
}

/** The change's folder relative to the root, read from its artifacts' paths. */
export const changeDirOf = (c: Pick<Api.ChangeDetail, "id" | "artifacts">) => {
  const mark = `/changes/${c.id}/`;
  const a = c.artifacts.find((x) => x.path.includes(mark));
  return a ? a.path.slice(0, a.path.indexOf(mark) + mark.length - 1) : `openspec/changes/${c.id}`;
};

export const SEVERITY_ICON: Record<string, string> = {
  blocking: "error",
  gap: "question",
  risk: "warning",
  idea: "lightbulb",
};

export function findingItems(fs: Api.Finding[], c: Api.ChangeDetail, p: Paths): Item[] {
  const dir = changeDirOf(c);
  return fs
    .filter((f) => (f.state ?? "open") === "open")
    .map((f) => ({
      id: `finding:${f.change}:${f.id}`,
      label: f.summary,
      description: `${f.severity} · ${f.artifact}`,
      tooltip: `${f.summary}\n\nWhy: ${f.why}\n\nFix: ${f.fix.text}`,
      icon: SEVERITY_ICON[f.severity] ?? "circle-small",
      context: "atticus.finding",
      finding: f,
      ...(f.artifact !== "catalog" ? { open: file(p, `${dir}/${f.artifact}`) } : {}),
    }));
}

/** One thing a person can do with a finding (the API's actions, ADR 0094), and what it needs. */
export interface FindingChoice {
  action: "apply" | "edit-and-apply" | "not-relevant" | "waive" | "ask";
  label: string;
  /** What to ask the person for first. */
  needs?: "reason" | "askedOf";
  /** Who Ask goes to, when the finding names them. */
  askedOf?: string;
}

/** The actions a finding allows, by the same rules the critic applies (naysayer act.ts). */
export function findingActions(f: Api.Finding): FindingChoice[] {
  if (f.kind === "knowledge-gap") {
    const owner = f.question?.owner;
    return [
      owner
        ? { action: "ask", label: `Ask ${owner}`, needs: undefined, askedOf: owner }
        : { action: "ask", label: "Ask someone", needs: "askedOf" },
      { action: "edit-and-apply", label: "I wrote the fact in", needs: "reason" },
    ];
  }
  const out: FindingChoice[] = [];
  if (f.fix.patch) out.push({ action: "apply", label: "Apply the fix", needs: undefined });
  out.push({ action: "edit-and-apply", label: "I fixed it by hand", needs: "reason" });
  out.push({ action: "not-relevant", label: "Not relevant", needs: "reason" });
  if (f.severity === "blocking" && f.waivable && f.layer !== "constitution")
    out.push({ action: "waive", label: "Waive it", needs: "reason" });
  out.push({ action: "ask", label: "Ask someone", needs: "askedOf" });
  return out;
}

const DELTA_ICON: Record<string, string> = {
  new: "diff-added",
  modify: "diff-modified",
  remove: "diff-removed",
};
const DELTA_WORD: Record<string, string> = { new: "new", modify: "changed", remove: "removed" };

/** A change's target flows (ADR 0095): each opens beside today's flow in the Atticus tab. */
export function targetItems(v: Api.TargetFlowList): Item[] {
  return v.flows.map((f) => {
    const counts =
      f.change === "new"
        ? plural(f.added, "step")
        : f.change === "remove"
          ? plural(f.removed, "step")
          : [
              f.added ? `${num(f.added)} added` : "",
              f.changed ? `${num(f.changed)} changed` : "",
              f.removed ? `${num(f.removed)} removed` : "",
            ]
              .filter(Boolean)
              .join(", ") || "no step changes";
    return {
      id: `target:${v.change}:${f.flow}`,
      label: f.name,
      description: `${DELTA_WORD[f.change] ?? f.change} · ${counts}`,
      tooltip: `${f.flow} (${f.repo})\n${f.why}`,
      icon: DELTA_ICON[f.change] ?? "git-compare",
      open: {
        kind: "app",
        hash: `#/flows?change=${encodeURIComponent(v.change)}&flow=${encodeURIComponent(f.flow)}`,
      },
    };
  });
}

// ------------------------------------------------------------------ tasks, knowledge, health (ADR 0096)

export function taskItems(change: string, tasks: Api.Task[]): Item[] {
  return tasks.map((t) => ({
    id: `task:${change}:${t.id}`,
    label: t.description,
    description: `${t.repo}${t.done ? " · done" : t.story ? ` · story ${t.story}` : ""}`,
    tooltip: `${t.id}: ${t.description}${t.branch ? `\nBranch ${t.branch}` : ""}`,
    icon: t.done ? "pass" : "circle-large-outline",
    context: "atticus.task",
    task: { change, id: t.id },
  }));
}

export function knowledgeItems(items: Api.KnowledgeItem[], p: Paths): Item[] {
  const rel = p.knowledgeRel ?? "knowledge";
  return items.map((k) => ({
    id: `knowledge:${k.kind}:${k.id}`,
    label: k.name ?? k.title ?? k.id,
    description: k.kind,
    tooltip: [k.id, ...k.evidence.map((e) => e.path ?? e.record ?? "").filter(Boolean)].join("\n"),
    icon: "book",
    open: {
      kind: "file",
      path: join(p.root, rel, "items", k.kind.toLowerCase(), `${k.id}.yaml`),
    },
  }));
}

export function sourceItems(s: Api.Sources, p: Paths): Item[] {
  return [
    ...s.wikis.map((w) => ({
      id: `source:${w.id}`,
      label: w.id,
      description: `${w.type} · ${w.location}`,
      tooltip: `${w.id}: ${w.type} at ${w.location}${w.spaces.length ? ` (${w.spaces.join(", ")})` : ""}${w.owner ? `, owned by ${w.owner}` : ""}`,
      icon: "library",
      open: file(p, s.path),
    })),
    ...s.absorbed.map((a) => ({
      id: `absorbed:${a.id}`,
      label: a.id,
      description: `absorbed · ${a.format}`,
      tooltip: a.url,
      icon: "repo-clone",
      open: file(p, s.path),
    })),
  ];
}

/** The machine's checks (atticus doctor --json) that aren't ok, with their fix. */
export function healthProblems(d: Api.Doctor): string[] {
  return d.checks
    .filter((c) => c.status !== "ok" && c.status !== "skip")
    .map((c) => `${c.label}: ${c.detail}${c.fix ? `. ${c.fix}` : ""}`);
}

// ------------------------------------------------------------------ catalog

export function kindItems(ks: Api.KindCount[]): Item[] {
  return ks.map((k) => ({
    id: `kind:${k.kind}`,
    label: k.kind,
    description: `${num(k.count)}${k.stale ? ` · ${num(k.stale)} stale` : ""}`,
    icon: "symbol-class",
    expand: { kind: "kind", recordKind: k.kind },
  }));
}

export function recordItems(page: Api.RecordPage, p: Paths): Item[] {
  const items: Item[] = page.items.map((r) => {
    const repo = r.evidence.find((e) => e.repo)?.repo;
    return {
      id: `record:${r.kind}:${r.id}`,
      label: r.name ?? r.id,
      description: `${r.name && r.name !== r.id ? `${r.id} · ` : ""}${r.confidence}`,
      tooltip: `${r.kind} ${r.id}: ${r.status}, ${r.confidence}. ${plural(r.evidence.length, "citation")}.`,
      icon: "symbol-field",
      open: {
        kind: "file",
        path: join(p.root, p.catalogRel, "generated", r.kind.toLowerCase(), `${r.id}.yaml`),
      },
      ...(r.evidence.some((e) => e.path)
        ? { expand: { kind: "evidence" as const, ...(repo ? { repo } : {}), evidence: r.evidence } }
        : {}),
    };
  });
  const more = page.total - page.items.length;
  if (more > 0 && page.items[0])
    items.push({
      id: `more:${page.items[0].kind}`,
      label: `${num(more)} more in the app`,
      icon: "ellipsis",
      open: { kind: "app", hash: `#/explore?q=${encodeURIComponent(page.items[0].kind)}` },
    });
  return items;
}

export function evidenceItems(x: Extract<Expand, { kind: "evidence" }>, p: Paths): Item[] {
  return x.evidence
    .filter((e) => e.path)
    .map((e, i) => ({
      id: `ev:${i}:${e.repo ?? ""}:${e.path}:${e.line ?? ""}`,
      label: `${e.path}${e.line !== undefined ? `:${e.line}` : ""}`,
      description: e.source,
      icon: "go-to-file",
      open: codeOpen(e, x.repo, p),
    }));
}

// ------------------------------------------------------------------ one file's cited lines (ADR 0094)

export interface Lens {
  line: number;
  title: string;
  tooltip: string;
  open: Open;
}

const recordFile = (p: Paths, kind: string, id: string): Open => ({
  kind: "file",
  path: join(p.root, p.catalogRel, "generated", kind.toLowerCase(), `${id}.yaml`),
});

/** A lens for each flow step on a line, and one for the records read from it. */
export function citeLenses(c: Api.CiteList, p: Paths, o: { records?: boolean } = {}): Lens[] {
  const out: Lens[] = [];
  for (const l of c.lines) {
    for (const f of l.flows) {
      const cite: Cite = {
        line: l.line,
        n: f.step,
        kind: f.kind,
        repo: f.repo,
        flow: f.flow,
        name: f.name,
        ...(f.confirmedBy ? { confirmedBy: f.confirmedBy } : {}),
      };
      out.push({
        line: l.line,
        title: lensText(cite),
        tooltip: `Open ${f.name} in the Atticus tab, at ${f.step === 0 ? "its start" : `step ${f.step}`}`,
        open: { kind: "app", hash: flowHash(f.repo, f.flow, f.step) },
      });
    }
    if (o.records === false || !l.records.length) continue;
    const named = l.records.map((r) => `${r.kind} ${r.name ?? r.id}`);
    out.push({
      line: l.line,
      title: `Atticus: ${named.length > 3 ? `${named.slice(0, 3).join(", ")} and ${named.length - 3} more` : named.join(", ")}`,
      tooltip: `Read from this line (${[...new Set(l.records.map((r) => r.source))].join(", ")}): ${named.join(", ")}. Open the record.`,
      open:
        l.records.length === 1
          ? recordFile(p, l.records[0]!.kind, l.records[0]!.id)
          : {
              kind: "pick",
              title: "Which record?",
              choices: l.records.map((r) => ({
                label: `${r.kind} ${r.name ?? r.id}`,
                detail: r.id,
                open: recordFile(p, r.kind, r.id),
              })),
            },
    });
  }
  return out;
}

// ------------------------------------------------------------------ flow steps in the code

export interface Cite {
  line: number;
  /** 0 for what starts the flow, else the step number. */
  n: number;
  kind: string;
  repo: string;
  flow: string;
  name: string;
  confirmedBy?: string;
}

export function lensText(c: Cite): string {
  if (c.n === 0) return `Atticus: ${c.name} · start (${c.kind})`;
  const who = c.confirmedBy
    ? (CONFIRMED[c.confirmedBy] ?? c.confirmedBy).toLowerCase()
    : "not confirmed yet";
  return `Atticus: ${c.name} · step ${c.n}, ${c.kind} · ${who}`;
}

/** The open questions by repo (ADR 0098), the repos in order, each repo's in the order asked. */
export function questionGroups<Q extends { repo: string }>(
  qs: Q[],
): { repo: string; questions: Q[] }[] {
  const by = new Map<string, Q[]>();
  for (const q of qs) by.set(q.repo, [...(by.get(q.repo) ?? []), q]);
  return [...by.keys()].sort().map((repo) => ({ repo, questions: by.get(repo)! }));
}
