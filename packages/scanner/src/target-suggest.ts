import {
  factIdPart,
  questionId,
  slugify,
  topicQuestionText,
  TOPICS_OUTSIDE_LABEL,
  TOPICS_STEP_ID,
  ignoredAnswer,
  TARGETS_ANOTHER_LABEL,
  TARGETS_SPLIT_LABEL,
  TARGETS_STEP_ID,
  type CatalogRecord,
  type Fact,
  type FactOf,
  type OrgPack,
  type Question,
  type QuestionDraft,
  cmpText,
} from "@maycombhq/core";
import { estateRepos } from "./merge-input.js";

/**
 * Who a call with no target is suggested to go to (ADR 0162, F8): every repo of the manifest,
 * read or not, and every outside system of the profiles, ranked by what the code and the org pack
 * say: the call's config key, client class or host label against a repo's id, component, modules
 * or its system's aliases; its path against each repo's base path (the manifest's, a proxy's
 * BasePath, a Route's); an entry of a read repo that serves it; the repo's description; and the
 * caller repo's earlier answers. Each suggestion says why, and whether the repo is read yet. Pure
 * and deterministic: the same facts, catalog, org pack and answers give the same list.
 */

/** The most suggestions a targets question offers, before "Another repo…" and "None of these". */
export const TARGETS_MAX_SUGGESTED = 5;

/** The option of a targets question that opens the picker of the whole estate. */
export const TARGETS_ANOTHER = TARGETS_ANOTHER_LABEL;

/** A repo or system a call may go to, with how strongly the evidence says so and why. */
export interface TargetSuggestion {
  /** What the answer names: a read repo's component, an unread repo's id, or a system's id. */
  label: string;
  kind: "repo" | "outside";
  /** The manifest repo, for a repo. */
  repo?: string;
  /** Whether the repo's facts are on file (always false for an outside system). */
  read: boolean;
  /** An outside system's name and boundary. */
  name?: string;
  boundary?: string;
  score: number;
  /** Why it is suggested, strongest first. */
  why: string[];
  /**
   * Beta.12: the entries of it that serve the call (`PUT /accounts/{id}`), so a group's question
   * says how many of its calls it serves rather than one line per call.
   */
  serves?: string[];
}

/** Why an option with no evidence is listed (beta.12): never that it answers the call. */
export const TARGETS_NO_EVIDENCE = "no evidence; listed so you can pick it";

export interface SuggestContext {
  op: OrgPack;
  records: readonly CatalogRecord[];
  /** The facts of the caller repo (its config values). */
  facts: readonly Fact[];
  /** The other repos' verified facts: which are read, their entries and their Routes and proxies. */
  estate?: readonly { repo: string; facts: readonly Fact[] }[];
  /** Every targets question on file: the caller repo's earlier answers. */
  questions?: readonly Question[];
  /** The join's candidates for an ambiguous call: only these components are offered as repos. */
  only?: readonly string[];
}

const STOP = new Set(
  (
    "url uri base host client clients service services svc api apis http https rest endpoint " +
    "endpoints impl java kt ts js py cs go src main test get post put delete patch the and for com " +
    "www internal example config configs properties yaml yml env app apps application new call calls " +
    "feign template web request requests response gateway proxy remote adapter port"
  ).split(" "),
);

/** The words of a name, a key or a class: lower case, camelCase and separators split, plurals cut. */
export function nameWords(s: string | undefined): string[] {
  if (!s) return [];
  return [
    ...new Set(
      s
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOP.has(w) && !/^v?\d+$/.test(w))
        .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
    ),
  ];
}

