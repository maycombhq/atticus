import {
  impact,
  mapIdOf,
  openIndex,
  QueryError,
  receiversOfAll,
  runContextTool,
  askLookup,
  mapFault,
  severalNamed,
  translate,
  type Affected,
  type CatalogIndex,
} from "@maycombhq/index";
import type { Output } from "./commands.js";
import { mapSides, NO_OWNER } from "./map-lacks.js";
import { table } from "./table.js";

export { table };

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
  const sides = await mapSides(root);
  const asked = await withIndex(root, io, (ix) => {
    return translate(
      question,
      askLookup(ix),
      () => mapFault(ix, root),
      (id) => sides.lacks(id, ix),
    );
  });
  // The question names something the map lacks, and the map couldn't be read: an error that
  // says what is wrong, never an empty answer read as "planned or not read".
  if (asked.action === "query" && asked.fault) {
    io.err(asked.fault);
    return 1;
  }
  const answer = async (to: Output) =>
    // ADR 0207: "who owns it" answers what atticus owners answers, so the two can't differ.
    asked.action === "owner"
      ? (await import("./owners.js")).ownersCommand(root, asked.id, { json: o.json === true }, to)
      : asked.action === "impact"
        ? impactCommand(
            root,
            asked.id,
            {
              json: o.json === true,
              ...(asked.receivers ? { receivers: true } : {}),
              // Beta.30: a topic with one Endpoint per consumer is received at every one of them.
              ...(asked.also?.length ? { also: asked.also, label: asked.named ?? asked.id } : {}),
            },
            to,
          )
        : queryCommand(root, asked.query, { json: o.json === true }, to);
  if (!o.json) {
    io.out(asked.explanation);
    io.out(`Query: ${asked.query}`);
    io.out("");
    return answer(io);
  }
  // ADR 0201: one object, how the question was read beside the answer's own keys, so a tool
  // (which asks with --json) keeps the "Read as" line.
  const out: string[] = [];
  const code = await answer({ out: (l) => out.push(l), err: io.err });
  let body: unknown;
  try {
    body = JSON.parse(out.join("\n"));
  } catch {
    for (const l of out) io.out(l);
    return code;
  }
  io.out(
    JSON.stringify(
      { readAs: asked.explanation, query: asked.query, ...(body as Record<string, unknown>) },
      null,
      2,
    ),
  );
  return code;
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

/**
 * atticus query "<words>" --search: full-text search over everything the index holds (ADR
 * 0107): catalog records, knowledge items, flows and their steps, changes, answered questions
 * and wiki sections; names and ids rank above prose. Each hit names the file it was read from.
 */
export async function searchCommand(
  root: string,
  text: string,
  o: { json?: boolean; limit?: number; kind?: string; by?: string },
  io: Output,
): Promise<number> {
  // ADR 0116: by meaning too, through the search tool (it fuses the words and the meaning).
  if (o.by && o.by !== "words") {
    if (o.by !== "meaning" && o.by !== "both") {
      io.err("--by is words, meaning or both.");
      return 2;
    }
    // A person asked for meaning: every node is embedded first (a step embeds at most 500 an open).
    const ix = await openIndex(root, { embedOnOpen: Number.MAX_SAFE_INTEGER });
    try {
      const kinds = o.kind
        ?.split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      io.out(
        await runContextTool(ix, root, "search", {
          text,
          by: o.by,
          limit: Math.min(o.limit ?? 20, 20),
          ...(kinds?.length ? { kinds } : {}),
        }),
      );
      return 0;
    } finally {
      ix.close();
    }
  }
  return withIndex(root, io, (ix) => {
    const kinds = o.kind
      ? o.kind
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean)
      : undefined;
    const hits = ix.search(text, { limit: o.limit ?? 20, ...(kinds ? { kinds } : {}) });
    if (o.json) {
      io.out(JSON.stringify({ total: hits.length, hits }, null, 2));
      return 0;
    }
    if (hits.length > 0)
      for (const l of table(
        ["KIND", "ID", "NAME", "FILE"],
        hits.map((h) => [h.kind, h.id, h.name.slice(0, 60), h.file]),
      ))
        io.out(l);
    io.out(
      hits.length
        ? `${hits.length} hit${hits.length === 1 ? "" : "s"}, best first`
        : "Nothing in the index matches those words.",
    );
    return 0;
  });
}

