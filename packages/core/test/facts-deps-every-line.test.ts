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
 * Beta.25 review of ADR 0192 (facts version 6): a "depends on" link carries every dependency
 * fact it rests on, so marking one wrong never leaves the arrow standing on another line; a build
 * fact with no component is its build file's module's; a dependency may be `system`-scoped; and a
 * facts file holding a kind a newer Atticus wrote is read, that fact left out and said.
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

  it("draws a system-scoped dependency, as a provided one is", () => {
    const out = joinDependencies({
      repos: [
        lib,
        wallets([dep("d", "wallets-api/pom.xml", 13, { scope: "system" } as Partial<Fact>)]),
      ],
    });
    expect(out.links.map((l) => l.scope)).toEqual(["system"]);
  });
});

describe("the facts file, version 6 (beta.25)", () => {
  it("takes a system scope, and a version-5 file reads unchanged", () => {
    expect(FACTS_SCHEMA_VERSION).toBe(6);
    expect(DEPENDENCY_SCOPES).toContain("system");
    for (const repo of ["forge-ledger", "forge-wallets", "forge-statements"])
      expect(facts(repo).length).toBeGreaterThan(0);
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
