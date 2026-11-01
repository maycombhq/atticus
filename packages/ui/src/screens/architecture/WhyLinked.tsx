import type { ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { Citation } from "../../app/evidence.js";
import { COPY } from "../../copy.js";

/**
 * Why is this linked (ADR 0135, C1): each call merged into a link on the estate canvas, how
 * Atticus joined it to what it calls (a person's answer, a named target, the host, a path guess,
 * through a gateway), whether it is verified or inferred, and the cited line at both ends, each a
 * citation with Correct this. Read from the link's `joins` (GET /api/graph/node, C4 2.32.0).
 */

const W = COPY.why;

function Lines({ title, list }: { title: string; list: readonly Api.HierEvidenceT[] }) {
  return (
    <>
      <dt className="hud">{title}</dt>
      <dd style={{ margin: 0 }}>
        {list.length ? (
          <ul className="ev-list">
            {list.map((e) => (
              <li key={`${e.repo ?? ""}:${e.at}`}>
                {e.repo && <span className="mono">{e.repo}: </span>}
                <Citation repo={e.repo} at={e.at} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="ev-say">{W.noLine}</span>
        )}
      </dd>
    </>
  );
}

/** One call on the link: how it was joined, verified or inferred, and its lines. */
export function JoinView({ join, children }: { join: Api.HierJoinT; children?: ReactNode }) {
  const what = [join.method, join.path].filter(Boolean).join(" ");
  return (
    <article className="stack" style={{ gap: 4 }} aria-label={W.call(join.from, join.to, what)}>
      <p style={{ margin: 0 }}>
        <code className="mono">{W.call(join.from, join.to, what)}</code>{" "}
        <span className={`chip ${join.verified ? "done" : "warn"}`}>
          {join.verified ? W.verified : W.inferred}
        </span>
      </p>
      <p className="ev-say" style={{ margin: 0 }}>
        {W.how[join.how] ?? W.how.unknown}
        {join.gateway && ` ${W.gateway}`}
      </p>
      <dl className="stack" style={{ gap: 2, margin: 0 }}>
        <Lines title={W.caller} list={join.caller} />
        {join.hops.length > 0 && <Lines title={W.hops} list={join.hops} />}
        <Lines title={W.callee} list={join.callee} />
        {join.other.length > 0 && <Lines title={W.other} list={join.other} />}
      </dl>
      {children}
    </article>
  );
}

/** Why a link is there: every call on it, or, for a link that isn't a call, that there is none. */
export function WhyLinked(p: {
  link: Api.HierEdgeT;
  /** What to show under each call (This link is wrong, C2). */
  under?: (join: Api.HierJoinT) => ReactNode;
}) {
  const joins = p.link.joins ?? [];
  if (!joins.length) return <p className="ev-say">{W.none}</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {W.intro}
      </p>
      {joins.map((j) => (
        <JoinView key={j.interface} join={j}>
          {p.under?.(j)}
        </JoinView>
      ))}
      {p.link.count > joins.length && (
        <p className="ev-say">{W.more(p.link.count - joins.length)}</p>
      )}
    </div>
  );
}
