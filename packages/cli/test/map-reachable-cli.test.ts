import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { mapAllCommand, type MapAllPlan } from "../src/map-all.js";
import { mapCommand } from "../src/map-commands.js";
import { loadReadPlan } from "../src/map-parts.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Reachable-first reading of model classes (ADR 0169): `atticus map <repo> --estimate`, a first
 * read in batches, `--gaps`, the rules top-up and `map --all` read the entry points and clients
 * first, then the model classes they reach, and leave out (recorded in the read plan as
 * `notReached`, said by the estimate and verify) the ones nothing reaches; `--models all` reads
 * every one. On the invented forge-house service (fixtures/reachable); files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "reachable");
const REPO = "forge-house";
const COMMIT = "0123abc";
const J = "src/main/java/forge/house";
const REACHED = ["ListingRequest", "ValuationResponse", "Address"].map(
  (n) => `${J}/model/${n}.java`,
);
const UNREACHED = [
  "AgentProfile",
  "InspectionReport",
  "LegacyListing",
  "MortgageQuote",
  "OpenHouseSlot",
].map((n) => `${J}/model/${n}.java`);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-reach-${name}-`));
  temps.push(d);
  return d;
};
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** forge-house adopted in place: its facts under .atticus/facts. */
function adopted(): string {
  const root = temp("adopted");
  cpSync(join(FIX, REPO), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  return root;
}
const io = () => {
  const out: string[] = [];
  return {
    out,
    text: () => out.join("\n"),
    io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) },
  };
};
const facts = (root: string, lines: object[]) =>
  write(
    root,
    `.atticus/facts/${REPO}.jsonl`,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
const ENTRY = {
  kind: "entry",
  id: "entry.post.houses-listings",
  repo: REPO,
  commit: COMMIT,
  entryType: "rest",
  method: "POST",
  path: "/houses/listings",
  cite: {
    file: `${J}/api/HouseController.java`,
    line: 17,
    value: "/listings",
    with: [{ file: `${J}/api/HouseController.java`, line: 9, value: "/houses" }],
  },
};
const estimate = async (root: string, more: Parameters<typeof mapCommand>[2] = {}) => {
  const o = io();
  expect(
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, ...more }, o.io),
    o.text(),
  ).toBe(0);
  return o;
};

describe("atticus map <repo> --estimate reads reachable models first (ADR 0169)", () => {
  it("says which model classes are reached and from where, and which nothing reaches, and records them", async () => {
    const root = adopted();
    const t = (await estimate(root)).text();
    expect(t).toMatch(
      /Model classes \(ADR 0169\): 8; 3 reached from the entry points and calls, read after them; 5 no entry or call reaches, left out: atticus map forge-house --models all reads them\./,
    );
    // the reached ones and where from, in a data block (paths are the repo's text)
    expect(t).toContain(`<atticus-data`);
    expect(t).toContain(
      `${J}/model/ListingRequest.java (ListingRequest), from ${J}/api/HouseController.java`,
    );
    expect(t).toContain(`${J}/model/Address.java (Address), from ${J}/model/ListingRequest.java`);
    for (const p of UNREACHED) expect(t).toContain(p.slice(p.lastIndexOf("/") + 1));
    expect(t).toMatch(/write a field fact for each of their fields \(name, type, required, side\)/);
    const plan = (await loadReadPlan(root, REPO))!;
    expect(plan.notReached?.files).toEqual(UNREACHED);
    expect(plan.notReached?.why).toMatch(/no entry point, call or field fact reaches/);
    expect(plan.notReached?.tokens).toBeGreaterThan(0);
    // the estimate counts the read without them
    expect(plan.estimate?.files).toBe(13 - UNREACHED.length);
  });

  it("gives them as JSON", async () => {
    const root = adopted();
    const r = JSON.parse((await estimate(root, { json: true })).text());
    expect(r.models.mode).toBe("reachable");
    expect(r.models.roots).toEqual([
      `${J}/api/HouseController.java`,
      `${J}/client/ValuationClient.java`,
    ]);
    expect(r.models.reached.map((x: { path: string }) => x.path)).toEqual(REACHED);
    expect(r.models.notReached).toEqual(UNREACHED);
  });

  it("plans parts with the entry points and clients first, then the reached models, and none of the rest", async () => {
    const root = adopted();
    const r = JSON.parse((await estimate(root, { json: true, maxTokens: 600 })).text());
    const paths: string[] = r.parts.parts.flatMap((p: { paths: string[] }) => p.paths);
    expect(paths).toEqual([
      "*",
      `${J}/api/**`,
      `${J}/client/**`,
      "src/main/resources/**",
      ...REACHED,
      `${J}/service/**`,
    ]);
    const all = JSON.parse(
      (await estimate(root, { json: true, maxTokens: 600, models: "all" })).text(),
    );
    const tokens = (x: { parts: { parts: { tokens: number }[] } }) =>
      x.parts.parts.reduce((n, p) => n + p.tokens, 0);
    expect(tokens(all)).toBeGreaterThan(tokens(r));
  });

  it("--models all reads every one, and the plan keeps the choice for the next estimate", async () => {
    const root = adopted();
    const t = (await estimate(root, { models: "all" })).text();
    expect(t).toMatch(/Model classes \(ADR 0169\): 8, every one read \(--models all\)/);
    let plan = (await loadReadPlan(root, REPO))!;
    expect(plan.models).toBe("all");
    expect(plan.notReached).toBeUndefined();
    expect(plan.estimate?.files).toBe(13);
    await estimate(root);
    plan = (await loadReadPlan(root, REPO))!;
    expect(plan.notReached).toBeUndefined();
    await estimate(root, { models: "reachable" });
    plan = (await loadReadPlan(root, REPO))!;
    expect(plan.models).toBeUndefined();
    expect(plan.notReached?.files).toEqual(UNREACHED);
  });
});

describe("atticus map <repo> in batches reads reachable models first (ADR 0169)", () => {
  it("leaves the unreached models out of every batch, says the reached ones, and records the rest", async () => {
    const root = adopted();
    const prompts: string[] = [];
    const runtime = new MockRuntime((r) => {
      prompts.push(r.pack.prompt);
      return "";
    });
    const o = io();
    await mapCommand(root, REPO, { commit: COMMIT, maxTokens: 8000 }, o.io, { runtime });
    const all = prompts.join("\n");
    for (const p of UNREACHED) expect(all).not.toContain(p);
    for (const p of REACHED) expect(all).toContain(`${p} lines`);
    expect(all).toContain(
      `${J}/model/ListingRequest.java (ListingRequest), from ${J}/api/HouseController.java`,
    );
    expect(all).toMatch(/write a field fact for each of their fields/);
    // the controller comes before the models it reaches
    expect(all.indexOf(`${J}/api/HouseController.java lines`)).toBeLessThan(
      all.indexOf(`${REACHED[0]} lines`),
    );
    expect(o.text()).toMatch(/5 model classes no entry or call reaches are left out/);
    expect((await loadReadPlan(root, REPO))?.notReached?.files).toEqual(UNREACHED);
  });
});

describe("verify and the models left out (ADR 0169)", () => {
  it("counts them apart and says how to read them", async () => {
    const root = adopted();
    await estimate(root);
    facts(root, [ENTRY]);
    const o = io();
    await verifyCommand(root, REPO, { commit: COMMIT }, o.io);
    const t = o.text();
    expect(t).toMatch(
      /coverage \d+% \(1 read, \d+ unknown, 5 model files no entry or call reaches\)/,
    );
    expect(t).toContain(
      "5 model files no entry or call reaches; atticus map forge-house --models all reads them.",
    );
    const y = readFileSync(join(root, ".atticus", "facts", `${REPO}.verify.yaml`), "utf8");
    expect(y).toMatch(/notReached:/);
  });

  it("refuses a reviewed glob over the controllers: read them", async () => {
    const root = adopted();
    facts(root, []);
    write(
      root,
      `.atticus/facts/${REPO}.reviewed.jsonl`,
      `{"path": "src/main/java/**", "why": "DTOs, nothing to record"}\n`,
    );
    const o = io();
    expect(await verifyCommand(root, REPO, { commit: COMMIT }, o.io)).toBe(1);
    expect(o.text()).toMatch(
      /bad-reviewed: .*covers src\/main\/java\/forge\/house\/api\/HouseController\.java, an entry point .*: read it/,
    );
  });
});

describe("atticus map <repo> --gaps reads reachable models first (ADR 0169)", () => {
  it("plans the client and the reached models first, leaves the unreached ones out and records them", async () => {
    // A read with no plan of its models: verify lists every model class as unknown.
    const root = adopted();
    facts(root, [ENTRY]);
    expect(await verifyCommand(root, REPO, { commit: COMMIT }, io().io)).toBe(0);
    const o = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: COMMIT, json: true }, o.io)).toBe(0);
    const g = JSON.parse(o.text());
    const reads: string[] = g.sessions.flatMap((s: { reads: { path: string }[] }) =>
      s.reads.map((r) => r.path),
    );
    for (const p of UNREACHED) expect(reads).not.toContain(p);
    const at = (p: string) => reads.indexOf(p);
    expect(at(`${J}/client/ValuationClient.java`)).toBeGreaterThanOrEqual(0);
    expect(at(`${J}/client/ValuationClient.java`)).toBeLessThan(at(REACHED[0]!));
    expect(at(REACHED[0]!)).toBeLessThan(at(REACHED[2]!));
    expect(at(REACHED[2]!)).toBeLessThan(at(`${J}/service/ListingService.java`));
    expect(g.notReached).toEqual(UNREACHED);
    expect((await loadReadPlan(root, REPO))?.notReached?.files).toEqual(UNREACHED);
    const md = readFileSync(join(root, ".atticus", "facts", `${REPO}.gaps.md`), "utf8");
    expect(md).toContain(
      `${J}/model/ListingRequest.java (ListingRequest), from ${J}/api/HouseController.java`,
    );
    // verify again: the unreached ones are counted apart now
    const v = io();
    await verifyCommand(root, REPO, { commit: COMMIT }, v.io);
    expect(v.text()).toMatch(/5 model files no entry or call reaches\)/);
  });

  it("--models all keeps every unknown model class in the gaps", async () => {
    const root = adopted();
    facts(root, [ENTRY]);
    await verifyCommand(root, REPO, { commit: COMMIT }, io().io);
    const o = io();
    await mapCommand(root, REPO, { gaps: true, commit: COMMIT, json: true, models: "all" }, o.io);
    const reads = JSON.parse(o.text()).sessions.flatMap((s: { reads: { path: string }[] }) =>
      s.reads.map((r) => r.path),
    );
    for (const p of UNREACHED) expect(reads).toContain(p);
  });
});

describe("the rules top-up reads reachable models only (ADR 0167, 0169)", () => {
  it("leaves the unreached model classes out of the field-types top-up, and records them", async () => {
    const root = adopted();
    facts(root, [ENTRY]);
    const o = io();
    expect(await mapCommand(root, REPO, { rules: true, commit: COMMIT }, o.io), o.text()).toBe(0);
    const md = readFileSync(join(root, ".atticus", "facts", `${REPO}.rules.md`), "utf8");
    for (const p of REACHED) expect(md).toContain(p);
    for (const p of UNREACHED) expect(md).not.toContain(p);
    expect(md).toContain(
      `${J}/model/ListingRequest.java (ListingRequest), from ${J}/api/HouseController.java`,
    );
    expect((await loadReadPlan(root, REPO))?.notReached?.files).toEqual(UNREACHED);
  });
});

describe("atticus map --all plans reachable first (ADR 0161, 0169)", () => {
  const git =
    (cwd: string) =>
    (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@forge.example",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@forge.example",
        },
      }).trim();
  const estate = () => {
    const root = temp("estate");
    write(
      root,
      "org-pack/profiles/forge/profile.yaml",
      "schemaVersion: 1\nplatform: forge\nname: Forge houses (invented)\nsystems:\n  - { id: houses, name: Houses, boundary: product, owner: team-houses, aliases: [] }\nenvironments: [dev, prod]\n",
    );
    write(
      root,
      "org-pack/profiles/forge/repos.manifest.yaml",
      "schemaVersion: 1\nplatform: forge\nrepos:\n  - id: forge-house\n    url: https://git.forge.example/forge/forge-house.git\n    type: spring-boot\n    owner: team-houses\n    component: house-api\n    system: houses\n",
    );
    const dir = join(root, "workspace", REPO);
    cpSync(join(FIX, REPO), dir, { recursive: true });
    const g = git(dir);
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "one");
    return root;
  };
  const dry = async (root: string, more: Parameters<typeof mapAllCommand>[1] = {}) => {
    const o = io();
    expect(
      await mapAllCommand(
        root,
        { dryRun: true, json: true, maxTokens: 100_000, mode: "copilot", ...more },
        o.io,
      ),
      o.text(),
    ).toBe(0);
    return JSON.parse(o.text()) as MapAllPlan;
  };

  it("counts the read without the unreached models, and with them under --models all", async () => {
    const root = estate();
    const reach = await dry(root);
    const all = await dry(root, { models: "all" });
    expect(reach.items[0]!.repo).toBe(REPO);
    expect(reach.items[0]!.tokens).toBeLessThan(all.items[0]!.tokens);
    expect(existsSync(join(root, "facts", `${REPO}.read-plan.yaml`))).toBe(true);
  });
});
