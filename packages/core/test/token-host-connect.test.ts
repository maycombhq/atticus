import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  forwardHostQuestion,
  joinFacts,
  joinRecords,
  linkCandidates,
  pairScore,
  parseFacts,
  type CandidateApi,
  type Fact,
  type FactsJoinResult,
  type JoinRepo,
} from "../src/index.js";

/**
 * Beta.28.1 (a user's field report 4, re-made with invented names in
 * `fixtures/gateway-facts/token-host/`): a proxy's forwarding calls all go to a target URL whose
 * host is a deploy token nothing sets (`@forgeTargetUrl@/forge-instruments/1.0/instruments`), in
 * front of a Spring Boot service whose routes sit under `/{moduleName:.+}/{moduleApiVersion:.+}`
 * and which no System of the profile names. Connect to… said "Every call of this repo joins
 * something already" while no arrow was drawn: the person could pair nothing from the app.
 *
 * The rules: the join asks about a token host nothing sets (it never guesses by path, nor places
 * the call outside); Connect lists every call that has no arrow drawn as loose, and a call that
 * has one as movable, never hidden; the suggestions match a path's tail past Spring's variables.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const URL = "@forgeTargetUrl@/forge-instruments/1.0/instruments";
const CALLS = [
  "call.get.instruments-id",
  "call.get.instruments-ping",
  "call.post.instruments",
  "call.post.instruments-id-status",
];
/** Each call and the service's entry it is, by hand. */
const MEANT: Record<string, string> = {
  "call.get.instruments-ping": "entry.get.instruments-ping",
  "call.post.instruments": "entry.post.instruments",
  "call.get.instruments-id": "entry.get.instruments-instrumentid",
  "call.post.instruments-id-status": "entry.post.instruments-instrumentid-status",
};

const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
type ManifestRepo = { id: string; type: string; component?: string; hosts?: string[] };
const estate = (): JoinRepo[] =>
  (
    parse(
      readFileSync(join(DIR, "org-pack", "profiles", "forge", "repos.manifest.yaml"), "utf8"),
    ) as { repos: ManifestRepo[] }
  ).repos.map((r) => ({
    repo: r.id,
    facts: read(r.id),
    ...(r.component ? { component: r.component } : {}),
    ...(r.hosts ? { hosts: r.hosts } : {}),
    ...(r.type === "gateway" ? { gateway: true } : {}),
  }));
const swap = (repos: JoinRepo[], repo: string, f: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: f([...r.facts]) } : r));
const calls = (fs: Fact[], f: (c: Fact & { kind: "call" }) => Fact) =>
  fs.map((x) => (x.kind === "call" ? f(x) : x));

const serviceApis = (): CandidateApi[] =>
  read(SERVICE).flatMap((f) =>
    f.kind === "entry"
      ? [
          {
            id: f.id,
            kind: "entry" as const,
            ...(f.method ? { method: f.method } : {}),
            path: f.path!,
            at: `${f.cite.file}:${f.cite.line}`,
          },
        ]
      : [],
  );
const fromProxy = (out: FactsJoinResult) => ({
  joins: out.joins.filter((j) => j.call.repo === PROXY),
  outside: (out.outside ?? []).filter((o) => o.call.repo === PROXY),
  asks: out.asks.filter((a) => a.call.repo === PROXY),
});

describe("the join: a forwarding call to a token host nothing sets is asked, never guessed", () => {
  const asked = (repos: JoinRepo[], host = URL) => {
    const out = joinFacts({ repos, explain: true });
    const p = fromProxy(out);
    expect(p.joins).toEqual([]);
    expect(p.outside).toEqual([]);
    expect(p.asks.map((a) => [a.call.fact, a.reason, a.host]).sort()).toEqual(
      CALLS.map((c) => [c, "unknown-host", host]),
    );
    for (const a of p.asks) expect(a.question).toBe(forwardHostQuestion(host, PROXY));
    // No arrow from the proxy at all: nothing to say "joins something already" about.
    const recs = joinRecords(out, repos) as unknown as { kind: string; from?: string }[];
    expect(recs.filter((r) => r.kind === "Interface" && r.from === "instruments-proxy")).toEqual(
      [],
    );
    return out;
  };

  it("as read: the host the `<URL>` as written, the path after the token in front of the route's", () => {
    asked(estate());
  });

  it("with only the token as the host", () => {
    asked(
      swap(estate(), PROXY, (fs) => calls(fs, (c) => ({ ...c, host: "@forgeTargetUrl@" }))),
      "@forgeTargetUrl@",
    );
  });

  it("with no host, the token only on the `<URL>` line its citation names", () => {
    asked(
      swap(estate(), PROXY, (fs) =>
        calls(fs, (c) => {
          const { host: _h, ...rest } = c;
          return rest as Fact;
        }),
      ),
    );
  });

  it("in a repo the manifest doesn't type gateway (its bundle says it is one)", () => {
    asked(estate().map((r) => (r.repo === PROXY ? { ...r, gateway: false } : r)));
  });

  it("in a repo neither typed gateway nor laid out as a bundle: a deploy token's host is still asked", () => {
    // The proxy's files read from a folder no bundle convention names (src/gateway/...): its calls
    // aren't known as forwarding calls, and a `@token@` host nothing sets was joined by its path
    // to whichever entry served it (a guess the owner never asked for).
    const moved = (f: Fact): Fact => ({
      ...f,
      cite: {
        ...f.cite,
        file: f.cite.file.replace("apiproxy/", "src/gateway/"),
        ...(f.cite.with
          ? {
              with: f.cite.with.map((w) => ({
                ...w,
                file: w.file.replace("apiproxy/", "src/gateway/"),
              })),
            }
          : {}),
      },
    });
    const repos = swap(estate(), PROXY, (fs) => fs.map(moved)).map((r) =>
      r.repo === PROXY ? { ...r, gateway: false } : r,
    );
    const out = joinFacts({ repos, explain: true });
    const p = fromProxy(out);
    expect(p.joins).toEqual([]);
    expect(p.outside).toEqual([]);
    expect(p.asks.map((a) => [a.call.fact, a.reason, a.host]).sort()).toEqual(
      CALLS.map((c) => [c, "unknown-host", URL]),
    );
  });
});

