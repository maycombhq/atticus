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
}

export interface InboxItem {
  kind: "phase" | "finding" | "need" | "triage" | "question" | "step";
  title: string;
  detail: string;
  href: string;
  since?: string;
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
      });
  for (const n of d.needs ?? [])
    if (n.status === "open")
      out.push({
        kind: "need",
        title: n.title,
        detail: [n.kind, n.handledBy, n.leadTime, n.change].filter(Boolean).join(" · "),
        href: "#/changes?across=needs",
      });
  for (const t of d.triage)
    out.push({ kind: "triage", title: t.summary, detail: t.kind, href: "#/intake" });
  for (const q of d.questions)
    out.push({
      kind: "question",
      title: q.question,
      detail: `${q.system ?? ""}${q.owner ? ` · ask ${q.owner}` : ""}`,
      href: "#/map",
    });
  for (const s of d.steps)
    out.push({
      kind: "step",
      title: s.title,
      detail: `${s.system}${s.change ? ` · ${s.change}` : ""}`,
      href: "#/todo",
    });
  return out;
}
