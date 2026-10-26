import { z } from "zod";
import { BREAKING_SPEC, type JudgeItem } from "@maycombhq/ai";
import type { RecordOf } from "@maycombhq/core";
import {
  docOf,
  filesOf,
  hopNotes,
  hopRoutes,
  normalizePath,
  readStoreWrites,
  type Hop,
} from "../artifacts.js";
import type { CriticContext } from "../context.js";
import { sectionLines, sectionMatching, type Doc } from "../doc.js";
import {
  hasWord,
  lineEvidence,
  questionOwner,
  recordEvidence,
  sentence,
  type DeterministicCheckDef,
  type Evidence,
  type Hit,
} from "../hits.js";
import { callLines, calls, KIND_WORDS, rowLocator, type Call } from "./interfaces.js";

/**
 * The checks the four questions add (ADR 0124 addendum, Part 4): what code can answer before a
 * model is asked. Is it safe to build: a synchronous call with no timeout, an entry another system
 * calls with no auth fact, a breaking change to an operation consumers the catalog knows still
 * call. Can it ship: a store write with no rollback step. Each finding cites its evidence and
 * says the one thing to do.
 */

const IFACES = "interfaces.md";
const ASYNC_ROUTES = new Set(["event-bus", "pubsub", "mq", "sftp"]);

/** Whether a call waits for its answer: the catalog's sync, else its pattern, else its route. */
function waits(c: Call): boolean {
  if (c.record?.sync === "async") return false;
  if (c.pattern && c.pattern.interaction !== "sync") return false;
  return !(c.via && ASYNC_ROUTES.has(c.via));
}

/** Where a call shows: its row in interfaces.md, or the catalog interface it is. */
function placeOf(ctx: CriticContext, c: Call): Pick<Hit, "artifact" | "locator" | "evidence"> {
  const ifaces = docOf(ctx.files, IFACES);
  if (c.hop && ifaces)
    return {
      artifact: IFACES,
      locator: rowLocator(ifaces, c.hop.line),
      evidence: [lineEvidence(ifaces, c.hop.line)],
    };
  return {
    artifact: "catalog",
    locator: { record: c.record?.id ?? c.caller },
    evidence: c.record ? [recordEvidence(c.record.id)] : [],
  };
}

export const callTimeoutStated: DeterministicCheckDef = {
  id: "call-timeout-stated",
  question: "safe",
  description:
    "Every synchronous call the change plans has a timeout: a timeout Setting of the caller for the callee in the catalog, or a timeout stated for the call in interfaces.md or design.md.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    for (const c of calls(ctx)) {
      if (!c.caller || !c.callee || !waits(c)) continue;
      const targets = new Set([c.callee, ctx.systemOf(c.callee)].filter(Boolean));
      const setting = ctx.records.some(
        (r) =>
          r.kind === "Setting" &&
          r.settingKind === "timeout" &&
          r.component === c.caller &&
          r.target !== undefined &&
          targets.has(r.target),
      );
      const lines = callLines(ctx, c);
      if (setting || lines.some((l) => KIND_WORDS.timeout.test(l.text))) continue;
      const place = placeOf(ctx, c);
      if (place.evidence.length === 0) continue;
      hits.push({
        kind: "issue",
        ...place,
        locator: { ...place.locator, field: "notes" },
        summary: sentence(
          `The call from ${c.caller} to ${c.callee} (${c.operation}) states no timeout.`,
        ),
        why: `Nothing in the catalog or the change says how long ${c.caller} waits for ${c.callee}. Without a timeout a slow ${c.callee} holds ${c.caller}'s threads, and everything that calls ${c.caller} waits too.`,
        fix: {
          text: `State the timeout for this call in its note in interfaces.md (for example "with a 2 s timeout"), or record ${c.caller}'s timeout setting for ${c.callee} in the catalog.`,
        },
        evidence: [...place.evidence, ...lines.slice(0, 2).map((l) => lineEvidence(l.doc, l.n))],
        // The same key as the pattern's resilience check: one finding when both see the call.
        key: `resilience|${place.artifact}|${c.hop?.line ?? c.record?.id}`,
      });
    }
    return { hits, subjects: [] };
  },
};

