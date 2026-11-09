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

/** One change's line: its title, where it is, and whom it waits on (you, or someone named). */
export function ChangeWaitsLine(p: {
  c: { id: string; title: string; state: string };
  waitsOn: Api.WaitsOnT | undefined;
  me: string | undefined;
}) {
  const w = p.waitsOn;
  const mine =
    !!w &&
    !!p.me &&
    w.people.some((x) => x.toLowerCase() === p.me!.replace(/^@/, "").toLowerCase());
  const role = w ? (R.roleNames[w.role] ?? w.role) : undefined;
  return (
    <li className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <a href={`#/changes/${encodeURIComponent(p.c.id)}`}>{p.c.title}</a>
      <span className="hud" style={{ fontSize: 10 }}>
        {COPY.commandCenter.inState(p.c.state)}
      </span>
      {w &&
        (mine ? (
          <span className="chip warn">{H.waitsOnYou}</span>
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>
            {w.people.length
              ? H.waitsOnOther(`${w.people.map((x) => `@${x}`).join(", ")} (${role})`)
              : R.waitsOnNobody(role ?? w.role)}
          </span>
        ))}
    </li>
  );
}

function ChangeWaits(p: {
  c: { id: string; title: string; state: string };
  me: string | undefined;
}) {
  const ck = useApi<Api.ChangeCockpitT>(`/api/changes/${encodeURIComponent(p.c.id)}/cockpit`);
  useReloadOnFiles(ck);
  return (
    <ChangeWaitsLine
      c={p.c}
      waitsOn={ck.state === "ready" ? ck.data.waitsOn : undefined}
      me={p.me}
    />
  );
}

/** "Your changes": the changes in flight that name the person, each with whom it waits on. */
export function YourChanges(p: {
  changes: readonly { id: string; title: string; state: string }[];
  /** The changes whose owners name the person. */
  yours: readonly string[];
  role: string;
  me: string | undefined;
}) {
  const mine = p.changes.filter((c) => p.yours.includes(c.id));
  return (
    <section className="panel stack" aria-labelledby="your-changes" style={{ gap: 6 }}>
      <h2 id="your-changes" className="hud" style={{ margin: 0 }}>
        {H.yourChanges}
      </h2>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {H.yourChangesIntro(p.role)}
      </p>
      {mine.length === 0 ? (
        <div className="state">{H.noneYours}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
          {mine.map((c) => (
            <ChangeWaits key={c.id} c={c} me={p.me} />
          ))}
        </ul>
      )}
    </section>
  );
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
