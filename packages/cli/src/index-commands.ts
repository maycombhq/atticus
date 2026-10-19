import { impact, openIndex, QueryError, translate, type CatalogIndex } from "@maycombhq/index";
import type { Output } from "./commands.js";

/** Lay rows out in columns, with a header. */
export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

async function withIndex<T>(
  root: string,
  io: Output,
  fn: (ix: CatalogIndex) => T,
  rebuild = false,
): Promise<T> {
  const ix = await openIndex(root, { rebuild });
  try {
    for (const p of ix.problems) io.err(`${p.file}: ${p.message} (left out of the index)`);
    return fn(ix);
  } finally {
    ix.close();
  }
}

/** atticus query "<query>": records matching the catalog query language. Exit 2 for a bad query. */
/** atticus ask "<question>": the question read as a query or an impact walk, shown, then run. */
export async function askCommand(
  root: string,
  question: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const asked = await withIndex(root, io, (ix) => {
    const lookup = (w: string) => {
      const r = ix.find(w)[0];
      return r ? { id: r.id, kind: r.kind } : undefined;
    };
    return translate(question, lookup);
  });
  if (!o.json) {
    io.out(asked.explanation);
    io.out(`Query: ${asked.query}`);
    io.out("");
  }
  if (asked.action === "impact")
    return impactCommand(root, asked.id, { json: o.json === true }, io);
  return queryCommand(root, asked.query, { json: o.json === true }, io);
}

export async function queryCommand(
  root: string,
  q: string,
  o: { json?: boolean; limit?: number },
  io: Output,
): Promise<number> {
  return withIndex(root, io, (ix) => {
    let res;
    try {
      res = ix.query(q, { limit: o.limit ?? 100 });
    } catch (e) {
      if (e instanceof QueryError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
    if (o.json) {
      io.out(JSON.stringify({ total: res.total, records: ix.records(res.rows) }, null, 2));
      return 0;
    }
    if (res.rows.length > 0)
      for (const l of table(
        ["KIND", "ID", "NAME", "STATUS", "CONFIDENCE", "SYSTEM"],
        res.rows.map((r) => [r.kind, r.id, r.name, r.status, r.confidence, r.system ?? ""]),
      ))
        io.out(l);
    io.out(
      res.rows.length < res.total
        ? `${res.rows.length} of ${res.total} records (use --limit to see more)`
        : `${res.total} record${res.total === 1 ? "" : "s"}`,
    );
    return 0;
  });
}

/** atticus impact <id>: what a change to the record reaches. Exit 1 when the id isn't in the catalog. */
export async function impactCommand(
  root: string,
  id: string,
  o: { json?: boolean; depth?: number },
  io: Output,
): Promise<number> {
  return withIndex(root, io, (ix) => {
    const r = impact(ix, id, o.depth ?? 4);
    if (!r) {
      io.err(`No record with id "${id}" in the catalog. Try: atticus query ${id}`);
      return 1;
    }
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(
      `Changing ${id} reaches ${r.affected.length} record${r.affected.length === 1 ? "" : "s"}:`,
    );
    if (r.affected.length > 0)
      for (const l of table(
        ["KIND", "ID", "OWNER", "WHY"],
        r.affected.map((a) => [a.kind, a.id, a.owner ?? "", a.reason]),
      ))
        io.out(`  ${l}`);
    if (r.gaps.length > 0) {
      io.out("Open questions:");
      for (const g of r.gaps) io.out(`  - ${g.question} (${g.record})`);
    }
    return 0;
  });
}

/** atticus index rebuild: build the index from the catalog files now. */
export async function indexRebuild(root: string, io: Output): Promise<number> {
  return withIndex(
    root,
    io,
    (ix) => {
      const kinds = ix.kinds();
      const total = kinds.reduce((n, k) => n + k.count, 0);
      io.out(`Indexed ${total} records of ${kinds.length} kinds into ${ix.file}`);
      return ix.problems.length > 0 ? 1 : 0;
    },
    true,
  );
}