describe("how likely a call is an API, past Spring's path variables", () => {
  it("matches the tail after `{name:regex}` segments, and a literal over a variable", () => {
    const ping = pairScore(
      { method: "GET", path: "/forge-instruments/1.0/instruments/ping" },
      { method: "GET", path: "/{moduleName:.+}/{moduleApiVersion:.+}/instruments/ping" },
    );
    const asId = pairScore(
      { method: "GET", path: "/forge-instruments/1.0/instruments/ping" },
      { method: "GET", path: "/{moduleName:.+}/{moduleApiVersion:.+}/instruments/{instrumentId}" },
    );
    expect(ping).toEqual({ score: 0.9, why: "prefix" });
    expect(asId!.score).toBeLessThan(0.7);
    // As before: a parameter's shape alone, every literal the same.
    expect(pairScore({ path: "/a/${x}" }, { path: "/a/b" })).toEqual({
      score: 0.75,
      why: "parameter",
    });
  });
});

describe("Connect to… from the proxy's box", () => {
  const cands = (out: FactsJoinResult, o: Partial<Parameters<typeof linkCandidates>[0]> = {}) =>
    linkCandidates({
      from: PROXY,
      facts: read(PROXY),
      join: out,
      apis: serviceApis(),
      to: { repo: SERVICE },
      ...o,
    });

  it("lists every asked call loose, each with the service's entry it is, sure of each", () => {
    const c = cands(joinFacts({ repos: estate(), explain: true }));
    expect(c.calls.map((x) => [x.fact, x.status]).sort()).toEqual(CALLS.map((x) => [x, "asked"]));
    for (const x of c.calls) {
      expect(x.suggestion?.api, x.fact).toBe(MEANT[x.fact]);
      expect(x.confident, x.fact).toBe(true);
    }
  });

  it("lists a call the join places outside, to a name nothing draws, as loose (it was hidden)", () => {
    // The host question answered with a name that is no repo, component or system of the estate:
    // the join leaves the calls outside to it, which no box of the canvas is.
    const targets = { [PROXY]: Object.fromEntries(CALLS.map((c) => [c, "Northwind Instruments"])) };
    const out = joinFacts({ repos: estate(), targets, explain: true });
    expect(fromProxy(out).outside.length).toBe(4);
    const c = cands(out);
    expect(c.calls.map((x) => [x.fact, x.status, x.joins]).sort()).toEqual(
      CALLS.map((x) => [x, "outside", "Northwind Instruments"]),
    );
    expect(c.calls.every((x) => x.suggestion?.api === MEANT[x.fact])).toBe(true);
    // An outside system the canvas draws takes the call: it has an arrow, and is movable.
    const drawn = cands(out, { drawnOutside: (t) => t === "Northwind Instruments" });
    expect(drawn.calls.map((x) => x.status)).toEqual(Array(4).fill("joined"));
    expect(drawn.calls.some((x) => x.confident)).toBe(false);
  });

  it("lists a call joined to something no arrow draws as loose, and one with an arrow as movable", () => {
    const pairs = {
      [PROXY]: Object.fromEntries(
        CALLS.map((c) => [c, { repo: SERVICE, entry: MEANT[c]!, path: "/x", by: "pat" }]),
      ),
    };
    const out = joinFacts({ repos: estate(), pairs, explain: true });
    expect(fromProxy(out).joins.length).toBe(4);
    // No Interface of these on the canvas yet (the catalog not built since): loose, said where.
    const none = cands(out, { drawn: () => false, to: { repo: "forge-other" } });
    expect(none.calls.map((x) => [x.status, x.joins])).toEqual(Array(4).fill(["undrawn", SERVICE]));
    // Drawn: listed as joined, to move them to this box, never ticked for it unseen.
    const moved = cands(out, { drawn: () => true, to: { repo: "forge-other" } });
    expect(moved.calls.map((x) => [x.status, x.joins])).toEqual(Array(4).fill(["joined", SERVICE]));
    expect(moved.calls.some((x) => x.confident)).toBe(false);
    // Paired with this very box: listed paired, to undo, as before.
    const here = cands(out, { pairs: pairs[PROXY] });
    expect(here.calls.map((x) => x.status)).toEqual(Array(4).fill("paired"));
  });

  it("a join of a call to its own component is never an arrow: loose", () => {
    const self = joinFacts({ repos: estate(), explain: true });
    const fake: FactsJoinResult = {
      ...self,
      asks: [],
      joins: self.asks.map((a) => ({
        call: a.call,
        entry: { ...a.call, fact: "entry.get.forge-instruments-v1-instruments-ping" },
        how: "path",
        callType: "rest",
        path: "/x",
        interface: `if-${a.call.fact}`,
      })),
    };
    const c = cands(fake);
    expect(c.calls.map((x) => [x.status, x.joins])).toEqual(Array(4).fill(["undrawn", PROXY]));
  });
});
