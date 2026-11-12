import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  listQuestions,
  parseRecord,
  raiseQuestions,
  recordPath,
  RepoManifest,
} from "@maycombhq/core";
import { main } from "../src/main.js";
import { seedReadersSlots } from "./seed-slots.js";
import { repoAdd } from "../src/repo-commands.js";
import { cloneUrlKey, nearRepos, repoIdKey } from "../src/repo-ids.js";
import { repoRename } from "../src/repo-rename.js";

/**
 * F5: repo ids that don't drift. A reader's facts were named `forge-deposits-*` while
 * `atticus next` asked for `forge_deposits-*_1-0`, a near-duplicate manifest entry. So repo add
 * warns of an entry like one listed, next names the near match, and repo rename moves a repo's
 * id with everything filed under it, in one change a person reviews. Invented Forge estate only.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];
const NOW = new Date("2026-10-31T09:00:00.000Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function estate() {
  const root = await mkdtemp(join(tmpdir(), "atticus-repo-rename-"));
  await cp(join(FIXTURES, "estate", "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}
const ids = async (root: string) =>
  RepoManifest.parse(parse(await readFile(join(root, ...MANIFEST), "utf8"))).repos.map((r) => r.id);

describe("repoIdKey and cloneUrlKey: what makes two entries the same repo", () => {
  it("sets aside case, _ and -, and a version suffix", () => {
    expect(repoIdKey("forge_deposits-api_1-0")).toBe("forge-deposits-api");
    expect(repoIdKey("Forge-Deposits-API")).toBe("forge-deposits-api");
    expect(repoIdKey("forge-ledger-v2")).toBe("forge-ledger");
    expect(repoIdKey("forge-notes-1.0")).toBe("forge-notes");
    expect(repoIdKey("forge-s3-sync")).toBe("forge-s3-sync");
  });

  it("reads an https and an ssh clone URL of one repo as the same", () => {
    expect(cloneUrlKey("https://git.example.com/forge/forge-ledger.git")).toBe(
      cloneUrlKey("git@git.example.com:forge/forge-ledger"),
    );
    expect(cloneUrlKey("https://git.example.com/forge/forge-ledger/")).toBe(
      "git.example.com/forge/forge-ledger",
    );
  });

  it("reads a folder of this metarepo, written with / or \\, as no clone", () => {
    for (const u of [".", "./forge-ledger", ".\\forge-ledger", ".\\\\forge-ledger", "..\\x"])
      expect(cloneUrlKey(u)).toBeUndefined();
  });

  it("names each listed entry like a new one, and why", () => {
    const listed = [
      { id: "forge-customers", url: "https://git.example.com/forge/forge-customers.git" },
      { id: "forge-web", url: "https://git.example.com/forge/forge-web.git" },
    ];
    expect(
      nearRepos({ id: "forge_customers_1-0", url: "https://git.example.com/x/y.git" }, listed),
    ).toEqual([
      {
        id: "forge-customers",
        why: "its id is the same once case, '_' and '-', and a version suffix are set aside",
      },
    ]);
    expect(
      nearRepos({ id: "web-app", url: "git@git.example.com:forge/forge-web.git" }, listed),
    ).toEqual([{ id: "forge-web", why: "it has the same clone URL" }]);
    expect(nearRepos({ id: "forge-orders", url: "https://git.example.com/o.git" }, listed)).toEqual(
      [],
    );
  });
});

describe("atticus repo add warns of an entry like one already listed (F5)", () => {
  it("adds it, and says which listed repo it looks like and why", async () => {
    const root = await estate();
    const o = io();
    const code = await repoAdd(
      root,
      "https://git.example.com/forge/forge_customers_1-0.git",
      { type: "spring-boot", owner: "team-customers", description: "Customers, again." },
      o.io,
      { now: NOW, by: "pat" },
    );
    expect(code).toBe(0);
    expect(await ids(root)).toContain("forge_customers_1-0");
    expect(o.err).toEqual([
      "Warning: forge_customers_1-0 looks like forge-customers, already listed (its id is the same once case, '_' and '-', and a version suffix are set aside). If they are one repo, remove this entry from org-pack/profiles/forge/repos.manifest.yaml, or keep one id: atticus repo rename <old> <new>.",
    ]);
  });

  it("says nothing for an entry like no other", async () => {
    const root = await estate();
    const o = io();
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-orders.git",
      { type: "spring-boot", owner: "team-orders", description: "Orders." },
      o.io,
      { now: NOW, by: "pat" },
    );
    expect(o.err).toEqual([]);
  });
});

describe("atticus next names the near match of a repo with no facts (F5)", () => {
  it("says a repo like it has facts, and how to keep one id", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-next-near-"));
    await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
    for (const id of ["forge-notes", "forge-notes-ui"])
      await mkdir(join(root, "workspace", id, ".git"), { recursive: true });
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts", "forge_notes-1.0.jsonl"), "");
    const out: string[] = [];
    const code = await main(
      ["next", "--json", "--root", root],
      { out: (l) => out.push(l), err: () => undefined },
      { quiet: true },
    );
    expect(code).toBe(0);
    const steps = (JSON.parse(out.join("\n")) as { steps: { repo?: string; why: string }[] }).steps;
    const notes = steps.find((s) => s.repo === "forge-notes")!;
    expect(notes.why).toContain(
      "No facts are filed under forge-notes, but forge_notes-1.0 has some (facts/forge_notes-1.0.jsonl) and its id is near this one: if they are one repo, keep one id with atticus repo rename forge-notes forge_notes-1.0 (or rename the facts to forge-notes).",
    );
    const ui = steps.find((s) => s.repo === "forge-notes-ui")!;
    expect(ui.why).not.toContain("No facts are filed");
  });
});

describe("atticus repo rename <old> <new> (F5)", () => {
  /** forge-customers read, verified, asked about and in the catalog. */
  async function readEstate() {
    const root = await estate();
    const facts = join(root, "facts");
    await mkdir(facts, { recursive: true });
    const fact = (id: string, line: number) =>
      JSON.stringify({
        kind: "entry",
        id,
        repo: "forge-customers",
        commit: "0123abc",
        component: "forge-customers",
        entryType: "rest",
        method: "GET",
        path: "/customers",
        cite: { file: "src/CustomerController.java", line, value: "/customers" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      });
    await writeFile(
      join(facts, "forge-customers.jsonl"),
      [fact("e-list", 10), fact("e-get", 14)].join("\n") + "\n",
    );
    await writeFile(
      join(facts, "forge-customers.verify.yaml"),
      "repo: forge-customers\ncommit: 0123abc\naccepted: 2\nrejected: 0\n",
    );
    await writeFile(
      join(facts, "forge-customers.reviewed.jsonl"),
      '{"path":"src/calc/*.java","why":"pure arithmetic"}\n',
    );
    await writeFile(
      join(facts, "forge-customers.read-plan.yaml"),
      "repo: forge-customers\nparts:\n  - part: 1\n    paths: [src/**]\n",
    );
    // Another repo's facts name forge-customers too, and are not moved.
    await writeFile(join(facts, "forge-web.jsonl"), "");
    await raiseQuestions(
      root,
      [
        {
          question: "Is src/gen generated?",
          options: [],
          evidence: ["src/gen/A.java:1"],
          scope: "repo",
        },
      ],
      {
        step: "map",
        repo: "forge-customers",
        command: "atticus verify forge-customers",
        rerun: "atticus verify forge-customers --write",
        at: NOW.toISOString(),
      },
    );
    const p = parseRecord({
      kind: "Component",
      schemaVersion: 2,
      id: "forge-customers",
      status: "current",
      confidence: "verified",
      evidence: [{ source: "code", repo: "forge-customers", path: "README.md", line: 1 }],
      system: "forge",
      repo: "forge-customers",
      type: "service",
    });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    // ADR 0195 point 2: a rename writes the repo's slots under the new id and builds, so the
    // catalog it renames is a build's: the record seeded as forge-customers's readers slot, and
    // built (a record file written by hand is a catalog from before the slots, which a build
    // refuses until it is upgraded).
    await seedReadersSlots(root, [p.record]);
    return root;
  }

  it("moves the id with its facts, read plan, reviewed file, questions and catalog records", async () => {
    const root = await readEstate();
    const o = io();
    expect(await repoRename(root, "forge-customers", "forge-accounts", o.io)).toBe(0);
    expect(o.err).toEqual([]);
    expect(await ids(root)).toEqual(["forge-web", "forge-accounts"]);
    const facts = join(root, "facts");
    for (const c of [".jsonl", ".verify.yaml", ".reviewed.jsonl", ".read-plan.yaml"]) {
      expect(existsSync(join(facts, `forge-customers${c}`)), c).toBe(false);
      expect(existsSync(join(facts, `forge-accounts${c}`)), c).toBe(true);
    }
    const kept = (await readFile(join(facts, "forge-accounts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { repo: string; id: string });
    expect(kept.map((f) => [f.id, f.repo])).toEqual([
      ["e-list", "forge-accounts"],
      ["e-get", "forge-accounts"],
    ]);
    expect(parse(await readFile(join(facts, "forge-accounts.verify.yaml"), "utf8")).repo).toBe(
      "forge-accounts",
    );
    expect(parse(await readFile(join(facts, "forge-accounts.read-plan.yaml"), "utf8")).repo).toBe(
      "forge-accounts",
    );
    const qs = (await listQuestions(root)).questions;
    expect(qs.map((q) => [q.repo, q.rerun, q.scope])).toEqual([
      [
        "forge-accounts",
        "atticus verify forge-accounts --write",
        { level: "repo", id: "forge-accounts" },
      ],
    ]);
    const comp = parse(
      await readFile(
        join(
          root,
          "catalog",
          "generated",
          recordPath({ kind: "Component", id: "forge-customers" }),
        ),
        "utf8",
      ),
    );
    expect(comp.repo).toBe("forge-accounts");
    expect(comp.evidence[0].repo).toBe("forge-accounts");
    // Every file it touched is said, and nothing is committed: a person reviews the change.
    const text = o.out.join("\n");
    expect(text).toContain("Renamed forge-customers to forge-accounts");
    expect(text).toContain("facts/forge-customers.jsonl → facts/forge-accounts.jsonl");
    expect(text).toContain("org-pack/profiles/forge/repos.manifest.yaml");
    expect(text).toMatch(/Atticus commits and pushes nothing/);
  });

  it("refuses a repo no manifest lists, an id already listed, and an id that isn't a slug", async () => {
    const root = await readEstate();
    let o = io();
    expect(await repoRename(root, "forge-gone", "forge-accounts", o.io)).toBe(2);
    expect(o.err.join("\n")).toMatch(/no repo forge-gone in any manifest/);
    o = io();
    expect(await repoRename(root, "forge-customers", "forge-web", o.io)).toBe(2);
    expect(o.err.join("\n")).toMatch(/forge-web is already listed/);
    o = io();
    expect(await repoRename(root, "forge-customers", "Forge_Accounts", o.io)).toBe(2);
    expect(o.err.join("\n")).toMatch(/isn't a repo id/);
    // Nothing moved.
    expect(await ids(root)).toEqual(["forge-web", "forge-customers"]);
    expect(existsSync(join(root, "facts", "forge-customers.jsonl"))).toBe(true);
  });

  it("refuses, before changing anything, when a file is already at the new id", async () => {
    const root = await readEstate();
    await writeFile(join(root, "facts", "forge-accounts.jsonl"), "");
    const o = io();
    expect(await repoRename(root, "forge-customers", "forge-accounts", o.io)).toBe(1);
    expect(o.err.join("\n")).toMatch(/facts\/forge-accounts\.jsonl is already there/);
    expect(await ids(root)).toEqual(["forge-web", "forge-customers"]);
    expect(existsSync(join(root, "facts", "forge-customers.jsonl"))).toBe(true);
  });

  it("is routed as atticus repo rename", async () => {
    const root = await readEstate();
    const out: string[] = [];
    const code = await main(
      ["repo", "rename", "forge-customers", "forge-accounts", "--root", root],
      { out: (l) => out.push(l), err: () => undefined },
      { quiet: true },
    );
    expect(code).toBe(0);
    expect(await ids(root)).toEqual(["forge-web", "forge-accounts"]);
  });
});
