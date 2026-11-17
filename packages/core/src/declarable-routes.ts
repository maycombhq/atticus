import { cmpText } from "./identity.js";
import { declaredRouteMatches, gatewayRouteFacts } from "./facts-callers.js";
import type { JoinRepo } from "./facts-join.js";

/**
 * ADR 0200: the gateway routes a person can declare a caller of, listed to pick from. A declared
 * call (the profile's `calls`, A-callers) lands only on a gateway route: an entry of a gateway
 * repo, or any repo's entry under a proxy bundle folder. An ordinary service's entry is not one,
 * and the join places no declaration on it. The routes come from the same rule the join uses
 * (`gatewayRouteFacts`), and the words offered for each are words the join places on it
 * (`declaredRouteMatches`). Pure.
 */

export interface DeclarableRoute {
  /** The route's entry fact. */
  id: string;
  method?: string;
  path: string;
  /** The handler or proxy flow that serves it, where the facts name one. */
  handler?: string;
  /** path:line of the line it was read from. */
  at: string;
  /**
   * What the declaration says to mean this route: `METHOD /path` where no other route of the
   * estate is served on those words, else its handler where that names only this one.
   */
  say: string;
  /** The system declared it already (by either way of naming it). */
  declared?: true;
  /** The other repos whose route the same words name: the declaration lands there too. */
  also?: string[];
}

export interface DeclarableRoutes {
  /** The repo has gateway routes. */
  gateway: boolean;
  routes: DeclarableRoute[];
  /** How many entries the repo has on record, routes or not. */
  entries: number;
}

interface Input {
  repos: readonly JoinRepo[];
  /** The gateway bundle folders, as given to the join (the estate's conventions). */
  bundleFolders?: readonly string[] | undefined;
}

const wordsOf = (f: { method?: string | undefined; path: string }) =>
  `${(f.method ?? "ANY").toUpperCase()} ${f.path}`;

/** The gateway routes of `repo`, by path then method, each with the words that declare it. */
export function declarableRoutes(
  input: Input & {
    repo: string;
    /** The routes the system declared already, as its profile says them. */
    declared: readonly string[];
  },
): DeclarableRoutes {
  const all = gatewayRouteFacts(input.repos, input.bundleFolders);
  const mine = all.filter((r) => r.repo === input.repo);
  const entries = (input.repos.find((r) => r.repo === input.repo)?.facts ?? []).filter(
    (f) => f.kind === "entry",
  ).length;
  const routes = mine
    .map(({ fact }): DeclarableRoute => {
      const others = (said: string) =>
        all.filter(
          (o) =>
            !(o.repo === input.repo && o.fact.id === fact.id) && declaredRouteMatches(o.fact, said),
        );
      const words = wordsOf(fact);
      const byWords = others(words);
      const say =
        byWords.length && fact.handler && !others(fact.handler).length ? fact.handler : words;
      const also = [...new Set(others(say).map((o) => o.repo))].sort(cmpText);
      return {
        id: fact.id,
        ...(fact.method ? { method: fact.method.toUpperCase() } : {}),
        path: fact.path,
        ...(fact.handler ? { handler: fact.handler } : {}),
        at: `${fact.cite.file}:${fact.cite.line}`,
        say,
        ...(input.declared.some((d) => declaredRouteMatches(fact, d))
          ? { declared: true as const }
          : {}),
        ...(also.length ? { also } : {}),
      };
    })
    .sort(
      (a, b) =>
        cmpText(a.path, b.path) || cmpText(a.method ?? "", b.method ?? "") || cmpText(a.id, b.id),
    );
  return { gateway: routes.length > 0, routes, entries };
}

/** The repos that have gateway routes, by id, with how many. */
export function declarableGateways(input: Input): { repo: string; routes: number }[] {
  const n = new Map<string, number>();
  for (const r of gatewayRouteFacts(input.repos, input.bundleFolders))
    n.set(r.repo, (n.get(r.repo) ?? 0) + 1);
  return [...n].map(([repo, routes]) => ({ repo, routes })).sort((a, b) => cmpText(a.repo, b.repo));
}