/** The catalog's Endpoint a hop calls: the Interface's, else the callee's by method and path. */
function endpointOf(
  ctx: CriticContext,
  callee: string,
  method: string | undefined,
  path: string | undefined,
  rec?: RecordOf<"Interface">,
): RecordOf<"Endpoint"> | undefined {
  if (rec?.endpoint) {
    const e = ctx.get("Endpoint", rec.endpoint);
    if (e) return e;
  }
  if (!path) return undefined;
  const p = normalizePath(path);
  return ctx.records.find(
    (r): r is RecordOf<"Endpoint"> =>
      r.kind === "Endpoint" &&
      r.component === callee &&
      (r.method ?? "").toUpperCase() === (method ?? "").toUpperCase() &&
      (r.normalizedPath ?? normalizePath(r.pathOrTopic)) === p,
  );
}

const interfaceOf = (ctx: CriticContext, h: Hop) =>
  h.id.startsWith("if-") ? ctx.get("Interface", h.id) : undefined;

/** A scope as written: `orders.read`, `SCOPE_ledger.read`, `payments:charge` (A-gateway2). */
const SCOPE_WORD = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)+$/;
/** The scopes a line of a story's criteria names: only quoted or backticked, only where it says scope. */
function scopesNamedIn(text: string): string[] {
  if (!/\bscopes?\b/i.test(text)) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/[`'"]([^`'"]{3,60})[`'"]/g))
    if (SCOPE_WORD.test(m[1]!.trim())) out.add(m[1]!.trim());
  return [...out].sort();
}

/**
 * The scopes each component's own callers' tokens carry: the routes the catalog says lead to it.
 * Read once per run (the records are walked once, not once per hop).
 */
function scopesIntoEach(ctx: CriticContext): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const r of ctx.records) {
    if (r.kind !== "Interface" || !r.route) continue;
    const scopes = ctx.get("GatewayRoute", r.route)?.scopes ?? [];
    if (!scopes.length) continue;
    const have = out.get(r.to) ?? new Set<string>();
    for (const s of scopes) have.add(s);
    out.set(r.to, have);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

export const publicEntryAuth: DeterministicCheckDef = {
  id: "public-entry-auth",
  question: "safe",
  description:
    "Every entry point the change adds or changes that another system or the gateway calls has an auth fact: the Endpoint's or the Interface's auth, or a gateway route that checks scopes. And the scopes hold up (A-gateway2): a route through the gateway that demands none, a caller whose own token can't hold the scope a hop downstream demands, and a scope a story's criteria name that no route demands.",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, IFACES);
    if (!doc) return { hits: [], subjects: [] };
    const hits: Hit[] = [];
    // A-gateway2: each hop's gateway routes, read once (the notes are parsed once per hop), the
    // scopes they demand between them, and the scopes the stories' criteria name.
    const routesOf = new Map<number, RecordOf<"GatewayRoute">[]>();
    for (const h of ctx.hops)
      routesOf.set(
        h.line,
        hopRoutes(ctx.files, h)
          .map((id) => ctx.get("GatewayRoute", id))
          .filter((r) => r !== undefined),
      );
    const allRoutes = [...routesOf.values()].flat();
    const demanded = new Set(allRoutes.flatMap((r) => r.scopes));
    /** The scopes each component's callers' tokens hold, read only if a hop needs them. */
    let heldBy: Map<string, string[]> | undefined;
    if (allRoutes.length)
      for (const story of filesOf(ctx.files, "stories").filter((d) => d.path !== "stories.md")) {
        const s = sectionMatching(story, /acceptance criteria/i);
        if (!s) continue;
        for (const l of sectionLines(story, s))
          for (const scope of scopesNamedIn(l.text)) {
            if (demanded.has(scope)) continue;
            hits.push({
              kind: "issue",
              artifact: story.path,
              locator: { line: l.n, heading: s.heading },
              summary: sentence(
                `The criteria ask for the scope ${scope}, and no gateway route the change names demands it.`,
              ),
              why: `The routes in interfaces.md demand ${demanded.size ? [...demanded].sort().join(", ") : "no scope at all"}, so a caller without ${scope} would be let through and the criterion would not hold.`,
              fix: {
                text: `Demand ${scope} on the route that carries this operation and record it on the GatewayRoute, or write the criterion with the scope the route does demand.`,
              },
              evidence: [lineEvidence(story, l.n)],
              key: `scope-unknown|${story.path}|${scope}`,
            });
          }
      }
    for (const h of ctx.hops) {
      if (h.status !== "planned-new" && h.status !== "planned-modify") continue;
      const calleeSystem = ctx.systemOf(h.callee);
      // An unknown callee is the catalog rule's; a vendor's entry isn't ours to secure.
      if (!calleeSystem || ctx.boundaryOf(calleeSystem) === "vendor") continue;
      const callerSystem = ctx.systemOf(h.caller);
      const rec = interfaceOf(ctx, h);
      const routes = routesOf.get(h.line) ?? [];
      const pattern = ctx.patterns.get(h.pattern);
      const gateway = routes.length > 0 || pattern?.route === "gateway" || rec?.via === "gateway";
      const crosses = callerSystem !== calleeSystem;
      if (!crosses && !gateway) continue;
      const ep = endpointOf(ctx, h.callee, h.method, h.path, rec);
      const facts = [ep?.auth, rec?.auth].filter((a) => a !== undefined);
      const checked = routes.filter((r) => r.scopes.length > 0);
      const op = h.operation || h.path || "the operation";
      const from = crosses ? "from another system" : "through the gateway";
      const evidence: Evidence[] = [
        lineEvidence(doc, h.line),
        ...(rec ? [recordEvidence(rec.id)] : []),
        ...(ep ? [recordEvidence(ep.id)] : []),
      ];
      // A-gateway2: the scopes, where the facts show them. A route that demands none lets any
      // token through, and a caller whose own callers' tokens can't hold what a route demands
      // can't pass one on. Never a silent pass: whichever the facts settle is said.
      if (routes.length) {
        const routeEvidence = [...evidence, ...routes.map((r) => recordEvidence(r.id))];
        if (!checked.length)
          hits.push({
            kind: "issue",
            artifact: IFACES,
            locator: { ...rowLocator(doc, h.line), field: "notes" },
            summary: sentence(
              `The gateway route ${routes.map((r) => r.id).join(", ")} that carries ${op} demands no scope.`,
            ),
            why: `The route checks who the caller is and nothing about what they may do, so any token the gateway accepts reaches ${h.callee}: ${h.caller} and every other client of ${routes[0]!.proxy} are let through alike.`,
            fix: {
              text: `Demand the scope this operation needs on the route (an OAuthV2 \`<Scope>\`, a JWT scope claim check) and record it on the GatewayRoute; if it is meant to be open to every caller the gateway lets in, dismiss this with the reason.`,
            },
            evidence: routeEvidence,
            key: `scope-none|${h.line}`,
          });
        else {
          const held = (heldBy ??= scopesIntoEach(ctx)).get(h.caller) ?? [];
          const wants = checked.flatMap((r) => r.scopes);
          if (held.length && !wants.some((s) => held.includes(s)))
            hits.push({
              kind: "knowledge-gap",
              artifact: IFACES,
              locator: { ...rowLocator(doc, h.line), field: "notes" },
              summary: sentence(
                `${op} demands ${wants.join(", ")}, and the token ${h.caller} is itself called with holds ${held.join(", ")}.`,
              ),
              why: `The routes into ${h.caller} demand ${held.join(", ")}, so a token passed straight through would be refused at ${routes.map((r) => r.id).join(", ")}. Nothing in the catalog says ${h.caller} gets a token that holds ${wants.join(", ")}.`,
              fix: {
                text: `Write how ${h.caller} gets a token for ${wants.join(", ")} (a token exchange, its own client credentials) in the hop's note in interfaces.md, or answer the question.`,
              },
              evidence: routeEvidence,
              question: {
                text: `How does ${h.caller} get a token holding ${wants.join(", ")}, which ${op} demands? The routes into ${h.caller} demand ${held.join(", ")}.`,
                owner: questionOwner(ctx, h.caller),
              },
              subject: h.caller,
              key: `scope-caller|${h.line}`,
            });
        }
      }
      if (facts.some((a) => a !== "none") || checked.length) continue;
      if (facts.length) {
        hits.push({
          kind: "issue",
          artifact: IFACES,
          locator: { ...rowLocator(doc, h.line), field: "notes" },
          summary: sentence(
            `${h.callee} takes ${op} from ${h.caller}, ${crosses ? "in another system" : "through the gateway"}, with no authentication.`,
          ),
          why: `The catalog records the entry's auth as none, and ${h.caller} calls it ${from}: anyone who can reach it can call it.`,
          fix: {
            text: `Require OAuth2 or mTLS on ${op}, or route it through a gateway route that checks scopes, and record the auth in the catalog; if it must stay open, dismiss this with the reason.`,
          },
          evidence,
          key: `auth|${h.line}`,
        });
        continue;
      }
      hits.push({
        kind: "knowledge-gap",
        artifact: IFACES,
        locator: { ...rowLocator(doc, h.line), field: "notes" },
        summary: sentence(
          `Nothing says how ${h.callee} authenticates callers of ${op}, which ${h.caller} calls ${from}.`,
        ),
        why: `No Endpoint or Interface in the catalog records the entry's auth, and no gateway route the hop names checks scopes, so nobody can say who may call it.`,
        fix: {
          text: `Write how ${op} authenticates its callers (OAuth2, mTLS, an API key) in the hop's note in interfaces.md, or answer the question.`,
        },
        evidence,
        question: {
          text: `How does ${h.callee} authenticate callers of ${op} (OAuth2, mTLS, an API key, or none)?`,
          owner: questionOwner(ctx, h.callee),
        },
        subject: h.callee,
        key: `auth|${h.line}`,
      });
    }
    return { hits, subjects: [] };
  },
};

