import {
  hostMatches,
  hostQuestionText,
  HOSTS_NONE,
  urlHostPort,
  type CatalogRecord,
  type QuestionDraft,
} from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";

/**
 * Hosts asked, not hand-written (ADR 0088): each host the estate's calls name (from a client
 * base or a literal URL) that no repo lists in its manifest `hosts` becomes one question,
 * "Which repo answers on localhost:9966?", with the repos that serve HTTP as options. When one
 * of them has a config line that sets the port the calls use (server.port=9966), it is the
 * first option, and its line is said. Deterministic: it reads the catalog's loose calls and the
 * repos' config files only.
 */

export interface HostRepo {
  id: string;
  component?: string;
  hosts: readonly string[];
  modules?: readonly { component: string; hosts: readonly string[] }[];
  /** What the repo is, in a person's words (ADR 0128), so the options can be told apart. */
  description?: { text: string; trust: "suggested" | "verified" };
}

export interface HostAsk {
  /** The host as the calls name it, with the port when they name one: localhost:9966. */
  host: string;
  /** The calls to it, repo and path:line, in order. */
  calls: { repo: string; at: string }[];
  /** The repos that serve HTTP, the suggested one first, then by id. */
  servers: string[];
  /** The repo whose config sets the port, when exactly one does. */
  suggest?: { repo: string; at: string; line: string };
  /**
   * What each repo of `servers` is, in a person's words (ADR 0128), so a person choosing between
   * two opaque ids reads what they are. A draft nobody has confirmed is marked.
   */
  about?: Record<string, { text: string; trust: "suggested" | "verified" }>;
}

/** Entry point types a call over HTTP reaches. */
const HTTP_TYPES = new Set(["rest", "graphql", "soap", "websocket", "sse", "webhook"]);

/** The files a service's port is usually set in. */
const CONFIG_FILES = [
  "**/application*.properties",
  "**/application*.yml",
  "**/application*.yaml",
  "**/bootstrap*.properties",
  "**/bootstrap*.yml",
  "**/bootstrap*.yaml",
  "**/.env",
  "**/.env.*",
  "**/Dockerfile",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/compose*.yml",
  "**/compose*.yaml",
  "**/package.json",
];

/** Whether a config line sets this port: port=9966, port: 9966, EXPOSE 9966, --port 9966, "9966:8080". */
export function lineSetsPort(line: string, port: number): boolean {
  const p = String(port);
  const end = "(?![0-9])";
  return [
    new RegExp(`port["']?\\s*[:=]\\s*["']?${p}${end}`, "i"),
    new RegExp(`^\\s*EXPOSE\\s+(?:[0-9]+(?:/[a-z]+)?\\s+)*${p}${end}`, "i"),
    new RegExp(`--port[=\\s]+${p}${end}`, "i"),
    new RegExp(`(?:^|[\\s"'-])${p}:[0-9]+`),
  ].some((re) => re.test(line));
}

/** The host and explicit port of a call's URL, as the question names it. */
function callHost(url: string): { label: string; host: string; port?: number } | undefined {
  if (url.includes("${")) return undefined;
  const hp = urlHostPort(url);
  if (!hp || !hp.host) return undefined;
  const explicit = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@?#]*@)?[^/:?#]+:(\d+)/i.exec(url);
  return {
    label: explicit ? `${hp.host}:${explicit[1]}` : hp.host,
    host: hp.host,
    ...(hp.port !== undefined ? { port: hp.port } : {}),
  };
}

