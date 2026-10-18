import { loadChangeContext } from "./context.js";
import { changeFootprint, type Footprint } from "./footprint.js";
import { changeStore } from "./store.js";

export interface ChangeConflict {
  /** The two change ids, in id order. */
  changes: [string, string];
  overlap: {
    systems: string[];
    interfaces: string[];
    dataStores: string[];
    tables: string[];
    records: string[];
    repos: string[];
  };
}

const both = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

/**
 * Open changes (anything not archived) that touch the same catalog records (systems,
 * interfaces, data stores, tables, other records) or the same repos, as pairs with the ids
 * they share. Deterministic: catalog and change files only.
 */
export async function detectConflicts(root: string): Promise<ChangeConflict[]> {
  const ctx = await loadChangeContext(root);
  const open = (await changeStore(root).list()).filter((c) => c.state !== "archived");
  const prints: [string, Footprint][] = [];
  for (const c of open) prints.push([c.id, await changeFootprint(ctx, c)]);
  const out: ChangeConflict[] = [];
  for (let i = 0; i < prints.length; i++) {
    for (let j = i + 1; j < prints.length; j++) {
      const [ia, a] = prints[i]!;
      const [ib, b] = prints[j]!;
      const overlap = {
        systems: both(a.systems, b.systems),
        interfaces: both(
          a.interfaces.map((x) => x.id),
          b.interfaces.map((x) => x.id),
        ),
        dataStores: both(a.dataStores, b.dataStores),
        tables: both(a.tables, b.tables),
        records: both(a.records, b.records),
        repos: both(a.repos, b.repos),
      };
      if (Object.values(overlap).some((v) => v.length > 0))
        out.push({ changes: [ia, ib], overlap });
    }
  }
  return out;
}
