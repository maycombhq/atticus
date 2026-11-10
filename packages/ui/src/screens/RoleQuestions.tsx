import { useEffect, useState } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../api/client.js";
import { COPY } from "../copy.js";

/**
 * ADR 0181 part 4: each role answers its own questions on a change. The product owner answers the
 * brief's (Define), the architect the design's, the business analyst the stories', the tech lead
 * the tasks'. The questions API says each question's role and filters by it (`role`, `change`,
 * API 2.76.0); who "you" are comes from the change's owners (change.yaml) for the signed-in Git
 * user, else from the role the viewer picked, remembered in this browser. Words, not
 * permissions: anyone can still answer any question.
 */

const R = COPY.roles;

export const ROLES = ["product", "architecture", "analysis", "delivery"] as const;
export type Role = (typeof ROLES)[number];
const isRole = (v: unknown): v is Role =>
  typeof v === "string" && (ROLES as readonly string[]).includes(v);

type Store = Pick<Storage, "getItem" | "setItem">;
const ROLE_KEY = "atticus.viewerRole";

/** The browser's localStorage, or undefined where even asking for it throws. */
function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The role this viewer picked, if any (kept per browser). */
export function readViewerRole(store: Store | undefined = browserStore()): Role | undefined {
  try {
    const v = store?.getItem(ROLE_KEY);
    return isRole(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveViewerRole(role: Role | undefined, store: Store | undefined = browserStore()) {
  try {
    store?.setItem(ROLE_KEY, role ?? "");
  } catch {
    // Storage blocked: the pick lasts until the page reloads.
  }
}

/** The change and role a Questions address names (`#/questions?change=add-holds&role=architecture`). */
export function roleScopeOf(hash: string): { change?: string; role?: Role } {
  const q = hash.split("?")[1];
  const p = q ? new URLSearchParams(q) : undefined;
  const change = p?.get("change") ?? undefined;
  const role = p?.get("role");
  return {
    ...(change && /^[a-z0-9][a-z0-9._-]*$/.test(change) ? { change } : {}),
    ...(isRole(role) ? { role } : {}),
  };
}

/** The same scope with another role, or none. */
export function scopeWithRole(
  s: { change?: string; role?: Role },
  role: Role | undefined,
): { change?: string; role?: Role } {
  return { ...(s.change ? { change: s.change } : {}), ...(role ? { role } : {}) };
}

/** A questions list address with a change and a role added (the server filters, API 2.76.0). */
export function withRoleScope(url: string, scope: { change?: string; role?: string }): string {
  const extra = [
    ...(scope.change ? [`change=${encodeURIComponent(scope.change)}`] : []),
    ...(scope.role ? [`role=${encodeURIComponent(scope.role)}`] : []),
  ];
  if (!extra.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${extra.join("&")}`;
}

/** The Questions page's address for a change's role's questions. */
export const roleQuestionsHref = (change: string, role: Role) =>
  `#/questions?change=${encodeURIComponent(change)}&role=${role}`;

/** Whose role it is: the change's owners name the person, else the viewer's pick. */
export function yourRole(
  yourRoles: readonly string[] | undefined,
  picked: Role | undefined,
): { roles: Role[]; from: "owners" | "picker" | "none" } {
  const known = (yourRoles ?? []).filter(isRole);
  if (known.length) return { roles: known, from: "owners" };
  return picked ? { roles: [picked], from: "picker" } : { roles: [], from: "none" };
}

/**
 * Ninth UX walk: whether Home shows the role picker, and what it says. The picker is only for the
 * changes in flight that don't name the person among their owners (the owners win where they do),
 * so it is hidden when every change names them, and says it covers the rest when some do. Until
 * every change has said (`undefined`), it is shown as for none.
 */
export function pickerFor(named: readonly (boolean | undefined)[]): {
  show: boolean;
  hint: "none-named" | "some-named";
} {
  const known = named.filter((n): n is boolean => n !== undefined);
  if (known.length === named.length && named.length > 0 && known.every(Boolean))
    return { show: false, hint: "some-named" };
  return { show: true, hint: known.some(Boolean) ? "some-named" : "none-named" };
}

/** The role filter on Questions: every role, each with its open count, the person's marked. */
export function RoleFilter(p: {
  value: Role | undefined;
  onChange: (r: Role | undefined) => void;
  byRole?: Partial<Record<string, { open: number }>> | undefined;
  yours?: readonly string[] | undefined;
}) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor="questions-role" className="hud" style={{ fontSize: 10 }}>
        {R.filter}
      </label>
      <select
        id="questions-role"
        className="field"
        value={p.value ?? ""}
        onChange={(e) => p.onChange(isRole(e.target.value) ? e.target.value : undefined)}
      >
        <option value="">{R.allRoles}</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {R.option(R.names[r] ?? r, p.byRole?.[r]?.open, !!p.yours?.includes(r))}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The role picker for a viewer the change's owners don't name, remembered in this browser. */
export function RolePicker(p: {
  value: Role | undefined;
  onChange: (r: Role | undefined) => void;
  /** Ninth UX walk: some changes name the person, so the pick is for the others only. */
  hint?: "none-named" | "some-named";
}) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor="viewer-role" className="hud" style={{ fontSize: 10 }}>
        {R.pickYours}
      </label>
      <select
        id="viewer-role"
        className="field"
        aria-describedby="viewer-role-hint"
        value={p.value ?? ""}
        onChange={(e) => p.onChange(isRole(e.target.value) ? e.target.value : undefined)}
      >
        <option value="">{R.pickNone}</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {R.names[r]}
          </option>
        ))}
      </select>
      <span id="viewer-role-hint" className="muted" style={{ fontSize: 11.5 }}>
        {p.hint === "some-named" ? R.pickYoursHintSome : R.pickYoursHint}
      </span>
    </div>
  );
}

