import { COPY } from "../copy.js";
import { matchesWords } from "./match.js";

/**
 * What needs a person (ADR 0073): one list for everyone. There are no roles: every change in a
 * phase, every open blocking finding or knowledge gap, open need of a change (ADR 0105), triage
 * item, owner question and manual step shows, each linking to the screen where it is acted on. Approving is the Git host's: a
 * gate is approved when its hand-off PR merges, so the list links to the change, not to an
 * approval button.
 */

export interface InboxData {
  changes: { id: string; title: string; type: string; state: string; updatedAt?: string }[];
  findings: {
    id: string;
    gate: string;
    severity: string;
    artifact: string;
    summary: string;
    state: string;
    change?: string;
  }[];
  questions: { id: string; question: string; owner?: string; system?: string }[];
  triage: { id: string; kind: string; summary: string }[];
  steps: { id: string; title: string; system: string; change?: string }[];
  /** Every change's needs (ADR 0101); the open ones show. */
  needs?: {
    change: string;
    item: string;
    title: string;
    kind: string;
    status: string;
    handledBy?: string;
    leadTime?: string;
  }[];
  /** The questions a step raised (questions/<id>.yaml, ADR 0078), by repo. */
  questionFiles?: { id: string; question: string; repo: string }[];
  /** How many knowledge items no one has verified yet, when the page knows it. */
  knowledgeToVerify?: number;
}

export interface InboxItem {
  kind: "phase" | "finding" | "need" | "triage" | "question" | "step" | "knowledge";
  title: string;
  detail: string;
  href: string;
  since?: string;
  /** The item's own id, its change and its repo, for grouping and the filter. */
  id?: string;
  change?: string;
  repo?: string;
  blocking?: boolean;
}

/** The screen where a change in each lifecycle state is worked on. */
const PHASE_SCREEN: Record<string, string> = {
  define: "brief",
  design: "arch-review",
  plan: "breakdown",
  build: "tasks",
  qa: "trace",
  "release-ready": "release",
  "post-release-review": "release",
  returned: "brief",
};

/** The screen where a finding about an artifact is acted on, by the artifact's name. */
const ARTIFACT_SCREEN: [string, string][] = [
  ["brief", "brief"],
  ["proposal", "brief"],
  ["ux", "ux"],
  ["design", "arch-review"],
  ["interfaces", "arch-review"],
  ["data", "arch-review"],
  ["mappings", "mappings"],
  ["stories", "breakdown"],
  ["specs", "breakdown"],
  ["tasks", "breakdown"],
  ["snow", "breakdown"],
  ["tests", "trace"],
  ["security", "release"],
];

const withChange = (screen: string, change?: string) =>
  `#/${screen}${change ? `?change=${encodeURIComponent(change)}` : ""}`;

/** Everything that needs a person: changes in a phase, blocking findings and gaps, then queues. */
export function inboxOf(d: InboxData): InboxItem[] {
  const out: InboxItem[] = [];
  for (const c of d.changes) {
    const screen = PHASE_SCREEN[c.state];
    if (!screen) continue;
    out.push({
      kind: "phase",
      title: `${c.title} is in ${c.state}`,
      detail: `${c.id} · ${c.type}`,
      href: withChange(screen, c.id),
      id: c.id,
      change: c.id,
      ...(c.updatedAt ? { since: c.updatedAt } : {}),
    });
  }
  for (const f of d.findings)
    if (f.state === "open" && (f.severity === "blocking" || f.severity === "gap"))
      out.push({
        kind: "finding",
        title: f.summary,
        detail: `${f.severity} · ${f.artifact}${f.change ? ` · ${f.change}` : ""}`,
        href: withChange(
          ARTIFACT_SCREEN.find(([a]) => f.artifact.startsWith(a))?.[1] ?? "changes",
          f.change,
        ),
        id: f.id,
        ...(f.change ? { change: f.change } : {}),
        ...(f.severity === "blocking" ? { blocking: true } : {}),
      });
  for (const n of d.needs ?? [])
    if (n.status === "open")
      out.push({
        kind: "need",
        title: n.title,
        detail: [n.kind, n.handledBy, n.leadTime, n.change].filter(Boolean).join(" · "),
        href: "#/changes?across=needs",
        id: n.item,
        change: n.change,
      });
  for (const t of d.triage)
    out.push({ kind: "triage", title: t.summary, detail: t.kind, href: "#/intake", id: t.id });
  for (const q of d.questions)
    out.push({
      kind: "question",
      title: q.question,
      detail: `${q.system ?? ""}${q.owner ? ` · ask ${q.owner}` : ""}`,
      href: "#/map",
      id: q.id,
      ...(q.system ? { repo: q.system } : {}),
    });
  for (const q of d.questionFiles ?? [])
    out.push({
      kind: "question",
      title: q.question,
      detail: `${q.repo} · ${q.id}`,
      href: `#/questions/${encodeURIComponent(q.id)}`,
      id: q.id,
      repo: q.repo,
    });
  for (const s of d.steps)
    out.push({
      kind: "step",
      title: s.title,
      detail: `${s.system}${s.change ? ` · ${s.change}` : ""}`,
      href: "#/todo",
      id: s.id,
      ...(s.change ? { change: s.change } : {}),
    });
  if (d.knowledgeToVerify)
    out.push({
      kind: "knowledge",
      title: COPY.commandCenter.knowledgeToVerify(d.knowledgeToVerify),
      detail: COPY.commandCenter.knowledgeDetail,
      href: "#/knowledge",
    });
  return out;
}

