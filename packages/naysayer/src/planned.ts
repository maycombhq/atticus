import { parse } from "yaml";
import type { ChangeFiles } from "./artifacts.js";

/**
 * ADR 0189: the components the change itself plans that the catalog doesn't have yet (or that
 * it retires), read off its own files: the target flows the architecture stage and the canvas
 * write (a new flow's component, a call's target marked new, a retired component's flows), and
 * the proposal's Systems table rows marked new. The critic calls such an end "planned in this
 * change" instead of "not in the catalog": the architect draws the future before the repos exist.
 * Nothing here is a fact; the catalog changes when the code lands and is read.
 */
export function plannedInChange(
  files: ChangeFiles,
  known: (id: string) => boolean,
): Map<string, "new" | "retire"> {
  const out = new Map<string, "new" | "retire">();
  const isId = (s: unknown): s is string =>
    typeof s === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(s);
  for (const doc of files.flows ?? []) {
    let d: unknown;
    try {
      d = parse(doc.raw);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    const x = d as {
      change?: unknown;
      why?: unknown;
      runsOn?: { component?: unknown };
      steps?: { op?: unknown; to?: { component?: unknown; new?: unknown } }[];
    };
    const c = x.runsOn?.component;
    if (x.change === "new" && isId(c) && !known(c)) out.set(c, "new");
    for (const s of Array.isArray(x.steps) ? x.steps : []) {
      const to = s?.to?.component;
      if (s?.op !== "remove" && s?.to?.new === true && isId(to) && !known(to) && !out.has(to))
        out.set(to, "new");
    }
    const retired = typeof x.why === "string" ? /^Retires (\S+?):/.exec(x.why)?.[1] : undefined;
    if (x.change === "remove" && isId(retired)) out.set(retired, "retire");
  }
  const proposal = files.docs.get("proposal.md")?.raw ?? "";
  for (const m of proposal.matchAll(/^\|\s*`?([a-z0-9][\w.-]*)`?\s*\|\s*new\b/gim))
    if (!known(m[1]!) && !out.has(m[1]!)) out.set(m[1]!, "new");
  return out;
}

/** The planned components as data for a lens: what the change plans that isn't built yet. */
export function plannedText(planned: Map<string, "new" | "retire">): string {
  return [
    "Components this change plans, from its own target flows and proposal. They are planned in this change, not missing from the catalog: the catalog has them once their code lands and is read.",
    ...[...planned]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([id, a]) => `- ${id}: ${a === "new" ? "new in this change" : "retired by this change"}`,
      ),
  ].join("\n");
}
