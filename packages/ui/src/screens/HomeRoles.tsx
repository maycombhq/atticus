import type { ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../api/client.js";
import { COPY } from "../copy.js";

/**
 * ADR 0191: Home by role. A product owner or business analyst sees their changes and what waits on
 * them first, with only the findings at their level; what sets Atticus up (the checklist, an
 * upgrade, the estate's checks) is folded away under "Setting up Atticus", one click to open.
 * Words, not permissions: everyone can still open every page.
 */

const H = COPY.roleWork.home;
const R = COPY.roleWork;

/** Whether the person's roles are all ones that don't set Atticus up (the PO, the BA). */
export function nonAdminRoles(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((r) => r === "product" || r === "analysis");
}

/** Whether the change waits on the person (the Git user named among those it waits on). */
export const waitsOnMe = (w: Api.WaitsOnT | undefined, me: string | undefined) =>
  !!w && !!me && w.people.some((x) => x.toLowerCase() === me.replace(/^@/, "").toLowerCase());

/**
 * beta.26: one change on Home's Changes panel, in one line: its title (to its page), its id and
 * whom it waits on in a muted line under it, then its stage, BLOCKED and "waits on you" as chips.
 */
export function HomeChangeRow(p: {
  c: { id: string; title: string; state: string; blocked?: boolean };
  stage: string;
  waitsOn?: Api.WaitsOnT | undefined;
  me: string | undefined;
}) {
  const w = p.waitsOn;
  const mine = waitsOnMe(w, p.me);
  const role = w ? (R.roleNames[w.role] ?? w.role) : undefined;
  const other =
    w && !mine
      ? w.people.length
        ? H.waitsOnOther(`${w.people.map((x) => `@${x}`).join(", ")} (${role})`)
        : R.waitsOnNobody(role ?? w.role)
      : undefined;
  return (
    <li>
      <span className="hm-row-main">
        <a className="hm-row-title" href={`#/changes/${encodeURIComponent(p.c.id)}`}>
          {p.c.title}
        </a>
        <span className="hm-row-sub">
          {p.c.id}
          {other ? ` · ${other}` : ""}
        </span>
      </span>
      <span className="hm-row-end">
        {p.c.blocked && <span className="chip blocking">{COPY.commandCenter.blocked}</span>}
        {mine && <span className="chip warn">{H.waitsOnYou}</span>}
        <span className="chip dim">{p.stage}</span>
      </span>
    </li>
  );
}

/** HomeChangeRow with whom the change waits on, from its cockpit (a change the person is on). */
export function HomeChangeWaits(p: {
  c: { id: string; title: string; state: string; blocked?: boolean };
  stage: string;
  me: string | undefined;
}) {
  const ck = useApi<Api.ChangeCockpitT>(`/api/changes/${encodeURIComponent(p.c.id)}/cockpit`);
  useReloadOnFiles(ck);
  return <HomeChangeRow {...p} waitsOn={ck.state === "ready" ? ck.data.waitsOn : undefined} />;
}

/** The set-up material, folded away for a product owner or business analyst; open for others. */
export function AdminFold(p: { fold: boolean; children: ReactNode }) {
  if (!p.fold) return <>{p.children}</>;
  return (
    <details className="panel">
      <summary className="hud">{H.admin}</summary>
      <p className="muted" style={{ margin: "6px 0", fontSize: 12.5 }}>
        {H.adminIntro}
      </p>
      <div className="stack" style={{ gap: 12 }}>
        {p.children}
      </div>
    </details>
  );
}
