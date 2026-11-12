import { useId } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { COPY } from "../../copy.js";

/**
 * Beta.27 review: a change whose change.yaml doesn't read used to vanish (All changes listed
 * nothing, its pages said 404, Problems said nothing). It is listed as broken, with the file, the
 * line and why, wherever changes are listed.
 */

const B = COPY.brokenChanges;

export const CHANGE_PROBLEMS_URL = "/api/change-problems";

export type ChangeProblem = Api.ChangeProblemsT[number];

/** Where a broken change's file is, with its line when YAML names one. */
export const brokenWhere = (p: ChangeProblem): string =>
  p.line ? B.fileLine(p.file, p.line) : p.file;

/** The list, from loaded data: nothing while it loads, fails or is empty (the page says those). */
export function BrokenChangesView({ of }: { of: Loaded<Api.ChangeProblemsT> }) {
  // Review of the fix: a labelled region the page lists (an alert interrupted every load), with
  // its own id, so two on a page never share one.
  const id = useId();
  if (of.state !== "ready" || of.data.length === 0) return null;
  return (
    <section className="cw-broken" aria-labelledby={id}>
      <h3 id={id} className="hud">
        {B.title(of.data.length)}
      </h3>
      <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
        {of.data.map((p) => (
          <li key={p.id}>
            <strong>{p.id}</strong> <span className="muted">{brokenWhere(p)}</span>
            <div style={{ overflowWrap: "anywhere" }}>{p.message}</div>
          </li>
        ))}
      </ul>
      <p className="work-say" style={{ margin: 0 }}>
        {B.fix}
      </p>
    </section>
  );
}

/** The changes whose change.yaml doesn't read, read and kept up to date. */
export function BrokenChanges() {
  const of = useApi<Api.ChangeProblemsT>(CHANGE_PROBLEMS_URL);
  useReloadOnFiles(of);
  return <BrokenChangesView of={of} />;
}
