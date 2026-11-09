import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  API_VERSION,
  fastPathOf,
  Lens,
  questionOfLens,
  RECORD_KINDS,
  RecordId,
  SCHEMA_VERSION,
  Severity,
  layoutOf,
  loadOrgPack,
  orgPackDirOf,
  type ChangeLifecycle,
  type Finding,
} from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";
import {
  graph,
  impact,
  openIndex,
  QueryError,
  askLookup,
  translate,
  type CatalogIndex,
} from "@maycombhq/index";
import { readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import { baseClonePath, loadRepos, type GitUser } from "@maycombhq/workspace";
import { badRequest, intParam, notFound, strParam, type Router } from "./http.js";

export interface Context {
  root: string;
  /** The person's handle, recorded as `by` on everything they do (ADR 0073). */
  user: string;
  /** The Git user behind `user`: name, email, and a warning when the OS user stood in. */
  person?: GitUser;
  version: string;
  /** `atticus ui --full`: the app offers every page, not only the six entries. */
  full?: boolean;
}

/** Index work runs one call at a time per root: a first build or a rebuild must not race. */
const queues = new Map<string, Promise<unknown>>();

/**
 * beta.23 ("Home loads fast"). The roots whose index was checked against its files since the
 * last change the server heard (`indexFilesChanged`), and the roots whose server follows their
 * files (`trustIndexBetweenChanges`): only those skip the check. A root's change count tells an
 * open that a change came while it ran.
 */
const checked = new Map<string, number>();
/** A watcher can miss a change (Windows drops one on an error): the files are checked again after this long anyway. */
const TRUST_MS = 30_000;
const following = new Set<string>();
const changes = new Map<string, number>();

/** The server follows this root's files and says each change (startServer with its watcher). */
export function trustIndexBetweenChanges(root: string, on: boolean): void {
  if (on) following.add(root);
  else {
    following.delete(root);
    checked.delete(root);
  }
}

/** A file may have changed (a live event, a write through the API): the next open checks. */
export function indexFilesChanged(root?: string): void {
  for (const r of root ? [root] : [...following, ...checked.keys()]) {
    checked.delete(r);
    changes.set(r, (changes.get(r) ?? 0) + 1);
  }
}

/**
 * Embedding runs in the background, a few nodes at a time between requests, never inside a
 * page's request: an open embedded up to 500 nodes before answering (with the bundled model,
 * from seconds to a minute on a laptop), so Home's first loads waited on it.
 */
const embedding = new Map<string, ReturnType<typeof setTimeout>>();
/** When a request last opened each root's index. */
const asked = new Map<string, number>();
function embedSoon(root: string): void {
  if (embedding.has(root) || process.env.ATTICUS_EMBEDDINGS === "off") return;
  const step = () => {
    // A page is asking: wait for it to finish, then go on.
    if (Date.now() - (asked.get(root) ?? 0) < 1500) {
      embedding.set(root, setTimeout(step, 1000).unref());
      return;
    }
    void withIndex(root, (ix) => ix.embed({ max: 8 }), { meaning: true })
      .then(
        (n) => n > 0,
        () => false,
      )
      .then((more) => {
        if (more && embedding.has(root)) embedding.set(root, setTimeout(step, 50).unref());
        else embedding.delete(root);
      });
  };
  // After the page's burst of requests, not during it.
  embedding.set(root, setTimeout(step, 2000).unref());
}

/** Stop a root's background embedding (its server closes). */
export function stopEmbedding(root: string): void {
  const t = embedding.get(root);
  if (t) clearTimeout(t);
  embedding.delete(root);
}

/** Open the index for one request; it rebuilds itself when catalog files changed (ADR 0003). */
async function withIndex<T>(
  root: string,
  f: (ix: CatalogIndex) => T | Promise<T>,
  o: { meaning?: boolean } = {},
): Promise<T> {
  if (!o.meaning) asked.set(root, Date.now());
  const before = queues.get(root) ?? Promise.resolve();
  const mine = before.then(async () => {
    const trusted = following.has(root) && Date.now() - (checked.get(root) ?? -Infinity) < TRUST_MS;
    const at = changes.get(root) ?? 0;
    const ix = await openIndex(root, {
      embedOnOpen: 0,
      // Only search and ask compare by meaning; the counts, lists and graph never need the model.
      ...(o.meaning ? {} : { embeddings: "off" as const }),
      ...(trusted ? { trusted: true } : {}),
    });
    if (!trusted && following.has(root) && (changes.get(root) ?? 0) === at)
      checked.set(root, Date.now());
    // Files were read again: their new nodes get vectors in the background.
    if (!trusted && !o.meaning) embedSoon(root);
    try {
      return await f(ix);
    } finally {
      ix.close();
    }
  });
  const settled = mine.catch(() => undefined);
  queues.set(root, settled);
  void settled.then(() => {
    if (queues.get(root) === settled) queues.delete(root);
  });
  return mine;
}

function kindParam(kind: string): string {
  if (!(RECORD_KINDS as readonly string[]).includes(kind))
    throw badRequest(`${kind} is not a record kind. Kinds: ${RECORD_KINDS.join(", ")}.`);
  return kind;
}

function enumParam<T extends string>(q: URLSearchParams, name: string, options: readonly T[]) {
  const v = strParam(q, name);
  if (v !== undefined && !(options as readonly string[]).includes(v))
    throw badRequest(`${name} must be one of ${options.join(", ")}.`);
  return v as T | undefined;
}

/** Findings in the newest round of every gate a change was reviewed at. */
async function latestFindings(root: string, change: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const gate of await reviewedGates(root, change)) {
    const rounds = await roundsOf(root, change, gate);
    if (rounds.length === 0) continue;
    const r = await readRound(root, change, gate, rounds[rounds.length - 1]!);
    out.push(...r.findings.map((f) => f.finding));
  }
  return out;
}

