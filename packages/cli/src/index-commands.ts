import {
  impact,
  mapIdOf,
  openIndex,
  QueryError,
  receiversOfAll,
  runContextTool,
  askLookup,
  mapFault,
  OUTSIDE,
  severalNamed,
  translate,
  type Affected,
  type CatalogIndex,
} from "@maycombhq/index";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { factsDirOf } from "@maycombhq/core";
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
  const translated = await withIndex(root, io, (ix) => {
    return translate(
      question,
      askLookup(ix),
      () => mapFault(ix, root),
      (id) => sides.lacks(id, ix),
    );
  });
  // ADR 0207: "who owns <repo>" asks of the repo the manifests list, as `owners` answers it, not
  // of its component or a word search (review of PR #6).
  const repo = /\b(?:who owns|owner of)\s+(?:the\s+)?(?:repo\s+)?`?([a-z0-9][\w.-]*[a-z0-9])/i
    .exec(question)?.[1]
    ?.toLowerCase();
  const asked: typeof translated =
    repo && sides.repo(repo)
      ? {
          action: "owner",
          id: repo,
          query: repo,
          explanation: `Read as: the owner recorded for the repo ${repo}.`,
        }
      : translated;
  // The question names something the map lacks, and the map couldn't be read: an error that
  // says what is wrong, never an empty answer read as "planned or not read".
  if (asked.action === "query" && asked.fault) {
    io.err(asked.fault);
    return 1;
  }
  const answer = (to: Output) =>
    asked.action === "owner"
      ? ownersCommand(root, asked.id, { json: o.json === true }, to)
      : asked.action === "impact"
        ? impactCommand(
            root,
            asked.id,
            {
              json: o.json === true,
              ...(asked.receivers ? { receivers: true, whole: true } : {}),
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
    /** With `receivers` and `json`: the whole walk too (affected, gaps), as ask answers. */
    whole?: boolean;
  },
  io: Output,
): Promise<number> {
  const sides = await mapSides(root);
  return withIndex(root, io, (ix) => {
    // The one lookup show and walk make (mapIdOf): the id, or the record whose name it is.
    let found = mapIdOf(ix, id, "records");
    let also = o.also;
    // ADR 0207 `consumers_of`: a topic by its name or a repo by its id, as ask reads them.
    if (o.receivers && !also && (!found || "several" in found)) {
      const hit = askLookup(ix)(id);
      const h = hit?.topic ?? hit;
      if (h && h.kind !== OUTSIDE) {
        found = { id: h.id, said: [] };
        also = h.also ?? h.ids?.slice(1);
      }
    }
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
      const r = receiversOfAll(ix, [rootId, ...(also ?? [])], o.depth ?? 4, owners);
      const label = also?.length ? (o.label ?? (o.also ? rootId : id)) : rootId;
      if (o.json) {
        // ADR 0207 `consumers_of`: the receivers and what lies past them; ask keeps the walk.
        const { root, roots, receivers, further } = r;
        const kept = { root, ...(roots ? { roots } : {}), receivers, further };
        io.out(JSON.stringify({ ...named, ...(o.whole ? r : kept) }, null, 2));
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
 * atticus owners <id> (ADR 0207): who owns a record, a repo or a system, and where it is said:
 * the System record's owner, else the manifest's or a profile's, with its file. A manifest repo
 * nobody read still has its manifest's owner. Exit 1 for an id the map and manifests lack.
 */
export async function ownersCommand(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const sides = await mapSides(root);
  return withIndex(root, io, (ix) => {
    const found = mapIdOf(ix, id, "records");
    let at: { id: string; kind: string; system?: string; read: boolean };
    if (found && "id" in found) {
      const kind = ix.find(found.id)[0]!.kind;
      const system = kind === "System" ? found.id : ix.systemOf(kind, found.id);
      at = { id: found.id, kind, ...(system ? { system } : {}), read: true };
    } else if (sides.repo(id)) {
      // Read: its facts are there, or a record of the map cites it (a repo with no component).
      const cited = ix.db
        .prepare(
          "SELECT 1 FROM evidence WHERE repo = ?1 UNION ALL SELECT 1 FROM records WHERE json_extract(json, '$.repo') = ?1 LIMIT 1",
        )
        .get(id);
      const read = cited !== undefined || existsSync(join(factsDirOf(root), `${id}.jsonl`));
      // An empty map is no fault here: a manifest repo nobody read still has its manifest's
      // owner (ADR 0207). Only a map whose records didn't read is.
      const fault = read || !ix.kinds().length ? undefined : mapFault(ix, root);
      if (fault) {
        io.err(fault);
        return 1;
      }
      const comp = ix.query(`kind:component repo:${id}`, { limit: 1 }).rows[0]?.id;
      const system = sides.repo(id)!.system ?? (comp ? ix.systemOf("Component", comp) : undefined);
      at = { id, kind: "Repo", ...(system ? { system } : {}), read };
    } else {
      io.err(mapFault(ix, root) ?? (found ? severalNamed(id, found.several) : sides.lacks(id, ix)));
      return 1;
    }
    // A repo's own manifest row is the most exact word on it (review of PR #6).
    const own = at.kind === "Repo" ? sides.repo(id)!.said : undefined;
    const sys = at.system
      ? (ix.get("System", at.system) as { owner?: string } | undefined)
      : undefined;
    const bySystem = !own && sys?.owner;
    const viaFile = bySystem ? undefined : (own ?? sides.ownerSaid(at));
    const owned = bySystem
      ? { owner: sys.owner!, from: { system: at.system! } }
      : viaFile && { owner: viaFile.owner, from: { file: viaFile.file } };
    const where = bySystem ? `the System record ${at.system}` : viaFile?.file;
    const answer = {
      ...at,
      ...(owned ?? {}),
      said:
        (owned ? `${at.id} is owned by ${owned.owner} (${where}).` : `${at.id}: ${NO_OWNER}.`) +
        (at.read ? "" : " It is not read into the map yet."),
    };
    io.out(o.json ? JSON.stringify(answer, null, 2) : answer.said);
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