interface Delta {
  change: "planned-modify" | "planned-retire";
  caller: string;
  callee: string;
  operation: string;
  method?: string;
  path?: string;
  hop?: Hop;
  record?: RecordOf<"Interface">;
  notes: string;
}

/** The operations the change modifies or retires: interfaces.md's rows, and touched interfaces. */
function deltas(ctx: CriticContext): Delta[] {
  const out: Delta[] = [];
  const rows = new Set(ctx.hops.map((h) => h.id));
  for (const h of ctx.hops) {
    if (h.status !== "planned-modify" && h.status !== "planned-retire") continue;
    const rec = interfaceOf(ctx, h);
    out.push({
      change: h.status,
      caller: h.caller,
      callee: h.callee,
      operation: h.operation || (h.path ?? ""),
      ...(h.method ? { method: h.method } : {}),
      ...(h.path ? { path: h.path } : {}),
      hop: h,
      ...(rec ? { record: rec } : {}),
      // As the release notes read it, so both read the same judgment (ADR 0117 addendum).
      notes: hopNotes(ctx.files, h)
        .map((n) => n.text.replace(/^\s*[-*]\s+/, "").trim())
        .join(" "),
    });
  }
  for (const t of ctx.footprint.interfaces) {
    if (rows.has(t.id) || t.status === "planned-new") continue;
    const rec = ctx.get("Interface", t.id);
    if (!rec) continue;
    out.push({
      change: t.status,
      caller: rec.from,
      callee: rec.to,
      operation: `${rec.method ?? ""} ${rec.normalizedPath}`.trim(),
      ...(rec.method ? { method: rec.method } : {}),
      path: rec.normalizedPath,
      record: rec,
      notes: "",
    });
  }
  return out;
}