/** The rows of an impact table: who owns each record, or that nobody is on record for it. */
const impactRows = (affected: Affected[]) =>
  table(
    ["KIND", "ID", "OWNER", "WHY"],
    affected.map((a) => [a.kind, a.id, a.owner ?? NO_OWNER, a.reason]),
  );

/**
 * atticus impact <id>: what a change to the record reaches. Exit 1 when the id isn't in the
 * catalog. A name exactly one entry or topic has stands for that record, said first (ADR 0201
 * addendum, 2026-11-19). `receivers` is `ask`'s "who receives it": the receivers first, and what
 * the walk reaches past them apart.
 */
export async function impactCommand(
  root: string,
  id: string,
  o: {
    json?: boolean;
    depth?: number;
    receivers?: boolean;
    /** With `receivers`: more roots (a topic's other consumers' Endpoints), and its name. */
    also?: string[];
    label?: string;
  },
  io: Output,
): Promise<number> {
  const sides = await mapSides(root);
  return withIndex(root, io, (ix) => {
    // The one lookup show and walk make (mapIdOf): the id, or the record whose name it is.
    const found = mapIdOf(ix, id, "records");
    if (!found || "several" in found) {
      // "Not in the map" only when the map was read whole and has no such id (ADR 0201).
      const fault = mapFault(ix, root);
      io.err(fault ?? (found ? severalNamed(id, found.several) : sides.lacks(id, ix)));
      return 1;
    }
    const rootId = found.id;
    const named = rootId === id ? {} : { named: id };
    const said = (to: Output) => {
      for (const l of found.said) to.out(l);
    };
    const owners = { owner: sides.owner };
    if (o.receivers) {
      const r = receiversOfAll(ix, [rootId, ...(o.also ?? [])], o.depth ?? 4, owners);
      const label = o.also?.length ? (o.label ?? rootId) : rootId;
      if (o.json) {
        io.out(JSON.stringify({ ...named, ...r }, null, 2));
        return 0;
      }
      said(io);
      io.out(
        r.receivers.length
          ? `${label} is received by ${r.receivers.length} component${r.receivers.length === 1 ? "" : "s"}:`
          : `Nothing in the map receives ${label}.`,
      );
      for (const l of r.receivers.length ? impactRows(r.receivers) : []) io.out(`  ${l}`);
      if (r.further.length) {
        io.out(
          `Further, through a receiver (${r.further.length} record${r.further.length === 1 ? "" : "s"} that ${r.further.length === 1 ? "doesn't" : "don't"} receive ${label}):`,
        );
        for (const l of impactRows(r.further)) io.out(`  ${l}`);
      }
      return 0;
    }
    const r = impact(ix, rootId, o.depth ?? 4, owners)!;
    if (o.json) {
      io.out(JSON.stringify({ ...named, ...r }, null, 2));
      return 0;
    }
    said(io);
    io.out(
      `Changing ${rootId} reaches ${r.affected.length} record${r.affected.length === 1 ? "" : "s"}:`,
    );
    if (r.affected.length > 0) for (const l of impactRows(r.affected)) io.out(`  ${l}`);
    if (r.gaps.length > 0) {
      io.out("Open questions:");
      for (const g of r.gaps) io.out(`  - ${g.question} (${g.record})`);
    }
    return 0;
  });
}

/**
 * atticus index embed (ADR 0116): give every node its vector from the local embedding model, so
 * "similar in meaning" can rank. A first build of a big estate takes minutes; after that only
 * changed texts are embedded (a step does those as it opens the index).
 */
export async function indexEmbed(root: string, io: Output): Promise<number> {
  const ix = await openIndex(root, { embedOnOpen: 0 });
  try {
    const before = ix.meaning();
    if (!ix.embedder) {
      io.err(`${before.note}. Set retrieval.embeddings.model in the org pack's runtime.yaml.`);
      return 1;
    }
    let last = Date.now();
    const n = await ix.embed({
      progress: (done, of) => {
        if (Date.now() - last > 5000 || done === of) {
          io.out(`Embedded ${done} of ${of}`);
          last = Date.now();
        }
      },
    });
    const after = ix.meaning();
    io.out(`${n ? `Embedded ${n} new text${n === 1 ? "" : "s"}. ` : ""}${after.note}.`);
    return after.on ? 0 : 1;
  } catch (e) {
    io.err(`The embedding model couldn't run: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  } finally {
    ix.close();
  }
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