/** One change's line on Home: its open questions for the person's role, with a link to answer them. */
export function RoleQuestionsLine(p: {
  change: string;
  roles: readonly Role[];
  from: "owners" | "picker";
  byRole: Partial<Record<string, { open: number }>> | undefined;
}) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      {p.roles.map((r) => {
        const open = p.byRole?.[r]?.open ?? 0;
        return (
          <span key={r} style={{ fontSize: 13 }}>
            {R.line(p.change, R.who[r] ?? r, open)}{" "}
            {open > 0 && <a href={roleQuestionsHref(p.change, r)}>{R.open}</a>}
          </span>
        );
      })}
      <span className="hud" style={{ fontSize: 9.5 }}>
        {p.from === "owners" ? R.fromOwners : R.fromPicker}
      </span>
    </div>
  );
}

/** One change on Home: asks the server for its open questions by role and the person's roles. */
function ChangeRoleQuestions(p: {
  change: string;
  picked: Role | undefined;
  /** Ninth UX walk: tells Home whether this change's owners name the person. */
  onNamed?: (change: string, named: boolean) => void;
  /** ADR 0191: tells Home the person's roles on this change (the owners', else the pick). */
  onRoles?: (change: string, roles: Role[]) => void;
}) {
  const q = useApi<Api.QuestionListT>(
    `/api/questions?state=open&change=${encodeURIComponent(p.change)}`,
  );
  useReloadOnFiles(q);
  const named = q.state === "ready" ? (q.data.yourRoles ?? []).some(isRole) : undefined;
  const { onNamed, onRoles, change } = p;
  useEffect(() => {
    if (named !== undefined) onNamed?.(change, named);
  }, [named, change, onNamed]);
  const roles =
    q.state === "ready" ? yourRole(q.data.yourRoles, p.picked).roles.join(",") : undefined;
  useEffect(() => {
    if (roles !== undefined) onRoles?.(change, roles ? (roles.split(",") as Role[]) : []);
  }, [roles, change, onRoles]);
  if (q.state === "loading") return null;
  if (q.state === "error")
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        {R.cantRead(p.change)}
      </span>
    );
  const who = yourRole(q.data.yourRoles, p.picked);
  if (who.from === "none") return null;
  return (
    <RoleQuestionsLine
      change={p.change}
      roles={who.roles}
      from={who.from}
      byRole={q.data.counts?.byRole}
    />
  );
}

/**
 * States a change is no longer in flight in. Beta.23 review: a change in its post-release review
 * is still in flight (Home's Your changes lists it), so its roles are reported too.
 */
const LANDED = new Set(["released", "archived"]);

/** Most changes whose questions Home shows. */
const SHOWN = 5;

/**
 * Home's "Your role's questions": for each change in flight (up to five), the open questions of
 * the person's role, and the picker when no change names them. The person's roles are told for
 * every change in flight (beta.23 review): from the changes list's `yourRoles` (the owners,
 * else the role picked), else from the change's question panel.
 */
export function YourRoleQuestions(p: {
  changes: readonly { id: string; state: string; yourRoles?: readonly string[] | undefined }[];
  /** ADR 0191: the person's roles on each change in flight, for Home to show by role. */
  onRoles?: (byChange: Readonly<Record<string, Role[]>>) => void;
}) {
  const [picked, setPicked] = useState<Role | undefined>(() => readViewerRole());
  // Ninth UX walk: which changes name the person, so the picker shows only where it is used.
  const [named, setNamed] = useState<Record<string, boolean>>({});
  const [onNamed] = useState(
    () => (change: string, n: boolean) =>
      setNamed((o) => (o[change] === n ? o : { ...o, [change]: n })),
  );
  // ADR 0191: each change's roles for the person, put together for Home.
  const [byChange, setByChange] = useState<Record<string, Role[]>>({});
  const [onChangeRoles] = useState(
    () => (change: string, roles: Role[]) =>
      setByChange((o) =>
        o[change]?.join(",") === roles.join(",") ? o : { ...o, [change]: roles },
      ),
  );
  const { onRoles } = p;
  const inFlight = p.changes.filter((c) => !LANDED.has(c.state));
  const told: Record<string, Role[]> = {};
  for (const c of inFlight) {
    const roles = c.yourRoles ? yourRole(c.yourRoles, picked).roles : byChange[c.id];
    if (roles) told[c.id] = roles;
  }
  // One key for what is told, so Home hears it again only when it changes.
  const key = JSON.stringify(Object.entries(told));
  useEffect(() => {
    onRoles?.(Object.fromEntries(JSON.parse(key) as [string, Role[]][]));
  }, [key, onRoles]);
  const live = inFlight.slice(0, SHOWN);
  if (!live.length) return null;
  const picker = pickerFor(live.map((c) => (c.yourRoles ? c.yourRoles.some(isRole) : named[c.id])));
  return (
    <section className="panel stack" aria-labelledby="your-role-questions" style={{ gap: 8 }}>
      <p id="your-role-questions" className="hud" style={{ margin: 0 }}>
        {R.homeTitle}
      </p>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {R.homeIntro}
      </p>
      {live.map((c) => (
        <ChangeRoleQuestions
          key={c.id}
          change={c.id}
          picked={picked}
          onNamed={onNamed}
          onRoles={onChangeRoles}
        />
      ))}
      {picker.show && (
        <RolePicker
          value={picked}
          hint={picker.hint}
          onChange={(r) => {
            setPicked(r);
            saveViewerRole(r);
          }}
        />
      )}
    </section>
  );
}
