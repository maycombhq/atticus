import type { CatalogSystem, Guard, Outcome } from "./seam.js";

/**
 * Systems that are wrong on purpose, for the harness's own test: the oracle must fail each of
 * them, or it is not an oracle. They do nothing real, so they cost the harness's time only.
 */

const all = (o: () => Outcome, name: string): CatalogSystem => ({
  name,
  scan: async () => o(),
  verify: async () => o(),
  rename: async () => o(),
  build: async () => o(),
  curateEdits: async () => o(),
  undo: async () => o(),
  prune: async () => o(),
  upgrade: async () => o(),
  freshBuild: async () => undefined,
});

/** Refuses every command, by `guard`, listing what such a refusal lists. */
export const alwaysRefuses = (guard: Guard): CatalogSystem =>
  all(
    () => ({
      wrote: false,
      refused: true,
      guard,
      ...(guard === "large-removals"
        ? { removals: { count: 1, ids: ["Endpoint/ledger-api.get-account"] } }
        : {}),
      ...(guard === "hand-edits" ? { edits: [] } : {}),
      code: 1,
      out: [],
      err: [`refused (${guard})`],
    }),
    `refuses everything (${guard})`,
  );

/** Says every command succeeded and writes nothing: an empty build, every time. */
export const writesNothing: CatalogSystem = all(
  () => ({ wrote: true, refused: false, removed: [], pruned: [], code: 0, out: [], err: [] }),
  "writes nothing",
);
