/**
 * The stack helpers (plan item G4): code that knows one stack or framework and helps the read,
 * none of which the read needs. The assistant reads the code and cites every fact (ADR 0124);
 * each helper only saves it work or cross-checks it, and each can be switched off:
 *
 * - `framework-models`: the frameworks taught in `org-pack/frameworks/` (ADR 0054, `atticus
 *   frameworks learn`), given to the reader as what a house annotation or client means, and
 *   `atticus verify`'s offer to learn a house framework. Off, the reader gets no model: it reads
 *   the house layer as ordinary code, cites the wrapper's call line with the path built in
 *   `cite.with`, and writes a question naming an annotation it can't place, as FACT_RULES say.
 * - `gateway-walk`: the join through gateway routes to the service behind them (ADR 0124
 *   addenda A-gateway, A-gateway2). Off, a call that lands on a gateway route is joined to that
 *   route, the gateway's repo; the route's forwarding call is joined on its own, so the caller's
 *   link stops one hop short.
 * - `readers`: the built-in readers and dialects of a scan (the cross-check of ADR 0124 §3) and
 *   the OpenAPI reader behind `atticus verify --skipped`'s uncovered spec operations (R1). Off, a
 *   repo with verified facts is projected from them alone, a repo with none gives no records,
 *   and verify lists no uncovered operations.
 * - `derived-names`: the verifier's per-framework naming rules (`verify/src/derived.ts`: an
 *   ORM's table for an entity, Rails' routes, Spring Data REST's paths). Off, a claim must be
 *   written on its cited line or a `cite.with` part, so a reader cites the `@Table` or
 *   `table_name` line, or the route line, rather than the entity's class.
 *
 * Switched off for one run with `ATTICUS_HELPERS_OFF` (a comma list of the names, or `all`);
 * the pure functions take an option of their own.
 */
export const STACK_HELPERS = [
  "framework-models",
  "gateway-walk",
  "readers",
  "derived-names",
] as const;
export type StackHelper = (typeof STACK_HELPERS)[number];

/** The helpers switched off: `ATTICUS_HELPERS_OFF=all` or `gateway-walk,readers`. Unknown names are ignored. */
export function stackHelpersOff(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Set<StackHelper> {
  const raw = (env.ATTICUS_HELPERS_OFF ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (raw.includes("all")) return new Set(STACK_HELPERS);
  return new Set(STACK_HELPERS.filter((h) => raw.includes(h)));
}

/** Whether a helper is on for this run. */
export const helperOn = (h: StackHelper, env?: Readonly<Record<string, string | undefined>>) =>
  !stackHelpersOff(env).has(h);
