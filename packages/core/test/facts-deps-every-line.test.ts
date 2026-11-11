import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_SCOPES,
  Fact,
  FACTS_SCHEMA_VERSION,
  joinDependencies,
  parseFacts,
  parseFactsLines,
  type JoinRepo,
} from "../src/index.js";

/**
 * Beta.25 review of ADR 0192 (facts version 5 still): a "depends on" link carries every
 * dependency fact it rests on, so marking one wrong never leaves the arrow standing on another
 * line, and every coordinate of one pair of components is one link; a build fact with no
 * component is its build file's module's; and a facts file holding a fact a newer Atticus wrote
 * (a kind, a value or a field this one doesn't know) is read, that fact left out and said.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const lib: JoinRepo = {
  repo: "forge-payments-common",
  component: "payments-common",
  facts: facts("forge-payments-common"),
};
const dep = (id: string, file: string, line: number, extra: Partial<Fact> = {}): Fact =>
  ({
    kind: "dependency",
    id,
    repo: "forge-wallets",
    commit: "2222bbb",
    group: "forge.payments",
    name: "forge-payments-common",
    cite: { file, line, value: "forge-payments-common" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;
const wallets = (fs: Fact[]): JoinRepo => ({
  repo: "forge-wallets",
  component: "wallets-api",
  moduleDirs: [
    { path: "wallets-api", component: "wallets-api" },
    { path: "wallets-batch/", component: "wallets-batch" },
  ],
  facts: fs,
});

describe("a depends-on link carries every dependency fact it rests on (beta.25)", () => {
  // the module's pom, a <profile>'s copy of it, and a runtime one: one link, three lines
  const three = [
    dep("dependency.a", "wallets-api/pom.xml", 13, { component: "wallets-api" } as Partial<Fact>),
    dep("dependency.b", "wallets-api/pom.xml", 31, { component: "wallets-api" } as Partial<Fact>),
    dep("dependency.c", "wallets-api/pom.xml", 40, {
      component: "wallets-api",
      scope: "runtime",
    } as Partial<Fact>),
  ];

  it("lists each one on the link, the first as its from", () => {
    const out = joinDependencies({ repos: [lib, wallets(three)] });
    expect(out.links).toHaveLength(1);
    expect(out.links[0]!.from.fact).toBe("dependency.a");
    expect(out.links[0]!.facts!.map((f) => [f.fact, f.at])).toEqual([
      ["dependency.a", "wallets-api/pom.xml:13"],
      ["dependency.b", "wallets-api/pom.xml:31"],
      ["dependency.c", "wallets-api/pom.xml:40"],
    ]);
  });

  it("keeps the link while one stands, and draws none once each is wrong (left out)", () => {
    const after = (ids: string[]) =>
      joinDependencies({
        repos: [lib, wallets(three.filter((f) => !ids.includes(f.id)))],
      }).links;
    expect(after(["dependency.a"]).map((l) => l.from.fact)).toEqual(["dependency.b"]);
    expect(after(["dependency.a", "dependency.b", "dependency.c"])).toEqual([]);
  });

  it("gives a build fact with no component its build file's module, not the repo's", () => {
    const out = joinDependencies({
      repos: [lib, wallets([dep("dependency.batch", "wallets-batch/pom.xml", 13)])],
    });
    expect(out.links.map((l) => l.from.component)).toEqual(["wallets-batch"]);
    // without the manifest's modules, the repo's component as before
    const bare = joinDependencies({
      repos: [
        lib,
        {
          repo: "forge-wallets",
          component: "wallets-api",
          facts: [dep("d", "wallets-batch/pom.xml", 13)],
        },
      ],
    });
    expect(bare.links.map((l) => l.from.component)).toEqual(["wallets-api"]);
  });
});

describe("every coordinate of one pair of components is one link (review of beta.25)", () => {
  // component kit publishes kit-api and kit-core; wallets-api builds on both
  const kit: JoinRepo = {
    repo: "forge-kit",
    component: "kit",
    facts: (["kit-api", "kit-core"] as const).map(
      (n, i) =>
        ({
          kind: "artifact",
          id: `artifact.${n}`,
          repo: "forge-kit",
          commit: "6666fff",
          group: "forge.kit",
          name: n,
          cite: { file: `${n}/pom.xml`, line: 7 + i, value: n },
          verified: "line",
          by: "assistant",
          conf: "declared",
        }) as Fact,
    ),
  };
  const two = [
    dep("dependency.kit-api", "wallets-api/pom.xml", 13, {
      group: "forge.kit",
      name: "kit-api",
      version: "2.0.0",
    } as Partial<Fact>),
    dep("dependency.kit-core", "wallets-api/pom.xml", 17, {
      group: "forge.kit",
      name: "kit-core",
      scope: "runtime",
    } as Partial<Fact>),
  ];

  it("merges kit-api and kit-core into one link, listing each fact with its coordinates", () => {
    const out = joinDependencies({ repos: [kit, wallets(two)] });
    expect(out.links).toHaveLength(1);
    const l = out.links[0]!;
    expect([l.from.component, l.to.component, l.name]).toEqual(["wallets-api", "kit", "kit-api"]);
    expect(l.facts!.map((f) => [f.fact, f.group, f.name, f.version, f.scope])).toEqual([
      ["dependency.kit-api", "forge.kit", "kit-api", "2.0.0", undefined],
      ["dependency.kit-core", "forge.kit", "kit-core", undefined, "runtime"],
    ]);
    // both publishing lines are on it
    expect(l.published!.map((p) => p.at)).toEqual(["kit-api/pom.xml:7", "kit-core/pom.xml:8"]);
  });

  it("says a merged link's scope only when every fact on it has that scope", () => {
    const runtime = (f: Fact) => ({ ...f, scope: "runtime" }) as Fact;
    // kit-api compile, kit-core runtime: the link says no scope (each fact still says its own)
    const mixed = joinDependencies({ repos: [kit, wallets(two)] }).links[0]!;
    expect(mixed.scope).toBeUndefined();
    expect(mixed.facts!.map((f) => f.scope)).toEqual([undefined, "runtime"]);
    // the first runtime, the second compile: none either
    const first = joinDependencies({
      repos: [kit, wallets([runtime(two[0]!), { ...two[1]!, scope: undefined } as Fact])],
    }).links[0]!;
    expect(first.scope).toBeUndefined();
    // both runtime: the link's scope is runtime
    const both = joinDependencies({ repos: [kit, wallets(two.map(runtime))] }).links[0]!;
    expect(both.scope).toBe("runtime");
    // runtime and provided: none
    const two2 = [runtime(two[0]!), { ...two[1]!, scope: "provided" } as Fact];
    expect(joinDependencies({ repos: [kit, wallets(two2)] }).links[0]!.scope).toBeUndefined();
  });

  it("takes the arrow away only once every coordinate's fact is wrong", () => {
    const after = (ids: string[]) =>
      joinDependencies({ repos: [kit, wallets(two.filter((f) => !ids.includes(f.id)))] }).links;
    expect(after(["dependency.kit-api"]).map((l) => l.name)).toEqual(["kit-core"]);
    expect(after(["dependency.kit-api", "dependency.kit-core"])).toEqual([]);
  });
});

describe("the facts file stays at version 5 (review of beta.25)", () => {
  it("has no system scope: a pom's system is recorded as provided, so beta.24 reads it", () => {
    expect(FACTS_SCHEMA_VERSION).toBe(5);
    expect(DEPENDENCY_SCOPES).not.toContain("system");
    for (const repo of ["forge-ledger", "forge-wallets", "forge-statements"])
      expect(facts(repo).length).toBeGreaterThan(0);
  });

  it("leaves out, one fact at a time, a known kind with a value or a field a newer Atticus wrote", () => {
    const text = readFileSync(join(FIX, "facts", "forge-ledger.jsonl"), "utf8").trim();
    const known = facts("forge-ledger");
    const first = known.find((f) => f.kind === "dependency")!;
    const scope = JSON.stringify({ ...first, id: "dependency.shaded", scope: "shaded" });
    const field = JSON.stringify({ ...first, id: "dependency.classifier", classifier: "tests" });
    const r = parseFacts(`${text}\n${scope}\n${field}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.map((f) => f.id)).toEqual(known.map((f) => f.id));
    expect(r.newer?.map((n) => [n.factId, n.kind])).toEqual([
      ["dependency.shaded", "dependency"],
      ["dependency.classifier", "dependency"],
    ]);
    expect(r.newer![0]!.message).toContain("written by a newer Atticus");
    expect(r.newer![0]!.message).toContain('scope "shaded"');
    expect(r.newer![1]!.message).toContain("field classifier is new to the dependency fact");
    // line by line: kept as written, never a bad line
    const lines = parseFactsLines(`${text}\n${scope}\n${field}\n`);
    expect(lines.bad).toEqual([]);
    expect(lines.newer.map((n) => n.raw)).toEqual([scope, field]);
    // a value that isn't one Atticus would write (a capital, a space) is a wrong fact, as before
    const typo = JSON.stringify({ ...first, id: "dependency.typo", scope: "Compile " });
    expect(parseFacts(`${text}\n${typo}\n`).ok).toBe(false);
    // a missing field is a wrong fact too
    const { group: _g, ...missing } = first as Fact & { group: string };
    expect(parseFactsLines(JSON.stringify(missing)).bad).toHaveLength(1);
  });

  it("leaves out a fact of a kind a newer Atticus wrote, and says so, rather than refusing the file", () => {
    const text = readFileSync(join(FIX, "facts", "forge-ledger.jsonl"), "utf8");
    const newer = JSON.stringify({
      kind: "package",
      id: "package.forge-ledger-ui",
      repo: "forge-ledger",
      commit: "3333ccc",
      cite: { file: "package.json", line: 2, value: "forge-ledger-ui" },
    });
    const r = parseFacts(`${text.trim()}\n${newer}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.map((f) => f.id)).toEqual(facts("forge-ledger").map((f) => f.id));
    expect(r.newer).toEqual([
      {
        line: 4,
        factId: "package.forge-ledger-ui",
        kind: "package",
        message:
          "fact package.forge-ledger-ui is written by a newer Atticus (fact kind package); install it to read this fact",
      },
    ]);
    // the line by line read keeps the line as written, for a writer to keep it
    const lines = parseFactsLines(`${text.trim()}\n${newer}\n`);
    expect(lines.bad).toEqual([]);
    expect(lines.newer.map((n) => n.raw)).toEqual([newer]);
    // a JSON array too
    const arr = parseFacts(JSON.stringify([...facts("forge-ledger"), JSON.parse(newer)]));
    expect(arr.ok && arr.newer?.map((n) => n.kind)).toEqual(["package"]);
    // a known kind that is wrong is still refused
    expect(parseFacts(`{"kind":"dependency","id":"x"}`).ok).toBe(false);
  });
});