/** The catalog's other callers of a changed operation that the change doesn't plan for. */
function consumersOf(ctx: CriticContext, d: Delta): RecordOf<"Interface">[] {
  const ep = endpointOf(ctx, d.callee, d.method, d.path, d.record);
  const p = d.path ? normalizePath(d.path) : undefined;
  const planned = new Set([
    ...ctx.footprint.interfaces.map((t) => t.id),
    ...ctx.hops.map((h) => h.id),
  ]);
  return ctx.records.filter(
    (r): r is RecordOf<"Interface"> =>
      r.kind === "Interface" &&
      r.id !== d.record?.id &&
      r.from !== d.caller &&
      !planned.has(r.id) &&
      !ctx.hops.some((h) => h.caller === r.from && h.callee === r.to) &&
      (ep
        ? r.endpoint === ep.id
        : r.to === d.callee &&
          p !== undefined &&
          r.normalizedPath === p &&
          (r.method ?? "").toUpperCase() === (d.method ?? "").toUpperCase()),
  );
}

/** The `breaking` judgment's item for a changed operation, keyed as the release notes key it. */
function breakingItemOf(d: Delta): JudgeItem {
  return {
    inputs: {
      v: 1,
      change: d.change,
      operation: d.operation,
      caller: d.caller,
      callee: d.callee,
      notes: d.notes,
    },
    texts: { notes: d.notes },
    facts: [
      `operation: ${d.operation}`,
      `caller: ${d.caller}`,
      `callee: ${d.callee}`,
      `change: ${d.change.replace(/^planned-/, "")}`,
    ],
  };
}