/** The kinds a group lists, in order: a change's, then what belongs to no change. */
export type WaitingKind = "need" | "finding" | "step" | "question" | "triage" | "knowledge";
const IN_CHANGE: WaitingKind[] = ["need", "finding", "step"];
const NO_CHANGE: WaitingKind[] = ["question", "need", "finding", "step", "triage", "knowledge"];

export interface WaitingSection {
  kind: WaitingKind;
  /** Questions are listed by repo. */
  repo?: string;
  items: InboxItem[];
}
export interface WaitingGroup {
  /** The change's id; none for the group of what belongs to no change. */
  change?: string;
  title: string;
  state?: string;
  blocking: number;
  count: number;
  sections: WaitingSection[];
}

/**
 * What needs a person grouped by change (ADR 0105 addendum): each change with something open,
 * with its open needs, its findings (blocking first) and its manual steps; changes with a
 * blocking finding first, then in the order the changes are listed. Then one group for what
 * belongs to no change: questions by repo, manual steps, triage and knowledge to verify. A
 * change in a phase with nothing open has no group: the changes in flight list it. The filter
 * matches an item's title, id, change (its id or title) and repo.
 */
export function waitingByChange(
  items: InboxItem[],
  changes: { id: string; title: string; state?: string }[],
  text: string,
): { groups: WaitingGroup[]; shown: number; total: number } {
  const listed = items.filter((i) => i.kind !== "phase");
  const byId = new Map(changes.map((c, n) => [c.id, { ...c, n }]));
  const shown = listed.filter((i) =>
    matchesWords([i.title, i.id, i.change, i.change && byId.get(i.change)?.title, i.repo], text),
  );
  const sectionsOf = (list: InboxItem[], kinds: WaitingKind[]): WaitingSection[] =>
    kinds.flatMap((kind): WaitingSection[] => {
      const of = list.filter((i) => i.kind === kind);
      if (!of.length) return [];
      if (kind === "finding")
        return [
          { kind, items: [...of.filter((i) => i.blocking), ...of.filter((i) => !i.blocking)] },
        ];
      if (kind !== "question") return [{ kind, items: of }];
      const repos = [...new Set(of.map((i) => i.repo ?? ""))].sort((a, b) =>
        !a ? 1 : !b ? -1 : a.localeCompare(b),
      );
      return repos.map((r) => ({
        kind,
        ...(r ? { repo: r } : {}),
        items: of.filter((i) => (i.repo ?? "") === r),
      }));
    });
  const ids = [...new Set(shown.map((i) => i.change).filter((c): c is string => !!c))];
  const order = (g: WaitingGroup) => byId.get(g.change ?? "")?.n ?? Number.MAX_SAFE_INTEGER;
  const groups: WaitingGroup[] = ids
    .map((id): WaitingGroup => {
      const of = shown.filter((i) => i.change === id);
      const c = byId.get(id);
      return {
        change: id,
        title: c?.title ?? id,
        ...(c?.state ? { state: c.state } : {}),
        blocking: of.filter((i) => i.blocking).length,
        count: of.length,
        sections: sectionsOf(of, IN_CHANGE),
      };
    })
    .sort((a, b) => Number(b.blocking > 0) - Number(a.blocking > 0) || order(a) - order(b));
  const none = shown.filter((i) => !i.change);
  if (none.length)
    groups.push({
      title: COPY.commandCenter.noChangeGroup,
      blocking: 0,
      count: none.length,
      sections: sectionsOf(none, NO_CHANGE),
    });
  return { groups, shown: shown.length, total: listed.length };
}
