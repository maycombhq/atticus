/**
 * Role views (ADR 0044): what each role sees first. A view decides the home and the sidebar;
 * every screen stays reachable under All screens and the command palette. Approvals never come
 * from here.
 */

export const ROLE_SCREENS: Record<string, string[]> = {
  "product-owner": ["home", "brief", "ux", "changes", "breakdown", "initiatives", "map", "explore"],
  "business-analyst": [
    "home",
    "breakdown",
    "brief",
    "changes",
    "trace",
    "features",
    "explore",
    "map",
  ],
  architect: [
    "home",
    "arch-review",
    "diagrams",
    "reconcile",
    "contracts",
    "impact",
    "map",
    "orgpack",
  ],
  "team-lead": ["home", "breakdown", "tasks", "changes", "initiatives", "release", "impact"],
  developer: ["home", "tasks", "changes", "contracts", "mappings", "impact", "explore", "todo"],
  qa: ["home", "trace", "tasks", "changes", "breakdown", "release", "features", "explore"],
  "delivery-lead": [
    "home",
    "release",
    "service-desk",
    "initiatives",
    "todo",
    "changes",
    "governance",
  ],
  "platform-lead": [
    "home",
    "scans",
    "intake",
    "orgpack",
    "governance",
    "evals",
    "settings",
    "learning",
  ],
  designer: ["home", "ux", "brief", "diagrams", "breakdown", "changes", "features"],
  "process-owner": ["home", "orgpack", "service-desk", "todo", "intake", "explore", "learning"],
  "data-architect": ["home", "contracts", "mappings", "impact", "arch-review", "governance", "map"],
  sre: ["home", "release", "impact", "governance", "map", "todo", "explore"],
  "security-reviewer": [
    "home",
    "governance",
    "release",
    "contracts",
    "impact",
    "arch-review",
    "map",
  ],
};

export interface RoleDef {
  id: string;
  name: string;
  core: boolean;
  basedOn?: string;
}

/** The sidebar for a view; with no view yet, a short starting list. */
export function screensFor(view: string | null, roles: readonly RoleDef[]): string[] {
  if (!view) return ["home", "explore", "changes", "map"];
  const base = ROLE_SCREENS[view] ?? ROLE_SCREENS[roles.find((r) => r.id === view)?.basedOn ?? ""];
  return base ?? ["home", "explore", "changes", "map"];
}

/** The built-in role a view behaves as (a custom role as the one it is based on). */
export function baseRole(view: string | null, roles: readonly RoleDef[]): string | null {
  if (!view) return null;
  if (ROLE_SCREENS[view]) return view;
  return roles.find((r) => r.id === view)?.basedOn ?? null;
}

// ------------------------------------------------------------------ inbox

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
  /** Hand-off PRs waiting on the person (from ownership, never the view). */
  approvals?: {
    change: string;
    title: string;
    phase: string;
    pr: string;
    kind: "review" | "revise";
    because: string;
    openedAt?: string;
  }[];
}

export interface InboxItem {
  kind: "approval" | "phase" | "finding" | "triage" | "question" | "step";
  title: string;
  detail: string;
  href: string;
  since?: string;
}

/** The artifacts each role owns in a change (CODEOWNERS in the plan's default layout). */
const ARTIFACTS: Record<string, string[]> = {
  "product-owner": ["brief", "proposal"],
  "business-analyst": ["stories", "specs"],
  architect: ["design", "interfaces", "mappings"],
  "team-lead": ["tasks", "snow"],
  developer: [],
  qa: ["tests"],
  "delivery-lead": [],
  "platform-lead": [],
  designer: ["ux"],
  "process-owner": [],
  "data-architect": ["data"],
  sre: [],
  "security-reviewer": ["security"],
};

/** The lifecycle state in which a change waits on each role, and the screen to act on it. */
const WAITS_IN: Record<string, { state: string; screen: string }[]> = {
  "product-owner": [{ state: "define", screen: "brief" }],
  architect: [{ state: "design", screen: "arch-review" }],
  "business-analyst": [{ state: "plan", screen: "breakdown" }],
  "team-lead": [{ state: "plan", screen: "breakdown" }],
  developer: [{ state: "build", screen: "tasks" }],
  qa: [{ state: "qa", screen: "trace" }],
  "delivery-lead": [{ state: "release-ready", screen: "release" }],
  designer: [{ state: "define", screen: "ux" }],
};

/** Where a role acts on a finding about one of its artifacts. */
const FINDING_SCREEN: Record<string, string> = {
  "product-owner": "brief",
  "business-analyst": "breakdown",
  architect: "arch-review",
  "team-lead": "breakdown",
  qa: "trace",
  designer: "ux",
  "data-architect": "mappings",
  "security-reviewer": "release",
};

const STEP_ROLES = new Set(["delivery-lead", "developer", "team-lead", "process-owner"]);
const TRIAGE_ROLES = new Set(["platform-lead", "architect"]);
const QUESTION_ROLES = new Set(["platform-lead", "architect"]);

/** Everything waiting on a role: changes in its phase, findings on its artifacts, then queues. */
export function inboxFor(role: string, d: InboxData): InboxItem[] {
  const out: InboxItem[] = [];
  // Approvals come first and whatever the view: they follow ownership, and the PR is where you approve.
  for (const a of d.approvals ?? [])
    out.push({
      kind: "approval",
      title:
        a.kind === "review"
          ? `Review the ${a.phase} hand-off of ${a.title}`
          : `Revise the ${a.phase} hand-off of ${a.title}: changes were requested`,
      detail: `${a.change} · ${a.because}`,
      href: a.pr,
      ...(a.openedAt ? { since: a.openedAt } : {}),
    });
  for (const w of WAITS_IN[role] ?? [])
    for (const c of d.changes.filter((x) => x.state === w.state))
      out.push({
        kind: "phase",
        title: `${c.title} is in ${c.state}`,
        detail: `${c.id} · ${c.type}`,
        href: `#/${w.screen}?change=${encodeURIComponent(c.id)}`,
        ...(c.updatedAt ? { since: c.updatedAt } : {}),
      });
  const mine = ARTIFACTS[role] ?? [];
  for (const f of d.findings)
    if (
      f.state === "open" &&
      (f.severity === "blocking" || f.severity === "gap") &&
      mine.some((a) => f.artifact.startsWith(a))
    )
      out.push({
        kind: "finding",
        title: f.summary,
        detail: `${f.severity} · ${f.artifact}${f.change ? ` · ${f.change}` : ""}`,
        href: `#/${FINDING_SCREEN[role] ?? "changes"}${f.change ? `?change=${encodeURIComponent(f.change)}` : ""}`,
      });
  if (TRIAGE_ROLES.has(role))
    for (const t of d.triage)
      out.push({ kind: "triage", title: t.summary, detail: t.kind, href: "#/intake" });
  if (QUESTION_ROLES.has(role))
    for (const q of d.questions)
      out.push({
        kind: "question",
        title: q.question,
        detail: `${q.system ?? ""}${q.owner ? ` · ask ${q.owner}` : ""}`,
        href: "#/map",
      });
  if (STEP_ROLES.has(role))
    for (const s of d.steps)
      out.push({
        kind: "step",
        title: s.title,
        detail: `${s.system}${s.change ? ` · ${s.change}` : ""}`,
        href: "#/todo",
      });
  return out;
}
