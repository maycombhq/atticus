import { CORE_ROLES, type ChangeLifecycle, type ChangeType } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import type { Reason } from "./errors.js";
import type { Footprint } from "./footprint.js";
import { artifactPhase } from "./lifecycle.js";
import type { Risk } from "./risk.js";
import type { Artifact, PhaseId } from "./types.js";

/**
 * One approval a hand-off needs: `min` distinct people holding any of `roles`. Requirements
 * with the same roles and minimum are merged, keeping every source, so a role the change
 * type and the gate both ask for is asked once.
 */
export interface Requirement {
  roles: string[];
  min: number;
  sources: string[];
  label: string;
}

export interface PrivacyImpact {
  touched: boolean;
  records: Footprint["personal"];
  role: string;
  /** Whether roles.yaml defines the role (a core role, an enabled optional one or a custom one). */
  roleDefined: boolean;
  /** The phase whose hand-off needs the privacy approval. */
  phase: PhaseId;
}

const strip = (h: string) => (h.startsWith("@") ? h.slice(1) : h);

function label(roles: string[], min: number, sources: string[]): string {
  const who = roles.length === 1 && min === 1 ? roles[0]! : `${min} of ${roles.join(", ")}`;
  return `${who} (${sources.join(", ")})`;
}

export function privacyImpact(
  ctx: ChangeContext,
  type: ChangeType,
  footprint: Footprint,
): PrivacyImpact {
  const { role, phases } = ctx.policy.privacy;
  const roles = ctx.orgPack.roles;
  const roleDefined =
    (CORE_ROLES as readonly string[]).includes(role) ||
    (roles.enabledOptional as string[]).includes(role) ||
    roles.custom.some((c) => c.id === role);
  return {
    touched: footprint.personal.length > 0,
    records: footprint.personal,
    role,
    roleDefined,
    phase: phases.find((p) => type.phases.includes(p)) ?? type.phases.at(-1)!,
  };
}

/** Everyone whose approval a phase's hand-off needs: change type, gates, privacy and risk. */
export function requiredApprovals(
  ctx: ChangeContext,
  type: ChangeType,
  phase: PhaseId,
  privacy: PrivacyImpact,
  risk: Risk,
): Requirement[] {
  const raw: { roles: string[]; min: number; source: string }[] = [];
  for (const role of type.approvals[phase] ?? [])
    raw.push({ roles: [role], min: 1, source: `change type ${type.id}` });
  for (const g of ctx.orgPack.gates.gates.filter((x) => x.phase === phase))
    raw.push({ roles: [...g.approvers].sort(), min: g.minApprovals, source: `gate ${g.id}` });
  if (privacy.touched && privacy.phase === phase && privacy.roleDefined)
    raw.push({ roles: [privacy.role], min: 1, source: "personal data" });
  for (const role of ctx.policy.risk.approvals[risk.level]?.[phase] ?? [])
    raw.push({ roles: [role], min: 1, source: `${risk.level} risk` });

  const out: Requirement[] = [];
  for (const r of raw) {
    const same = out.find((o) => o.min === r.min && o.roles.join() === r.roles.join());
    if (same) {
      if (!same.sources.includes(r.source)) same.sources.push(r.source);
      same.label = label(same.roles, same.min, same.sources);
    } else
      out.push({
        roles: r.roles,
        min: r.min,
        sources: [r.source],
        label: label(r.roles, r.min, [r.source]),
      });
  }
  return out;
}

/** People holding a role on this change (change.yaml owners), without "@". */
export function holders(change: ChangeLifecycle, role: string): string[] {
  return (change.owners[role] ?? []).map(strip);
}

/** Who wrote the artifacts handed off in this phase (and brief.md with the first phase). */
export function phaseAuthors(
  ctx: ChangeContext,
  change: ChangeLifecycle,
  type: ChangeType,
  phase: PhaseId,
): Map<string, Artifact[]> {
  const out = new Map<string, Artifact[]>();
  for (const [a, people] of Object.entries(change.authors) as [Artifact, string[]][]) {
    const inPhase =
      artifactPhase(ctx, type, a) === phase || (a === "brief" && phase === type.phases[0]);
    if (!inPhase) continue;
    for (const p of people.map(strip)) out.set(p, [...(out.get(p) ?? []), a]);
  }
  return out;
}

export interface ApprovalResult {
  /** People whose approval counted, with the roles it filled. */
  counted: { by: string; roles: string[] }[];
  /** Empty when every requirement is met. */
  reasons: Reason[];
}

/**
 * Check approvals against the requirements, applying separation of duties:
 * - at release nobody who wrote any artifact of the change, or raised the hand-off, counts
 *   (not configurable);
 * - elsewhere the author of an artifact handed off in this phase doesn't count, unless the
 *   change policy allows it for this type, phase and role;
 * - roles.yaml separation pairs (`author:<artifact>`, `approve:<phase>`) are applied as written.
 */