/** A path's segments, a placeholder being any one. */
const segs = (p: string) =>
  p
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((x) => (/^[{:<$]/.test(x) ? "{}" : x));
const sameSeg = (a: string, b: string) => a === "{}" || b === "{}" || a === b;
/** Whether `path` starts with every segment of `prefix`. */
const under = (path: string, prefix: string) => {
  const a = segs(prefix);
  const b = segs(path);
  return a.length > 0 && a.length <= b.length && a.every((x, i) => x === b[i]);
};
/** Whether an entry's path serves a call's path, whole, or after a base path in front. */
function serves(entry: string, call: string, bases: readonly string[]): boolean {
  const e = segs(entry);
  const tries = [
    segs(call),
    ...bases.filter((b) => under(call, b)).map((b) => segs(call).slice(segs(b).length)),
  ];
  return tries.some((c) => c.length === e.length && c.every((x, i) => sameSeg(x, e[i]!)));
}

/** The class a call is made through: a `...Client` (or Service, Api, Feign) on its line, else its file's. */
function clientOf(f: FactOf<"call">): string | undefined {
  const q = f.cite.quote ?? "";
  const named = /\b([A-Z][A-Za-z0-9]*(?:Client|Service|Api|Feign|Gateway|Proxy))\b/.exec(q)?.[1];
  if (named) return named;
  const file = f.cite.file
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  return /(Client|Service|Api|Feign|Gateway|Proxy)$/.test(file) ? file : undefined;
}

/** The host a call goes to: its own, or the URL its base's config value gives. */
function hostOf(f: FactOf<"call">, facts: readonly Fact[]): string | undefined {
  const fromUrl = (u: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(u)?.[1];
  if (f.host) return fromUrl(f.host) ?? f.host.split(/[/:]/)[0];
  if (f.base) {
    const cfg = facts.find(
      (x): x is FactOf<"config"> => x.kind === "config" && x.key === f.base && !!x.value,
    );
    if (!cfg?.value) return undefined;
    // A TargetServer's or a remote config's value is often the bare host (core.apps.forge.internal).
    return (
      fromUrl(cfg.value) ??
      (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(cfg.value) ? cfg.value.split(":")[0] : undefined)
    );
  }
  return undefined;
}

const answerLabel = (q: Question): string | undefined =>
  // Beta.24 review: Ignore names no target, so it is never suggested again.
  ignoredAnswer(q)
    ? undefined
    : q.answer?.option !== undefined
      ? q.options[q.answer.option - 1]?.label
      : q.answer?.text;

const NOT_A_TARGET = new Set(["None of these", TARGETS_SPLIT_LABEL, TARGETS_ANOTHER_LABEL]);

interface Candidate {
  s: TargetSuggestion;
  /** The words its names give. */
  names: Map<string, string>;
  /** Its base paths, with where each comes from. */
  bases: { path: string; from: string }[];
  /** The entries it serves (method, path, where), a read repo's. */
  entries: { method?: string; path: string; at: string }[];
  description?: string;
  hosts: string[];
}

/** Every repo of the manifest but the caller's, and every outside system, as a candidate. */
function candidates(callerRepo: string, ctx: SuggestContext): Candidate[] {
  // The caller's own repo only when the join found two of its own entries could answer.
  const manifest = estateRepos(ctx.op).filter((r) => r.id !== callerRepo || !!ctx.only);
  const systems = ctx.op.profiles.flatMap((p) => p.profile?.systems ?? []);
  const reposOfSystem = new Map<string, number>();
  for (const r of estateRepos(ctx.op))
    if (r.system) reposOfSystem.set(r.system, (reposOfSystem.get(r.system) ?? 0) + 1);
  const read = new Set((ctx.estate ?? []).filter((x) => x.facts.length > 0).map((x) => x.repo));
  const repoOf = new Map<string, string>();
  for (const r of ctx.records) if (r.kind === "Component" && r.repo) repoOf.set(r.id, r.repo);
  if (!ctx.estate) for (const repo of repoOf.values()) read.add(repo);
  const endpoints = ctx.records.filter(
    (r): r is Extract<CatalogRecord, { kind: "Endpoint" }> => r.kind === "Endpoint",
  );
  const deploys = (ctx.estate ?? []).flatMap((x) =>
    x.facts.filter((f): f is FactOf<"deploy"> => f.kind === "deploy" && !!f.basePath),
  );
  const out: Candidate[] = [];
  for (const m of manifest) {
    const own = new Set(
      [m.id, m.component, ...m.modules.map((x) => x.component)]
        .filter((x): x is string => !!x)
        .map(factIdPart),
    );
    const sys =
      m.system && reposOfSystem.get(m.system) === 1
        ? systems.find((s) => s.id === m.system)
        : undefined;
    const names = new Map<string, string>();
    for (const n of [m.id, m.component, ...m.modules.map((x) => x.component)])
      for (const w of nameWords(n)) if (!names.has(w)) names.set(w, n!);
    for (const a of sys ? [sys.id, ...sys.aliases] : [])
      for (const w of nameWords(a)) if (!names.has(w)) names.set(w, a);
    const bases: Candidate["bases"] = [];
    if (m.basePath) bases.push({ path: m.basePath, from: "the manifest's basePath" });
    for (const x of m.modules)
      if (x.basePath)
        bases.push({ path: x.basePath, from: `the basePath of its module ${x.component}` });
    for (const d of deploys) {
      const reaches = d.exposes ? factIdPart(d.exposes) : d.repo === m.id ? m.id : undefined;
      if (!reaches || !(own.has(reaches) || (d.repo === m.id && !d.exposes))) continue;
      const what =
        d.platform === "apigee"
          ? "its proxy's BasePath"
          : `the ${d.resourceType ?? "route"} ${d.resourceName ?? d.id}`;
      bases.push({ path: d.basePath!, from: `${what} (${d.repo} ${d.cite.file}:${d.cite.line})` });
    }
    // A read repo's components that serve calls: each its own suggestion, as before; one with
    // none is the repo itself.
    const comps = [
      ...new Set(endpoints.filter((e) => repoOf.get(e.component) === m.id).map((e) => e.component)),
    ].sort();
    const isRead = read.has(m.id);
    const forLabel = comps.length ? comps : [m.id];
    for (const label of forLabel) {
      const mine = endpoints.filter((e) => e.component === label);
      const entries = (ctx.estate ?? [])
        .filter((x) => x.repo === m.id)
        .flatMap((x) =>
          x.facts.filter(
            (f): f is FactOf<"entry"> =>
              f.kind === "entry" &&
              (!comps.length ||
                factIdPart(f.component ?? m.component ?? m.id) === label ||
                comps.length === 1),
          ),
        )
        .map((f) => ({
          ...(f.method ? { method: f.method.toUpperCase() } : {}),
          path: f.path,
          at: `${f.cite.file}:${f.cite.line}`,
        }));
      for (const e of mine)
        if (!entries.some((x) => x.path === e.pathOrTopic))
          entries.push({
            ...(e.method ? { method: e.method.toUpperCase() } : {}),
            path: e.pathOrTopic,
            at: e.id,
          });
      out.push({
        s: { label, kind: "repo", repo: m.id, read: isRead, score: 0, why: [] },
        names,
        bases,
        entries,
        ...(m.description?.text ? { description: m.description.text } : {}),
        hosts: m.hosts.map((h) => h.toLowerCase()),
      });
    }
  }
  // The join's candidates are components it read: each is offered, whatever the catalog holds.
  for (const c of ctx.only ?? [])
    if (!out.some((x) => x.s.label === c))
      out.push({
        s: {
          label: c,
          kind: "repo",
          repo: repoOf.get(c) ?? callerRepo,
          read: true,
          score: 0,
          why: [],
        },
        names: new Map(),
        bases: [],
        entries: [],
        hosts: [],
      });
  const own = new Set(estateRepos(ctx.op).flatMap((r) => (r.system ? [r.system] : [])));
  const seen = new Set<string>();
  for (const s of systems) {
    if (!(s.boundary === "vendor" || !own.has(s.id)) || seen.has(s.id)) continue;
    seen.add(s.id);
    const names = new Map<string, string>();
    for (const n of [s.id, s.name, ...s.aliases])
      for (const w of nameWords(n)) if (!names.has(w)) names.set(w, n);
    out.push({
      s: {
        label: s.id,
        kind: "outside",
        read: false,
        name: s.name,
        boundary: s.boundary,
        score: 0,
        why: [],
      },
      names,
      bases: [],
      entries: [],
      hosts: s.aliases.map((a) => a.toLowerCase()),
    });
  }
  return out;
}

/**
 * The suggestions for one call, every candidate scored, best first: the evidence above, each
 * reason with its weight. A candidate with no evidence scores 0; the question offers it only to
 * fill the list with read repos that serve the call's type and outside systems, as before.
 */
export function targetSuggestions(f: FactOf<"call">, ctx: SuggestContext): TargetSuggestion[] {
  const all = candidates(f.repo, ctx);
  // A word most candidates' names share (the estate's prefix) says nothing about any one.
  const df = new Map<string, number>();
  for (const c of all) for (const w of c.names.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const telling = (w: string) => (df.get(w) ?? 0) <= Math.max(2, Math.floor(all.length / 3));
  const host = hostOf(f, ctx.facts)?.toLowerCase();
  const client = clientOf(f);
  const said: { from: string; words: string[]; weight: number }[] = [
    { from: f.base ? `the config key ${f.base}` : "", words: nameWords(f.base), weight: 4 },
    { from: client ? `the client ${client}` : "", words: nameWords(client), weight: 4 },
    {
      from: host ? `the host label ${host.split(".")[0]} (${host})` : "",
      words: host ? nameWords(host.split(".")[0]) : [],
      weight: 4,
    },
    {
      from: `the path ${f.path}`,
      words: nameWords(
        segs(f.path)
          .filter((x) => x !== "{}")
          .join(" "),
      ),
      weight: 2,
    },
  ].filter((x) => x.from && x.words.length);
  const method = f.method?.toUpperCase();
  const earlier = (ctx.questions ?? []).filter(
    (q) =>
      q.askedBy?.step === TARGETS_STEP_ID &&
      q.state === "answered" &&
      q.repo === f.repo &&
      !q.evidence.includes(`${f.cite.file}:${f.cite.line}`),
  );
  const only = ctx.only ? new Set(ctx.only) : undefined;
  const out: TargetSuggestion[] = [];
  for (const c of all) {
    if (only && c.s.kind === "repo" && !only.has(c.s.label)) continue;
    const s: TargetSuggestion = { ...c.s, why: [] };
    const add = (n: number, why: string) => {
      s.score += n;
      s.why.push(why);
    };
    if (only?.has(c.s.label)) add(6, "the join found an entry of it that serves the call");
    const hit = c.entries.find(
      (e) =>
        (!method || !e.method || e.method === method || e.method === "ANY") &&
        serves(
          e.path,
          f.path,
          c.bases.map((b) => b.path),
        ),
    );
    if (hit && !only) {
      const what = [hit.method, hit.path].filter(Boolean).join(" ");
      add(6, `serves ${what} (${hit.at})`);
      s.serves = [what];
    }
    const base = c.bases.find((b) => under(f.path, b.path));
    if (base) add(5, `its basePath ${base.path} matches: ${base.from}`);
    if (host && c.hosts.includes(host)) add(8, `it lists ${host} under hosts`);
    for (const x of said) {
      const w = x.words.find((y) => c.names.has(y) && telling(y));
      if (w) add(x.weight, `named like ${x.from}`);
    }
    if (c.description) {
      const d = new Set(nameWords(c.description));
      const w = said.flatMap((x) => x.words).find((y) => d.has(y) && telling(y));
      if (w) add(2, `its description mentions ${w}`);
    }
    const named = earlier.filter((q) => {
      const l = answerLabel(q);
      if (!l || NOT_A_TARGET.has(l)) return false;
      const t = slugify(l);
      return t === slugify(c.s.label) || (!!c.s.repo && t === slugify(c.s.repo));
    }).length;
    if (named) add(3, `picked for ${named} other ${named === 1 ? "call" : "calls"} of ${f.repo}`);
    if (!s.score) s.why.push(TARGETS_NO_EVIDENCE);
    s.why = [...new Set(s.why)];
    out.push(s);
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.read) - Number(a.read) ||
      (a.kind === b.kind ? 0 : a.kind === "repo" ? -1 : 1) ||
      cmpText(a.label, b.label),
  );
}

/**
 * The suggestions a question offers, bounded: those the evidence names (best first), filled up to
 * the bound with the read repos that serve the call's type and the outside systems, as the
 * question always offered them. An unread repo with no evidence is left to "Another repo…".
 */
export function offeredSuggestions(
  ranked: readonly TargetSuggestion[],
  o: { types: ReadonlySet<string>; serving: ReadonlySet<string>; max?: number },
): TargetSuggestion[] {
  const max = o.max ?? TARGETS_MAX_SUGGESTED;
  const strong = ranked.filter((s) => s.score >= 2);
  const fill = ranked.filter(
    (s) => s.score < 2 && (s.kind === "outside" || (s.read && o.serving.has(s.label))),
  );
  return [...strong, ...fill].slice(0, max);
}

/** One entry of the "Another repo…" picker. */
export interface TargetPick {
  id: string;
  kind: "repo" | "system" | "team";
  name: string;
  /** A repo: read yet. */
  read?: boolean;
  /** A system: vendor, internal or product. */
  boundary?: string;
  /** A team with no system yet: the system the answer would add to the profile. */
  adds?: { id: string; name: string; boundary: "internal"; owner: string };
}

/**
 * The "Another repo…" picker (ADR 0162, F8): every repo of the manifest, read or not; every
 * system of the profiles (vendors, other teams', our own); and every team in roles.yaml, each
 * with no system of its own named so naming it adds one (boundary internal, owner the team).
 */
export function targetPicker(op: OrgPack, read: ReadonlySet<string> = new Set()): TargetPick[] {
  const repos: TargetPick[] = estateRepos(op)
    .map((r) => ({
      id: r.id,
      kind: "repo" as const,
      name: r.component && r.component !== r.id ? `${r.id} (${r.component})` : r.id,
      read: read.has(r.id),
    }))
    .sort((a, b) => cmpText(a.id, b.id));
  const seen = new Set<string>();
  const systems: TargetPick[] = op.profiles
    .flatMap((p) => p.profile?.systems ?? [])
    .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
    .map((s) => ({ id: s.id, kind: "system" as const, name: s.name, boundary: s.boundary }))
    .sort((a, b) => cmpText(a.id, b.id));
  const owned = new Set(
    op.profiles.flatMap((p) =>
      (p.profile?.systems ?? []).flatMap((s) => (s.owner ? [s.owner] : [])),
    ),
  );
  const teams: TargetPick[] = (op.roles?.teams ?? [])
    .map((t) => {
      const name = t.name ?? t.id;
      const has = owned.has(t.id);
      return {
        id: t.id,
        kind: "team" as const,
        name,
        ...(has
          ? {}
          : {
              adds: {
                id: slugify(`${t.id}-system`),
                name: `${name}'s system`,
                boundary: "internal" as const,
                owner: t.id,
              },
            }),
      };
    })
    .sort((a, b) => cmpText(a.id, b.id));
  return [...repos, ...systems, ...teams];
}

/** The picker as lines a person reads in the terminal. */
export function pickerLines(picks: readonly TargetPick[]): string[] {
  const of = (k: TargetPick["kind"]) => picks.filter((p) => p.kind === k);
  return [
    `Repos (${of("repo").length}): ${
      of("repo")
        .map((p) => `${p.id}${p.read ? "" : " (not read yet)"}`)
        .join(", ") || "none"
    }`,
    `Systems (${of("system").length}): ${
      of("system")
        .map((p) => `${p.id} (${p.boundary})`)
        .join(", ") || "none"
    }`,
    `Teams (${of("team").length}): ${
      of("team")
        .map((p) => `${p.id}${p.adds ? " (no system yet)" : ""}`)
        .join(", ") || "none"
    }`,
  ];
}

/**
 * ADR 0162 (F8): one question per topic or queue the repo publishes to or listens on that is
 * still a loose end after the merge (no estate repo serves the other side, and no system of the
 * profile names it): who owns it. Its first option opens the picker of systems and teams; the
 * answer adds the topic under that system's topics (or adds the system, owner the team), so the
 * next write lands the publish or the listener on it, declared.
 */
export function topicQuestionDrafts(
  repo: string,
  records: readonly CatalogRecord[],
): { topic: string; id: string; draft: QuestionDraft }[] {
  const out = new Map<string, { topic: string; id: string; draft: QuestionDraft }>();
  for (const r of records) {
    if (r.kind !== "Unresolved") continue;
    const x = r as unknown as {
      unresolvedKind: string;
      raw: string;
      owner?: string;
      evidence: { repo?: string; path?: string; line?: number; source: string }[];
    };
    if (x.unresolvedKind !== "event-publish" && x.unresolvedKind !== "event-subscribe") continue;
    const topic = String(x.raw);
    if (!topic || topic.includes("${") || /\s/.test(topic)) continue;
    const ev = x.evidence
      .filter((e) => e.repo === repo && e.path && e.line && !/[\s:]/.test(e.path))
      .map((e) => `${e.path}:${e.line}`)
      .sort();
    if (!ev.length) continue;
    const side = x.unresolvedKind === "event-publish" ? "publish" : "listen";
    const question = topicQuestionText(topic, x.owner ?? repo, side);
    const draft = {
      question,
      options: [
        {
          label: TOPICS_OUTSIDE_LABEL,
          means: `${topic} belongs to another team's system or a vendor's: name it, or the team, from the list`,
          changes: `${topic} is added under that system's topics in the profile (or the system is added, owner the team), as a file change for review; the next write ${side === "publish" ? "sends the publish to it" : "takes the listener's messages from it"}, marked as your word`,
        },
        {
          label: "None of these",
          means: `Nothing outside the estate owns ${topic}, or a repo not read yet serves it`,
          changes: `It stays a loose end, and this isn't asked again`,
        },
      ],
      evidence: [...new Set(ev)],
      scope: "repo" as const,
    };
    const id = questionId({ step: TOPICS_STEP_ID, repo, question, evidence: draft.evidence });
    if (!out.has(id)) out.set(id, { topic, id, draft });
  }
  return [...out.values()].sort((a, b) => cmpText(a.topic, b.topic));
}
