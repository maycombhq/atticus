import type { WorkTracker } from "@maycombhq/adapters";
import type { CatalogRecord } from "@maycombhq/core";
import { boundedId, opt, type TriageItem } from "@maycombhq/intake";
import { featureLinkDecision } from "./decisions.js";
import type { Capability } from "./detect.js";
import { FlowGraph } from "./graph.js";
import { splitWords, tokens } from "./words.js";

/**
 * Links to work items (ADR 0031): Atticus suggests which epic, feature or story built a
 * feature, from the words they share (name, id and tags against title and tags) and from the
 * repos and paths the item's linked pull requests touched. Work items come from the work
 * tracker adapter (read only) or, when it's manual or unreachable, from exports in inputs/
 * (ADR 0032). Each suggestion is a triage item whose options are curated-decision drafts:
 * link (an assert of externalRefs) or dismiss. Nothing is written to the tracker.
 */

export interface WorkItemLike {
  system?: "ado" | "jira";
  id: string;
  type: string;
  title: string;
  tags?: string[];
  url?: string;
  pullRequests?: { id?: string; repo?: string; paths: string[] }[];
  source?: { path: string; line?: number };
}

export interface SuggestLinksInput {
  features: readonly Capability[];
  items: readonly WorkItemLike[];
  records: readonly CatalogRecord[];
  /** Decisions already made (catalog/curated): answered suggestions are left out. */
  decisions?: readonly CatalogRecord[];
  /** Lowest score that becomes a suggestion. Default 0.5. */
  minScore?: number;
}

/** Item types a feature can be linked to: what was planned, not tasks or bugs. */
const LINKABLE = new Set(["epic", "feature", "story"]);

/** Words in work-item titles that say nothing about what was built. */
const STOP = new Set([
  "as",
  "a",
  "an",
  "i",
  "we",
  "can",
  "see",
  "my",
  "our",
  "the",
  "to",
  "of",
  "and",
  "or",
  "for",
  "in",
  "on",
  "with",
  "be",
  "is",
  "are",
  "so",
  "that",
  "want",
  "when",
  "then",
  "it",
  "between",
  "from",
  "into",
  "new",
]);

const words = (text: string) => tokens(splitWords(text).filter((w) => !STOP.has(w)));
const quote = (s: string[]) => s.map((w) => `"${w}"`).join(", ");
const SYSTEM_LABEL: Record<string, string> = { ado: "ADO", jira: "Jira" };

/** Epics, features and stories from the work tracker (read only). */
export async function workItemsFromTracker(
  tracker: Pick<WorkTracker, "query">,
): Promise<WorkItemLike[]> {
  const out: WorkItemLike[] = [];
  for (const type of ["epic", "feature", "story"] as const)
    for (const i of await tracker.query({ type }))
      out.push({
        system: "ado",
        id: i.id,
        type: i.type,
        title: i.title,
        tags: i.tags,
        url: i.url,
      });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function suggestFeatureLinks(input: SuggestLinksInput): TriageItem[] {
  const g = new FlowGraph(input.records);
  const min = input.minScore ?? 0.5;
  const decisions = (input.decisions ?? []).filter(
    (d) => d.kind === "CuratedDecision" && d.status === "current",
  );
  const decided = new Set(decisions.map((d) => d.id));

  const out: TriageItem[] = [];
  for (const f of [...input.features].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const name = words(`${f.name} ${f.id.replace(/^feature\./, "")} ${f.tags.join(" ")}`);
    const repos = new Set(
      f.records.map((id) => g.components.get(id)?.repo).filter((r): r is string => !!r),
    );
    const paths = new Set(
      f.records.flatMap((id) =>
        (g.records.get(id)?.evidence ?? [])
          .filter((e) => e.path)
          .map((e) => `${e.repo ?? ""}|${e.path}`),
      ),
    );
    for (const item of input.items) {
      if (!LINKABLE.has(item.type)) continue;
      const system = item.system ?? "ado";
      if (f.externalRefs.some((r) => r.system === system && r.id === item.id)) continue;
      const theirs = words(`${item.title} ${(item.tags ?? []).join(" ")}`);
      const shared = [...name].filter((w) => theirs.has(w)).sort();
      const prs = item.pullRequests ?? [];
      const repoHits = [
        ...new Set(prs.map((p) => p.repo).filter((r): r is string => !!r && repos.has(r))),
      ].sort();
      const pathHits = [
        ...new Set(
          prs.flatMap((p) =>
            p.paths.filter((path) =>
              [...paths].some((x) => {
                const [repo, file] = x.split("|") as [string, string];
                return (
                  (!p.repo || !repo || p.repo === repo) &&
                  (file === path || file.endsWith(`/${path}`))
                );
              }),
            ),
          ),
        ),
      ].sort();
      const score =
        (name.size ? shared.length / name.size : 0) +
        (repoHits.length ? 0.25 : 0) +
        (pathHits.length ? 0.5 : 0);
      if (score < min) continue;

      const what = `${SYSTEM_LABEL[system] ?? system} ${item.type} ${item.id}`;
      const ref = {
        system,
        id: item.id,
        title: item.title,
        ...(item.url ? { url: item.url } : {}),
      } as const;
      const label = `Link ${what} to ${f.name}`;
      const link = featureLinkDecision(f, ref, { by: "triage", at: "1970-01-01T00:00:00Z" });
      const itemId = boundedId(
        "feature-link.",
        `${f.id.replace(/^feature\./, "")}.${system}-${item.id}`,
      );
      const dismiss = opt.dismiss(itemId, f.id, "Not this feature");
      if (decided.has(link.id) || decided.has(dismiss.decision.id)) continue;
      const why: string[] = [];
      if (shared.length) why.push(`it shares ${quote(shared)}`);
      if (repoHits.length)
        why.push(
          `its pull requests touched ${repoHits.join(", ")}${pathHits.length ? ` (${pathHits.join(", ")})` : ""}`,
        );
      else if (pathHits.length) why.push(`its pull requests touched ${pathHits.join(", ")}`);
      out.push({
        id: itemId,
        kind: "feature-link",
        summary: `${what} "${item.title}" may be what built ${f.name} (${f.id}): ${why.join("; ")}.`,
        source: item.source ?? { path: item.url ?? `${system}:${item.id}` },
        records: [f.id],
        options: [
          {
            action: "assert",
            label,
            decision: {
              id: link.id,
              target: f.id,
              action: "assert",
              value: link.value,
              reason: label,
            },
          },
          dismiss,
        ],
      });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
