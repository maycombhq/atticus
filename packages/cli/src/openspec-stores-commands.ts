import { openspecStores, type OpenSpecStore } from "@maycombhq/changes";
import { table } from "./index-commands.js";

/**
 * What the CLI shows of the OpenSpec stores org-pack/openspec.yaml names (beta, ADR 0126): read
 * only, each line labelled with the store, never mixed with the metarepo's own changes.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function noteLines(stores: OpenSpecStore[], problems: string[]): string[] {
  return [
    ...problems,
    ...stores.flatMap((s) => s.notes.map((n) => `OpenSpec store ${s.label}: ${n}`)),
  ];
}

/** The stores' open changes, as `atticus change list` shows them after the metarepo's. */
export async function storeChangeRows(root: string): Promise<{
  json: { id: string; title?: string; store: string; readOnly: true; tasks?: object }[];
  lines: string[];
  err: string[];
}> {
  const { stores, problems } = await openspecStores(root);
  const rows = stores.flatMap((s) => s.changes.map((c) => ({ s, c })));
  return {
    json: rows.map(({ s, c }) => ({
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      store: s.label,
      readOnly: true as const,
      ...(c.tasks ? { tasks: c.tasks } : {}),
    })),
    lines: rows.length
      ? [
          "From OpenSpec stores (read-only, beta):",
          ...table(
            ["STORE", "ID", "TASKS", "TITLE"],
            rows.map(({ s, c }) => [
              s.label,
              c.id,
              c.tasks ? `${c.tasks.done}/${c.tasks.total}` : "",
              c.title ?? "",
            ]),
          ),
        ]
      : [],
    err: noteLines(stores, problems),
  };
}

/** One line per store for `atticus openspec check`: its open changes and its specs. */
export async function storeSummaryLines(root: string): Promise<{ out: string[]; err: string[] }> {
  const { stores, problems } = await openspecStores(root);
  return {
    out: stores.map(
      (s) =>
        `OpenSpec store ${s.label} (read-only, beta): ${plural(s.changes.length, "open change")}, ${plural(s.specs.length, "spec")}${s.specs.length ? ` (${s.specs.map((x) => x.id).join(", ")})` : ""}`,
    ),
    err: noteLines(stores, problems),
  };
}
