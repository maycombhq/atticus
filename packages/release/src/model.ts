import type { RecordOf } from "@maycombhq/core";
import {
  docOf,
  hopNotes,
  hopRoutes,
  normalizePath,
  readDataChanges,
  readHops,
  sectionLines,
  type DataChange,
  type Doc,
  type Hop,
} from "@maycombhq/naysayer";
import type { ReleaseContext } from "./context.js";

/**
 * The change as the release views see it: each hop of interfaces.md resolved against the
 * catalog (which repo, which system, which gateway route, which topic), and the repos that
 * hold components, gateway proxies and topic definitions. Shared by the plan and the security
 * review so they never disagree.
 */

export type Boundary = "product" | "internal" | "vendor";

export interface ResolvedHop extends Hop {
  /** planned-new, planned-modify or planned-retire (from interfaces.md, else change.yaml). */
  change: string;
  record?: RecordOf<"Interface">;
  /** Gateway routes the hop goes through (catalog or notes). */
  routes: string[];
  /** Routes the catalog doesn't know yet: new proxies this change needs. */
  newRoutes: string[];
  callerRepo?: string;
  calleeRepo?: string;
  callerSystem?: string;
  calleeSystem?: string;
  callerBoundary?: Boundary;
  calleeBoundary?: Boundary;
  /** The topic, when the hop is an event. */
  topic?: string;
  newTopic: boolean;
  notes: { n: number; text: string }[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const sortStrings = (xs: Iterable<string>) => [...new Set(xs)].sort(cmp);

export interface Model {
  hops: ResolvedHop[];
  data: DataChange[];
  repoOfComponent(id: string): string | undefined;
  componentsOfRepo(repo: string): string[];
  systemOf(id: string): string | undefined;
  boundaryOf(system: string | undefined): Boundary | undefined;
  systemName(system: string): string;
  /** The repo that holds gateway proxies, from existing routes' evidence or the manifest. */
  gatewayRepo?: string;
  /** The repo that holds topic definitions, from existing topics' evidence or the manifest. */
  eventsRepo?: string;
  /** The component that owns a data store, and its repo. */
  storeOwner(store: string): { component?: string; repo?: string };
}

const EVENT = /^(publish|subscribe|emit|event|consume)$/i;

export function buildModel(ctx: ReleaseContext): Model {
  const profileSystems = new Map(
    ctx.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []).map((s) => [s.id, s]),
  );
  const repoOfComponent = (id: string): string | undefined =>
    ctx.get("Component", id)?.repo ??
    ctx.repos.find((r) => (r.component ?? r.id) === id)?.id ??
    ctx.repos.find((r) => r.id === id)?.id;
  const componentsOfRepo = (repo: string): string[] => {
    const r = ctx.repos.find((x) => x.id === repo);
    return sortStrings([
      ...(r?.component ? [r.component] : []),
      ...ctx
        .all("Component")
        .filter((c) => c.repo === repo)
        .map((c) => c.id),
    ]);
  };
  const systemOf = (id: string): string | undefined => {
    const c = ctx.get("Component", id);
    if (c) return c.system;
    if (ctx.get("System", id) || profileSystems.has(id)) return id;
    const t = ctx.get("Table", id);
    if (t?.ownerComponent) return systemOf(t.ownerComponent);
    const s = ctx.get("DataStore", id);
    if (s?.ownerComponent) return systemOf(s.ownerComponent);
    return ctx.repos.find((r) => (r.component ?? r.id) === id)?.system;
  };
  const boundaryOf = (s: string | undefined): Boundary | undefined =>
    s ? (ctx.get("System", s)?.boundary ?? profileSystems.get(s)?.boundary) : undefined;
  const systemName = (s: string) => ctx.get("System", s)?.name ?? profileSystems.get(s)?.name ?? s;
  const evidenceRepo = (
    records: { evidence: { source: string; repo?: string }[] }[],
    src: string,
  ) =>
    sortStrings(
      records.flatMap((r) =>
        r.evidence.filter((e) => e.source === src && e.repo).map((e) => e.repo!),
      ),
    )[0];
  const gatewayRepo =
    evidenceRepo(ctx.all("GatewayRoute"), "gateway") ??
    ctx.repos.find((r) => /gateway/i.test(r.type))?.id;
  const topics = ctx.all("Endpoint").filter((e) => e.endpointType === "event-topic");
  const eventsRepo =
    evidenceRepo(topics, "event-config") ?? ctx.repos.find((r) => /event/i.test(r.type))?.id;
  const storeOwner = (store: string) => {
    const component = ctx.get("DataStore", store)?.ownerComponent;
    const repo = component ? repoOfComponent(component) : undefined;
    return { ...(component ? { component } : {}), ...(repo ? { repo } : {}) };
  };

  const touched = new Map(ctx.change.touches.interfaces.map((t) => [t.id, t.status]));
  const hops: ResolvedHop[] = readHops(ctx.files).map((h) => {
    const record = h.id && h.id !== "new" ? ctx.get("Interface", h.id) : undefined;
    const routes = sortStrings([
      ...(record?.route ? [record.route] : []),
      ...hopRoutes(ctx.files, h),
    ]);
    const isEvent =
      ["event-bus", "pubsub", "mq"].includes(record?.via ?? "") ||
      /^A\./.test(h.pattern) ||
      EVENT.test(h.method ?? "");
    const topic = isEvent
      ? (record?.normalizedPath ?? (EVENT.test(h.method ?? "") ? h.path : undefined))
      : undefined;
    const callerSystem = systemOf(h.caller);
    const calleeSystem = systemOf(h.callee);
    const callerRepo = repoOfComponent(h.caller);
    const calleeRepo = repoOfComponent(h.callee);
    const callerBoundary = boundaryOf(callerSystem);
    const calleeBoundary = boundaryOf(calleeSystem);
    return {
      ...h,
      change: /^planned-/.test(h.status) ? h.status : (touched.get(h.id) ?? h.status),
      ...(record ? { record } : {}),
      routes,
      newRoutes: routes.filter((r) => !ctx.get("GatewayRoute", r)),
      ...(callerRepo ? { callerRepo } : {}),
      ...(calleeRepo ? { calleeRepo } : {}),
      ...(callerSystem ? { callerSystem } : {}),
      ...(calleeSystem ? { calleeSystem } : {}),
      ...(callerBoundary ? { callerBoundary } : {}),
      ...(calleeBoundary ? { calleeBoundary } : {}),
      ...(topic ? { topic } : {}),
      newTopic: !!topic && !topics.some((t) => t.pathOrTopic === topic),
      notes: hopNotes(ctx.files, h),
    };
  });
  return {
    hops,
    data: readDataChanges(ctx.files),
    repoOfComponent,
    componentsOfRepo,
    systemOf,
    boundaryOf,
    systemName,
    ...(gatewayRepo ? { gatewayRepo } : {}),
    ...(eventsRepo ? { eventsRepo } : {}),
    storeOwner,
  };
}

/** "POST /transfers" or the topic, for people. */
export const opOf = (h: Hop) => h.operation || (h.path ?? "");

/** The operation's normalised path, for matching against the catalog. */
export const pathKey = (h: Hop) => (h.path ? normalizePath(h.path) : "");

// ------------------------------------------------------------------ sections of a document

export interface FoundSection {
  heading: string;
  /** "design.md:23" */
  source: string;
  text: string;
  lines: { n: number; text: string }[];
}

/** The first section of a change document whose heading matches, with its body. */
export function sectionOf(ctx: ReleaseContext, file: string, re: RegExp): FoundSection | undefined {
  const doc = docOf(ctx.files, file);
  const s = doc?.sections.find((x) => re.test(x.heading));
  if (!doc || !s) return undefined;
  const lines = sectionLines(doc, s);
  return {
    heading: s.heading,
    source: `${file}:${s.line}`,
    text: lines
      .map((l) => l.text)
      .join("\n")
      .trim(),
    lines,
  };
}

/** Every section of a document whose heading matches. */
export function sectionsOf(ctx: ReleaseContext, file: string, re: RegExp): FoundSection[] {
  const doc: Doc | undefined = docOf(ctx.files, file);
  if (!doc) return [];
  return doc.sections
    .filter((x) => re.test(x.heading))
    .map((s) => {
      const lines = sectionLines(doc, s);
      return {
        heading: s.heading,
        source: `${file}:${s.line}`,
        text: lines
          .map((l) => l.text)
          .join("\n")
          .trim(),
        lines,
      };
    });
}

/** Sentences of a block of lines, each with the line it starts on. */
export function sentences(lines: { n: number; text: string }[]): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let cur = "";
  let start = 0;
  const flush = () => {
    const t = cur.trim();
    if (t) out.push({ n: start, text: t });
    cur = "";
  };
  for (const l of lines) {
    const text = l.text.trim();
    if (/^([-*+]|\d+\.)\s+/.test(text) || text.startsWith("|")) {
      flush();
      start = l.n;
      cur = text.replace(/^([-*+]|\d+\.)\s+/, "");
      flush();
      continue;
    }
    for (const part of text.split(/(?<=[.!?])\s+/)) {
      if (!cur) start = l.n;
      cur = cur ? `${cur} ${part}` : part;
      if (/[.!?]$/.test(part)) flush();
    }
  }
  flush();
  return out;
}

/** Whole-word, case-insensitive. */
export function hasWord(text: string, word: string): boolean {
  if (!word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, "i").test(text);
}