export function evaluateApprovals(input: {
  ctx: ChangeContext;
  change: ChangeLifecycle;
  type: ChangeType;
  phase: PhaseId;
  requirements: Requirement[];
  approvers: string[];
  raiser: string;
}): ApprovalResult {
  const { ctx, change, type, phase, requirements } = input;
  const approvers = [...new Set(input.approvers.map(strip))].sort();
  const raiser = strip(input.raiser);
  const authorsHere = phaseAuthors(ctx, change, type, phase);
  const allAuthors = new Map<string, Artifact[]>();
  for (const [a, people] of Object.entries(change.authors) as [Artifact, string[]][])
    for (const p of people.map(strip)) allAuthors.set(p, [...(allAuthors.get(p) ?? []), a]);

  const files = (as: Artifact[]) => as.map((a) => (a === "specs" ? "specs" : `${a}.md`)).join(", ");
  const roleHeld = (p: string, role: string) => holders(change, role).includes(p);

  /** Undefined when p may approve for any role; else the roles p may still fill, and why not. */
  function limits(p: string): { allowed: Set<string> | "none"; reason?: Reason } {
    if (phase === "release") {
      const wrote = allAuthors.get(p);
      if (wrote || p === raiser) {
        const what = wrote ? `wrote ${files(wrote)}` : "raised this hand-off";
        return {
          allowed: "none",
          reason: {
            code: "self-approval",
            person: p,
            message: `${p} ${what}; nobody approves their own change at release.`,
          },
        };
      }
    } else if (authorsHere.has(p)) {
      const rule = ctx.policy.selfApproval.filter(
        (r) => (r.types.length === 0 || r.types.includes(type.id)) && r.phases.includes(phase),
      );
      const ok = new Set(rule.flatMap((r) => r.roles).filter((role) => roleHeld(p, role)));
      const reason: Reason = {
        code: "self-approval",
        person: p,
        message: `${p} wrote ${files(authorsHere.get(p)!)} and can't approve the ${phase} hand-off.`,
      };
      if (ok.size === 0) return { allowed: "none", reason };
      const sep = separation(p);
      if (sep) return { allowed: "none", reason: sep };
      return { allowed: ok, reason };
    }
    const sep = separation(p);
    return sep ? { allowed: "none", reason: sep } : { allowed: new Set(["*"]) };
  }

  function separation(p: string): Reason | undefined {
    const did = new Set<string>();
    for (const [a, people] of Object.entries(change.authors) as [Artifact, string[]][])
      if (people.map(strip).includes(p)) did.add(`author:${a}`);
    for (const h of change.handoffs)
      if (h.state === "merged" && h.phase !== phase && h.approvals.some((x) => strip(x.by) === p))
        did.add(`approve:${h.phase}`);
    for (const pair of ctx.orgPack.roles.separation) {
      const [a, b] = pair.actions;
      const other = a === `approve:${phase}` ? b : b === `approve:${phase}` ? a : undefined;
      if (other && did.has(other))
        return {
          code: "separation",
          person: p,
          message: `${p} can't approve this: ${pair.reason}`,
        };
    }
    return undefined;
  }

  const lim = new Map(approvers.map((p) => [p, limits(p)]));
  const counts = (p: string, role: string) => {
    const l = lim.get(p)!;
    return l.allowed !== "none" && (l.allowed.has("*") || l.allowed.has(role)) && roleHeld(p, role);
  };

  const reasons: Reason[] = [];
  const filled = new Map<string, Set<string>>();
  for (const req of requirements) {
    const ok = approvers.filter((p) => req.roles.some((role) => counts(p, role)));
    for (const p of ok)
      for (const role of req.roles)
        if (counts(p, role)) filled.set(p, (filled.get(p) ?? new Set()).add(role));
    if (ok.length >= req.min) continue;
    const anyone = req.roles.some((role) => holders(change, role).length > 0);
    let message = `Needs approval from ${req.label}`;
    if (ok.length > 0) message += ` (${ok.length} so far)`;
    message += ".";
    if (!anyone)
      message += ` Nobody holds ${req.roles.join(" or ")} on this change; add them under owners in change.yaml.`;
    reasons.push({ code: "approval-missing", role: req.roles.join(","), message });
  }
  if (reasons.length > 0) {
    const relevant = new Set(requirements.flatMap((r) => r.roles));
    for (const [p, l] of lim) {
      if (!l.reason) continue;
      const blockedRoles = [...relevant].filter((role) => roleHeld(p, role) && !counts(p, role));
      if (blockedRoles.length > 0) reasons.push(l.reason);
    }
  }
  return {
    counted: [...filled]
      .map(([by, roles]) => ({ by, roles: [...roles].sort() }))
      .sort((a, b) => a.by.localeCompare(b.by)),
    reasons,
  };
}
