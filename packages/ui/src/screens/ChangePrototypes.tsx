import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "./know/common.js";

const T = COPY.changes;
const GROUPS = ["exists", "changes", "new", "vendor"] as const;

/** One call of the prototype: its sentence, where both sides cite it, and what differs. */
function Call({ c }: { c: Api.PrototypeCallViewT }) {
  return (
    <li className="stack" style={{ gap: 3, borderTop: "1px solid var(--rule)", paddingTop: 6 }}>
      <span>
        <span className="chip">{T.prototypeLeg[c.leg]}</span>{" "}
        <span className="mono">{[c.method, c.path].filter(Boolean).join(" ")}</span>
      </span>
      <span>{c.sentence}</span>
      <span className="muted mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
        {T.prototypeCites(c.call.at, c.lands.at)}
      </span>
      {c.estate && (
        <span className="muted mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
          {T.prototypeEstate(c.estate.entry.repo, c.estate.entry.at)}
        </span>
      )}
      {c.vendor?.at && (
        <span className="muted mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
          {c.vendor.boundary === "internal"
            ? T.prototypeTeam(c.vendor.name, c.vendor.at)
            : T.prototypeVendor(c.vendor.name, c.vendor.at)}
        </span>
      )}
      {c.differences.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {c.differences.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One prototype's comparison: what it is, then its calls in the four groups. */
export function PrototypeComparison({ p }: { p: Api.ChangePrototypeT }) {
  const headingId = `proto-${p.repo}`;
  return (
    <article className="stack" style={{ gap: 8 }} aria-labelledby={headingId}>
      <h3 id={headingId} className="h" style={{ fontSize: 13 }}>
        <span className="chip">{T.prototypeMarker}</span> <span className="mono">{p.repo}</span>
      </h3>
      <span className="muted">
        {p.about
          ? `${p.about.text}${p.about.trust === "suggested" ? ` (${T.prototypeUnconfirmed})` : ""}`
          : T.prototypeNoAbout}
      </span>
      {p.problem && (
        <div className="state" role="status">
          {p.problem}
        </div>
      )}
      {p.comparison && (
        <>
          <span className="hud">{T.prototypeCounts(p.comparison.counts)}</span>
          {GROUPS.map((g) => {
            const calls = p.comparison!.calls.filter((c) => c.group === g);
            return (
              <section
                key={g}
                className="stack"
                style={{ gap: 4 }}
                aria-label={T.prototypeGroup[g]}
              >
                <h4 className="hud" style={{ margin: 0 }}>
                  {T.prototypeGroupCount(T.prototypeGroup[g], calls.length)}
                </h4>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {T.prototypeGroupHelp[g]}
                </span>
                {calls.length ? (
                  <ul
                    className="stack"
                    style={{ gap: 6, listStyle: "none", margin: 0, padding: 0 }}
                  >
                    {calls.map((c) => (
                      <Call key={c.id} c={c} />
                    ))}
                  </ul>
                ) : (
                  <span className="muted">{T.prototypeNoCalls}</span>
                )}
              </section>
            );
          })}
          {p.comparison.left.length > 0 && (
            <span className="muted">{T.prototypeLeft(p.comparison.left.length)}</span>
          )}
        </>
      )}
    </article>
  );
}

/**
 * Round 36 (UX review): Compare a prototype from the app. The repos the manifest types prototype
 * to pick from; Compare runs what `atticus change attach <change> --prototype <repo>` runs
 * (POST /api/changes/{id}/prototypes), a write to the change's own files, and says what it
 * printed or why it refused.
 */
export function ComparePrototype(p: { change: string; candidates: string[]; onDone: () => void }) {
  const [picked, setPicked] = useState("");
  const act = useAction();
  const id = useId();
  if (!p.candidates.length)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.prototypeNoCandidates}
      </p>
    );
  const repo = picked && p.candidates.includes(picked) ? picked : p.candidates[0]!;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <label htmlFor={`${id}-repo`} className="hud">
            {T.prototypePick}
          </label>
          <select
            id={`${id}-repo`}
            className="field"
            value={repo}
            disabled={act.busy}
            onChange={(e) => setPicked(e.target.value)}
          >
            {p.candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          aria-describedby={`${id}-help`}
          onClick={() =>
            void act.run(
              async () => {
                const r = await api<Api.ComparePrototypeViewT>(
                  `/api/changes/${encodeURIComponent(p.change)}/prototypes`,
                  { method: "POST", body: { repo } },
                );
                p.onDone();
                return r;
              },
              (r) => r.lines.join("\n") || T.prototypeCompared(repo),
            )
          }
        >
          {act.busy ? T.prototypeComparing : T.prototypeCompare}
        </button>
      </div>
      <span id={`${id}-help`} className="muted" style={{ fontSize: 12 }}>
        {T.prototypeCompareHelp}
      </span>
      <Note note={act.note} />
    </div>
  );
}

/**
 * ADR 0133: the prototypes attached to a change (atticus change attach <change> --prototype
 * <repo>), each compared again with the estate as it is now: every call its UI makes to its BFF
 * and its BFF makes to a mock, as exists, changes, new or only a vendor, each cited. Round 36:
 * Compare attaches one from here.
 */
export function ChangePrototypes({ change }: { change: string }) {
  const list = useApi<Api.ChangePrototypeListT>(`/api/changes/${change}/prototypes`);
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  return (
    <Panel
      title={T.prototypes}
      span="span 4"
      meta={list.state === "ready" ? list.data.prototypes.length : undefined}
    >
      <View of={list}>
        {(d) => (
          <div className="stack" style={{ gap: 14 }}>
            <ComparePrototype
              change={change}
              candidates={d.candidates ?? []}
              onDone={list.reload}
            />
            {d.prototypes.length === 0 ? (
              <div className="state">{T.noPrototypes(change)}</div>
            ) : (
              d.prototypes.map((p) => <PrototypeComparison key={p.repo} p={p} />)
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}
