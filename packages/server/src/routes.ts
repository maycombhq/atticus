import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  API_VERSION,
  Lens,
  RECORD_KINDS,
  SCHEMA_VERSION,
  Severity,
  layoutOf,
  loadOrgPack,
  orgPackDirOf,
  type ChangeLifecycle,
  type Finding,
} from "@maycombhq/core";
import { changeStore } from "@maycombhq/changes";
import { graph, impact, openIndex, QueryError, type CatalogIndex } from "@maycombhq/index";
import { readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";
import { badRequest, intParam, notFound, strParam, type Router } from "./http.js";

export interface Context {
  root: string;
  user: string;
  version: string;
}

/** Open the index for one request; it rebuilds itself when catalog files changed (ADR 0003). */
async function withIndex<T>(root: string, f: (ix: CatalogIndex) => T): Promise<T> {
  const ix = await openIndex(root);
  try {
    return f(ix);
  } finally {
    ix.close();
  }
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

function summary(c: ChangeLifecycle, findings: Finding[]) {
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
      const res = await withIndex(root, (ix) => impact(ix, params.id!, depth));
      if (!res) throw notFound(`There is no record ${params.id} in the catalog.`);
      return { status: 200, body: res };
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
      for (const c of changes.sort((a, b) => a.id.localeCompare(b.id)))
        body.push(summary(c, await latestFindings(root, c.id)));
      return { status: 200, body };
    })
    .add("GET", "/api/findings", async ({ query }) => {
      const change = strParam(query, "change");
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
            (!lens || f.lens === lens) &&
            (!severity || f.severity === severity)
          )
            body.push(f);
      return { status: 200, body };
    })
    .add("GET", "/api/findings/{changeId}/{findingId}", async ({ params }) => {
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
          problems: op.problems.map((p) => ({
            file: p.file,
            path: p.path ?? "",
            message: p.message,
          })),
        },
      };
    });
}