function summary(c: ChangeLifecycle, findings: Finding[], fast = false) {
  const open = { blocking: 0, gap: 0, risk: 0, idea: 0 };
  for (const f of findings) if (f.state === "open") open[f.severity] += 1;
  const last = c.history[c.history.length - 1];
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    state: c.state,
    repos: c.touches.repos,
    openFindings: open,
    updatedAt: last?.at ?? c.createdAt,
    ...(fast ? { fastPath: true } : {}),
  };
}

export function apiRoutes(r: Router, ctx: Context): Router {
  const { root } = ctx;
  return r
    .add("GET", "/api/health", () => ({
      status: 200,
      body: {
        version: ctx.version,
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        root,
        openspec: layoutOf(root).openspec.replace(/\/+$/, ""),
        user: ctx.user,
        full: ctx.full === true,
        // ADR 0190: in a folder that isn't a metarepo yet, the app offers to create one.
        metarepo:
          existsSync(join(root, "org-pack")) || existsSync(join(root, ".atticus", "org-pack")),
      },
    }))
    .add("GET", "/api/catalog/kinds", async () => ({
      status: 200,
      body: await withIndex(root, (ix) => ix.kinds()),
    }))
    .add("GET", "/api/catalog/{kind}", async ({ params, query }) => {
      const kind = kindParam(params.kind!);
      const limit = intParam(query, "limit", 1, 500);
      const o = {
        ...(strParam(query, "status") ? { status: strParam(query, "status")! } : {}),
        ...(strParam(query, "system") ? { system: strParam(query, "system")! } : {}),
        ...(strParam(query, "q") ? { q: strParam(query, "q")! } : {}),
        ...(strParam(query, "confidence") ? { confidence: strParam(query, "confidence")! } : {}),
        ...(strParam(query, "cursor") ? { cursor: strParam(query, "cursor")! } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return { status: 200, body: await withIndex(root, (ix) => ix.list(kind, o)) };
    })
    .add("GET", "/api/catalog/{kind}/{id}", async ({ params }) => {
      const kind = kindParam(params.kind!);
      const rec = await withIndex(root, (ix) => ix.get(kind, params.id!));
      if (!rec) throw notFound(`There is no ${kind} ${params.id}.`);
      return { status: 200, body: rec };
    })
    .add("GET", "/api/search", async ({ query }) => {
      const q = strParam(query, "q");
      if (!q) throw badRequest("Say what to look for: ?q=<words or filters>.");
      const limit = intParam(query, "limit", 1, 500) ?? 100;
      const offset = intParam(query, "offset", 0, 1_000_000) ?? 0;
      try {
        return { status: 200, body: await withIndex(root, (ix) => ix.query(q, { limit, offset })) };
      } catch (e) {
        if (e instanceof QueryError) throw badRequest(e.message);
        throw e;
      }
    })
    .add("GET", "/api/ask", async ({ query }) => {
      const q = strParam(query, "q");
      if (!q) throw badRequest("Ask a question: ?q=<plain words>.");
      return {
        status: 200,
        body: await withIndex(root, (ix) => {
          const asked = translate(q, askLookup(ix));
          if (asked.action === "impact")
            return { question: q, ...asked, impact: impact(ix, asked.id, 4) };
          if (asked.action === "owner") {
            const r = ix.find(asked.id)[0] as unknown as Record<string, unknown> | undefined;
            const owner =
              (r?.owner as string | undefined) ??
              (r?.ownerComponent as string | undefined) ??
              (r
                ? (
                    ix.find(String(r.system ?? ""))[0] as unknown as
                      Record<string, unknown> | undefined
                  )?.owner
                : undefined);
            return { question: q, ...asked, owner: owner ?? null };
          }
          try {
            return { question: q, ...asked, result: ix.query(asked.query, { limit: 60 }) };
          } catch (e) {
            if (e instanceof QueryError) return { question: q, ...asked, error: e.message };
            throw e;
          }
        }),
      };
    })
    .add("GET", "/api/graph", async ({ query }) => {
      const depth = intParam(query, "depth", 1, 6);
      const o = {
        ...(strParam(query, "focus") ? { focus: strParam(query, "focus")! } : {}),
        ...(strParam(query, "status") ? { status: strParam(query, "status")! } : {}),
        ...(depth !== undefined ? { depth } : {}),
      };
      return { status: 200, body: await withIndex(root, (ix) => graph(ix, o)) };
    })
    .add("GET", "/api/impact/{id}", async ({ params, query }) => {
      const depth = intParam(query, "depth", 1, 10);
      const res = await withIndex(root, (ix) => {
        const r = impact(ix, params.id!, depth);
        if (!r) return undefined;
        // ADR 0181 (ninth UX walk): a record the AI decided says so, with its run, so the
        // explorer marks it "Detected by AI" as a change's Impact page does.
        return {
          ...r,
          affected: r.affected.map((a) => {
            const rec = ix.find(a.id)[0] as
              { flags?: unknown; evidence?: { source?: string; run?: string }[] } | undefined;
            const ai = (rec?.evidence ?? []).find((e) => e.source === "ai");
            const flagged = Array.isArray(rec?.flags) && rec.flags.includes("joined-by-ai");
            return flagged || ai ? { ...a, byAi: true, ...(ai?.run ? { run: ai.run } : {}) } : a;
          }),
        };
      });
      if (!res) throw notFound(`There is no record ${params.id} in the catalog.`);
      return { status: 200, body: res };
    })
    .add("GET", "/api/incident/{id}", async ({ params }) => {
      // Incident mode: read-only, from the last scan. Atticus never connects to live systems,
      // consoles or monitoring; this is what the catalog says a failure here reaches.
      const res = await withIndex(root, (ix) => {
        const reach = impact(ix, params.id!, 3);
        if (!reach) return undefined;
        const rootRec = ix.find(params.id!)[0]!;
        const ids = [params.id!, ...reach.affected.map((a) => a.id)];
        const kindOf = new Map(reach.affected.map((a) => [a.id, a.kind]));
        kindOf.set(params.id!, rootRec.kind);
        const systems = new Set<string>();
        for (const id of ids) {
          const k = kindOf.get(id)!;
          const sys = k === "System" ? id : ix.systemOf(k, id);
          if (sys) systems.add(sys);
        }
        const owners = new Map<string, { owner: string; systems: string[] }>();
        const unowned: string[] = [];
        for (const sys of [...systems].sort()) {
          const rec = ix.get("System", sys) as unknown as { owner?: string } | undefined;
          if (!rec?.owner) unowned.push(sys);
          else {
            const o = owners.get(rec.owner) ?? { owner: rec.owner, systems: [] };
            o.systems.push(sys);
            owners.set(rec.owner, o);
          }
        }
        const components = new Set(ids.filter((id) => kindOf.get(id) === "Component"));
        const watch = ix
          .query("kind:observabilityasset", { limit: 500 })
          .rows.map((r) => ix.get(r.kind, r.id) as unknown as Record<string, unknown>)
          .filter((a) => components.has(String(a.component)))
          .map((a) => ({
            component: String(a.component),
            kind: String(a.assetKind),
            name: String(a.name),
            ...(a.link ? { link: String(a.link) } : {}),
          }));
        return {
          reach,
          systems: [...systems].sort(),
          owners: [...owners.values()],
          unowned,
          watch,
        };
      });
      if (!res) throw notFound(`There is no record ${params.id} in the catalog.`);
      const near = new Set([...res.systems, params.id!, ...res.reach.affected.map((a) => a.id)]);
      const changes = (await changeStore(root).list())
        .filter(
          (c) =>
            c.systems.some((s) => near.has(s)) ||
            [...c.touches.records, ...c.touches.tables, ...c.touches.dataStores].some((x) =>
              near.has(x),
            ),
        )
        .map((c) => ({
          id: c.id,
          title: c.title,
          state: c.state,
          updatedAt: c.history.at(-1)?.at ?? c.createdAt,
          systems: c.systems.filter((s) => near.has(s)),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        status: 200,
        body: {
          id: params.id,
          blastRadius: res.reach.affected.length,
          affected: res.reach.affected,
          systems: res.systems,
          call: res.owners,
          ownerUnknown: res.unowned,
          watch: res.watch,
          recentChanges: changes,
        },
      };
    })
    .add("GET", "/api/repos", async () => {
      const repos = await loadRepos(root);
      const body = [];
      for (const repo of repos) {
        const present = await stat(join(baseClonePath(root, repo.id), ".git")).then(
          () => true,
          () => false,
        );
        body.push({ ...repo, baseClone: { present } });
      }
      return { status: 200, body };
    })
    .add("GET", "/api/changes", async ({ query }) => {
      const state = strParam(query, "state");
      const changes = (await changeStore(root).list()).filter((c) => !state || c.state === state);
      const body = [];
      // ADR 0113: whether each takes the fast path, from its type and its brief.
      const types = await loadOrgPack(orgPackDirOf(root)).then(
        (op) => op.changeTypes.types,
        () => [],
      );
      for (const c of changes.sort((a, b) => a.id.localeCompare(b.id))) {
        const type = types.find((t) => t.id === c.type);
        const fast =
          !!type &&
          (type.size === "small" || !!type.smallWhenBriefSays) &&
          fastPathOf(
            type,
            await readFile(join(changeFolder(root, c.id), "brief.md"), "utf8").catch(() => ""),
          ).fast;
        body.push(summary(c, await latestFindings(root, c.id), fast));
      }
      return { status: 200, body };
    })
    .add("GET", "/api/findings", async ({ query }) => {
      const change = strParam(query, "change");
      // An id, never a path: nothing outside changes/ is read.
      if (change !== undefined && !RecordId.safeParse(change).success)
        throw badRequest(`${change} isn't a change id.`);
      const gate = strParam(query, "gate");
      const state = strParam(query, "state");
      const lens = enumParam(query, "lens", Lens.options);
      const severity = enumParam(query, "severity", Severity.options);
      const ids = change ? [change] : (await changeStore(root).list()).map((c) => c.id).sort();
      const body: Finding[] = [];
      for (const id of ids)
        for (const f of await latestFindings(root, id))
          if (
            (!gate || f.gate === gate) &&
            (!state || f.state === state) &&
            // A lens filter asks its question: an old lens name finds what its question raised.
            (!lens || questionOfLens(f.lens) === questionOfLens(lens)) &&
            (!severity || f.severity === severity)
          )
            body.push(f);
      return { status: 200, body };
    })
    .add("GET", "/api/findings/{changeId}/{findingId}", async ({ params }) => {
      if (!RecordId.safeParse(params.changeId!).success)
        throw badRequest(`${params.changeId} isn't a change id.`);
      const f = (await latestFindings(root, params.changeId!)).find(
        (x) => x.id === params.findingId,
      );
      if (!f) throw notFound(`Change ${params.changeId} has no finding ${params.findingId}.`);
      return { status: 200, body: f };
    })
    .add("GET", "/api/orgpack", async () => {
      const op = await loadOrgPack(orgPackDirOf(root));
      return {
        status: 200,
        body: {
          defaulted: op.defaulted,
          counts: {
            patterns: op.patterns.length,
            dialects: op.dialects.length,
            checklists: op.checklists.length,
            agents: op.agents.length,
            procedures: op.procedures.length,
            serviceRequests: op.serviceRequests.length,
            profiles: op.profiles.length,
            gates: Object.keys(op.gates ?? {}).length,
          },
          // Additive (ADR 0043): the patterns, checklists and procedures themselves, for the screen.
          patterns: op.patterns,
          checklists: op.checklists.map((c) => ({
            name: c.name,
            version: c.version,
            rules: c.rules.length,
          })),
          procedures: op.procedures.map((x) => ({
            id: x.id,
            title: (x as { title?: string }).title,
            steps: (x as { steps?: unknown[] }).steps?.length ?? 0,
          })),
          problems: op.problems.map((p) => ({
            file: p.file,
            path: p.path ?? "",
            message: p.message,
          })),
        },
      };
    });
}
