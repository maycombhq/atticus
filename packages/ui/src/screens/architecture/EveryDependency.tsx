import type { ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, type Loaded } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { JoinView } from "./WhyLinked.js";

/**
 * Beta.25 (ADR 0192 addendum): a `depends-on` arrow merged from more dependencies than its view
 * lists (a view keeps 20 joins an edge): the rest, read whole from GET /api/graph/edge-calls
 * (C4 3.11.0), each with what goes under it (This link is wrong), as an arrow's calls are read
 * for All calls on this arrow are wrong. From its state, so tests can render each one.
 */
export function EveryDependencyView(p: {
  link: Api.HierEdgeT;
  every: Loaded<Api.GraphEdgeCallsViewT>;
  under?: (join: Api.HierJoinT) => ReactNode;
}) {
  const D = COPY.why.dependency;
  if (p.every.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {D.moreLoading}
      </p>
    );
  if (p.every.state === "error")
    return (
      <p role="alert" className="state error">
        {D.moreFailed(p.every.error)}
      </p>
    );
  const shown = new Set((p.link.joins ?? []).map((j) => j.interface));
  const rest = p.every.data.joins.filter((j) => !shown.has(j.interface));
  if (!rest.length) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rest.map((j) => (
        <JoinView key={j.interface} join={j}>
          {p.under?.(j)}
        </JoinView>
      ))}
    </div>
  );
}

/** The rest of a `depends-on` arrow's dependencies, when its view lists only some of them. */
export function EveryDependency(p: {
  link: Api.HierEdgeT;
  /** GET /api/graph/edge-calls for this edge of its view. */
  path: string;
  under?: (join: Api.HierJoinT) => ReactNode;
}) {
  const every = useApi<Api.GraphEdgeCallsViewT>(p.path);
  return (
    <EveryDependencyView link={p.link} every={every} {...(p.under ? { under: p.under } : {})} />
  );
}