/** The hosts the estate's loose calls name that no repo lists, each with what to ask. */
export async function unknownHosts(o: {
  records: readonly CatalogRecord[];
  repos: readonly HostRepo[];
  /** A repo's clone, to read its config for the port; undefined when there is none. */
  handle: (repo: string) => RepoHandle | undefined;
}): Promise<HostAsk[]> {
  const patterns = o.repos.flatMap((r) => [
    ...r.hosts,
    ...(r.modules ?? []).flatMap((m) => m.hosts),
  ]);
  const byHost = new Map<string, { port?: number; explicit: boolean; calls: HostAsk["calls"] }>();
  for (const r of o.records) {
    if (r.kind !== "Unresolved" || r.unresolvedKind !== "http-call") continue;
    const url = r.raw.slice(r.raw.indexOf(" ") + 1);
    const h = callHost(url);
    if (!h) continue;
    if (patterns.some((p) => hostMatches(p, h.host, h.port))) continue;
    const e = r.evidence[0];
    const repo = e?.repo ?? r.owner;
    if (!e?.path || e.line === undefined || !repo) continue;
    const entry = byHost.get(h.label) ?? {
      ...(h.port !== undefined ? { port: h.port } : {}),
      explicit: h.label !== h.host,
      calls: [],
    };
    const at = `${e.path}:${e.line}`;
    if (!entry.calls.some((c) => c.repo === repo && c.at === at)) entry.calls.push({ repo, at });
    byHost.set(h.label, entry);
  }
  if (byHost.size === 0) return [];

  // The repos that serve HTTP: a component of theirs has an HTTP entry point.
  const compRepo = new Map<string, string>();
  for (const r of o.repos) {
    compRepo.set(r.component ?? r.id, r.id);
    for (const m of r.modules ?? []) compRepo.set(m.component, r.id);
  }
  const serving = new Set<string>();
  for (const r of o.records)
    if (r.kind === "Endpoint" && HTTP_TYPES.has(r.endpointType)) {
      const repo = compRepo.get(r.component);
      if (repo) serving.add(repo);
    }
  const servers = [...serving].sort();

  // Each serving repo's config lines, read once.
  const configs = new Map<string, { path: string; lines: string[] }[]>();
  const configOf = async (repo: string) => {
    if (configs.has(repo)) return configs.get(repo)!;
    const h = o.handle(repo);
    const out: { path: string; lines: string[] }[] = [];
    if (h)
      for await (const path of h.listFiles(CONFIG_FILES)) {
        const t = await h.readText(path).catch(() => undefined);
        if (t !== undefined) out.push({ path, lines: t.replace(/\r\n?/g, "\n").split("\n") });
      }
    configs.set(repo, out);
    return out;
  };

  const asks: HostAsk[] = [];
  for (const [host, entry] of [...byHost.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (servers.length === 0) continue;
    const hits: NonNullable<HostAsk["suggest"]>[] = [];
    if (entry.explicit && entry.port !== undefined)
      for (const repo of servers) {
        hit: for (const f of await configOf(repo))
          for (const [i, l] of f.lines.entries())
            if (lineSetsPort(l, entry.port)) {
              hits.push({ repo, at: `${f.path}:${i + 1}`, line: l.trim() });
              break hit;
            }
      }
    const suggest = hits.length === 1 ? hits[0] : undefined;
    const calls = entry.calls.sort(
      (a, b) => a.repo.localeCompare(b.repo) || a.at.localeCompare(b.at, "en", { numeric: true }),
    );
    const about = Object.fromEntries(
      servers.flatMap((s) => {
        const d = o.repos.find((r) => r.id === s)?.description;
        return d ? [[s, { text: d.text, trust: d.trust }] as const] : [];
      }),
    );
    asks.push({
      host,
      calls,
      servers: suggest ? [suggest.repo, ...servers.filter((s) => s !== suggest.repo)] : servers,
      ...(suggest ? { suggest } : {}),
      ...(Object.keys(about).length ? { about } : {}),
    });
  }
  return asks;
}

/**
 * What an option's repo is, in a person's words (ADR 0128), after what the code says about it. A
 * draft nobody has confirmed is said to be one, so nobody reads it as a person's words.
 */
function aboutOf(a: HostAsk, repo: string): string {
  const d = a.about?.[repo];
  if (!d) return "";
  return d.trust === "suggested"
    ? `. What it is, as your assistant drafted it (unconfirmed): ${d.text}`
    : `. What it is: ${d.text}`;
}

/**
 * The question for each host (ADR 0078 question drafts), raised in the repo that makes the
 * first call; its evidence is up to three of that repo's calls.
 */
export function hostQuestionDrafts(
  asks: readonly HostAsk[],
): { repo: string; draft: QuestionDraft }[] {
  return asks.map((a) => {
    const repo = a.calls[0]!.repo;
    return {
      repo,
      draft: {
        question: hostQuestionText(a.host),
        options: [
          ...a.servers.map((s) => ({
            label: s,
            means:
              (a.suggest?.repo === s
                ? `${s} serves HTTP, and its ${a.suggest.at} sets the port ${a.host.split(":").pop()} (${a.suggest.line})`
                : `${s} serves HTTP`) + aboutOf(a, s),
            changes: `${a.host} goes under hosts for ${s} in repos.manifest.yaml, and the calls to it join ${s} on the next scan`,
          })),
          {
            label: HOSTS_NONE,
            means: `An outside system answers on ${a.host}, not a repo of this estate`,
            changes:
              "Nothing is added to the manifest; the calls stay loose ends, and this isn't asked again",
          },
        ],
        evidence: a.calls
          .filter((c) => c.repo === repo)
          .slice(0, 3)
          .map((c) => c.at),
        scope: "repo",
      },
    };
  });
}