/**
 * The breaking judgments the check reads (ADR 0117 addendum), settled before it runs: one per
 * changed operation that other consumers call and that interfaces.md says something about. A
 * retired one is settled by its change kind, the veto.
 */
export function breakingItems(ctx: CriticContext): JudgeItem[] {
  return deltas(ctx)
    .filter((d) => (d.notes || d.change === "planned-retire") && consumersOf(ctx, d).length)
    .map(breakingItemOf);
}

const and = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

export const breakingDeltaConsumers: DeterministicCheckDef = {
  id: "breaking-delta-consumers",
  question: "safe",
  description:
    "An operation the change retires, or changes so that a caller must change (a judgment), plans for every other consumer the catalog knows.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const ifaces = docOf(ctx.files, IFACES);
    for (const d of deltas(ctx)) {
      const consumers = consumersOf(ctx, d);
      if (consumers.length === 0) continue;
      const verdict =
        d.change === "planned-retire"
          ? "yes"
          : ctx.judged(BREAKING_SPEC.kind, breakingItemOf(d).inputs);
      if (verdict === "no") continue;
      const who = [...new Set(consumers.map((c) => c.from))].sort();
      const one = who.length === 1;
      const evidence: Evidence[] = [
        ...(d.hop && ifaces ? [lineEvidence(ifaces, d.hop.line)] : []),
        ...(d.record ? [recordEvidence(d.record.id)] : []),
        ...consumers.map((c) => recordEvidence(c.id)),
      ];
      const place =
        d.hop && ifaces
          ? { artifact: IFACES, locator: rowLocator(ifaces, d.hop.line) }
          : { artifact: "catalog", locator: { record: d.record!.id } };
      const key = `breaking|${d.hop?.line ?? d.record?.id}`;
      const repos = [
        ...new Set(who.map((w) => ctx.get("Component", w)?.repo).filter((r) => r !== undefined)),
      ];
      const fix = {
        text: `Add a row to interfaces.md for ${and(who)} (planned-modify) with a task in ${repos.length ? and(repos) : one ? "its repo" : "their repos"}, or keep the old ${d.operation} beside the new one until ${one ? "it moves" : "they move"}.`,
      };
      if (verdict === "yes") {
        hits.push({
          kind: "issue",
          ...place,
          summary: sentence(
            `${d.change === "planned-retire" ? "Retiring" : "Changing"} ${d.operation} breaks ${and(who)}, which ${one ? "calls" : "call"} it today and which the change doesn't plan for.`,
          ),
          why:
            d.change === "planned-retire"
              ? `A retired operation breaks every caller, and the catalog knows ${and(who)} ${one ? "calls" : "call"} it.`
              : `A judgment on file says a caller must change its code or handling for this change to ${d.operation}, and the catalog knows ${and(who)} ${one ? "calls" : "call"} it.`,
          fix,
          evidence,
          key,
        });
        continue;
      }
      hits.push({
        kind: "knowledge-gap",
        ...place,
        summary: sentence(
          `Nobody has judged whether the change to ${d.operation} breaks ${and(who)}, which ${one ? "calls" : "call"} it and which the change doesn't plan for.`,
        ),
        why: `The catalog knows ${and(who)} ${one ? "calls" : "call"} ${d.operation}, and whether ${one ? "it" : "they"} must change is a judgment nobody has made yet (no model was asked, or it was unsure).`,
        fix,
        evidence,
        question: {
          text: `Must ${and(who)} change ${one ? "its" : "their"} code to keep working once ${d.operation} changes as interfaces.md says?`,
          owner: questionOwner(ctx, d.callee),
        },
        subject: d.callee,
        key,
      });
    }
    return { hits, subjects: [] };
  },
};

/** The rollback section of design.md: the section whose heading says roll back. */
function rollbackLines(
  ctx: CriticContext,
): { doc: Doc; heading: string; lines: { n: number; text: string }[] } | undefined {
  const doc = docOf(ctx.files, "design.md");
  const s = doc?.sections.find((x) => /roll\s*-?\s*back/i.test(x.heading));
  if (!doc || !s) return undefined;
  return {
    doc,
    heading: s.heading,
    lines: sectionLines(doc, s).filter((l) => l.text.trim() !== ""),
  };
}

export const storeWriteRollback: DeterministicCheckDef = {
  id: "store-write-rollback",
  question: "ship",
  description:
    "Every table the change writes or alters (data.md, or a target flow's write step) is named, or its migration is, under the rollback heading of design.md.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const plan = rollbackLines(ctx);
    for (const w of readStoreWrites(ctx.files)) {
      const names = [w.table, w.name, ...(w.migration ? [w.migration] : [])];
      if (plan?.lines.some((l) => names.some((n) => hasWord(l.text, n)))) continue;
      const doc =
        w.artifact === "data.md"
          ? docOf(ctx.files, "data.md")
          : ctx.files.flows?.find((f) => f.path === w.artifact);
      if (!doc) continue;
      hits.push({
        kind: "issue",
        artifact: w.artifact,
        locator: rowLocator(doc, w.line),
        summary: sentence(
          plan
            ? `The write to ${w.table} has no rollback step: design.md's rollback names neither it nor ${w.migration ?? "its migration"}.`
            : `The write to ${w.table} has no rollback step: design.md has no rollback section.`,
        ),
        why: "A store write is the step a redeploy doesn't undo: rows the new code wrote stay, and a migration has to be reversed or kept on purpose. Each table needs its own line in the rollback plan.",
        fix: {
          text: `Add a line under ${plan ? `"${plan.heading}"` : `a "Rollout and rollback" heading`} in design.md that says how the change to ${w.table} is undone (or why it needs no undo, such as an expand-only migration) and what happens to rows written in between.`,
        },
        evidence: [
          lineEvidence(doc, w.line),
          ...(plan?.lines.slice(0, 2).map((l) => lineEvidence(plan.doc, l.n)) ?? []),
        ],
        key: `rollback|${w.artifact}|${w.line}`,
      });
    }
    return { hits, subjects: [] };
  },
};
