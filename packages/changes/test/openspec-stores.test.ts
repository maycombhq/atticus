/**
 * ADR 0126: the OpenSpec stores an org pack names (org-pack/openspec.yaml), read read-only and
 * labelled, and the references: entry hand-down adds to a code repo when the pack turns it on.
 * Forge fixtures from fixtures/openspec-stores; the metarepo is a temporary folder.
 */
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GitRunner } from "@maycombhq/workspace";
import {
  metarepoOrigin,
  openspecStores,
  referenceMetarepoIn,
  storeDirOf,
  storeSpecLookup,
} from "../src/index.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/openspec-stores");

async function metarepo(openspecYaml?: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "atticus-os-stores-"));
  const root = join(base, "forge-meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "pack.yaml"),
    "schemaVersion: 1\nname: forge\nversion: 0.1.0\nowner: pat\n",
  );
  if (openspecYaml !== undefined)
    await writeFile(join(root, "org-pack", "openspec.yaml"), openspecYaml);
  // Clones beside the metarepo, as a developer keeps them.
  await cp(join(FX, "forge-payments-store"), join(base, "forge-payments-store"), {
    recursive: true,
  });
  await cp(join(FX, "future-store"), join(base, "forge-statements"), { recursive: true });
  return root;
}

const noGit: GitRunner = async () => {
  throw new Error("no remote");
};
const gitWithOrigin =
  (url: string): GitRunner =>
  async (args) => {
    if (args.join(" ") === "remote get-url origin") return { stdout: `${url}\n`, stderr: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

describe("the stores openspec.yaml names (read-only)", () => {
  it("reads none when the org pack has no openspec.yaml", async () => {
    const root = await metarepo();
    expect(await openspecStores(root)).toEqual({ stores: [], problems: [] });
  });

  it("reads each, labelled with its label, else its store.yaml id", async () => {
    const root = await metarepo(
      "schemaVersion: 1\nstores:\n  - path: ../forge-payments-store\n    label: payments\n  - path: ../forge-statements\n",
    );
    const r = await openspecStores(root);
    expect(r.problems).toEqual([]);
    expect(r.stores.map((s) => [s.label, s.id, s.path])).toEqual([
      ["payments", "forge-payments", "../forge-payments-store"],
      ["forge-statements", "forge-statements", "../forge-statements"],
    ]);
    expect(r.stores[0]!.changes.map((c) => c.id)).toEqual(["add-refund-window"]);
    expect(r.stores[0]!.specs.map((s) => s.id)).toEqual(["ledger-postings", "refunds"]);
    // The later store.yaml version is read, with its note.
    expect(r.stores[1]!.notes[0]).toMatch(/version 2/);
  });

  it("labels a store with no store.yaml by its folder, and says when a path isn't there", async () => {
    const root = await metarepo(
      `schemaVersion: 1\nstores:\n  - path: ${join(FX, "unmarked-store")}\n  - path: ../gone\n`,
    );
    const r = await openspecStores(root);
    expect(r.stores.map((s) => s.label)).toEqual(["unmarked-store", "gone"]);
    expect(r.stores[1]!.notes).toEqual([`${join(dirname(root), "gone")} isn't there`]);
  });

  it("says when openspec.yaml doesn't read, and reads nothing then", async () => {
    const root = await metarepo("schemaVersion: 1\nstores: payments\n");
    const r = await openspecStores(root);
    expect(r.stores).toEqual([]);
    expect(r.problems[0]).toMatch(/^org-pack\/openspec\.yaml: stores: /);
  });

  it("says when two stores end up with the same label", async () => {
    const root = await metarepo(
      `schemaVersion: 1\nstores:\n  - path: ../forge-payments-store\n  - path: ${join(FX, "forge-payments-store")}\n`,
    );
    const r = await openspecStores(root);
    expect(r.problems).toEqual([
      `org-pack/openspec.yaml: two stores are labelled forge-payments; give one a label`,
    ]);
  });

  it("takes the metarepo's origin only from its own Git folder, and only when it is a URL", async () => {
    const root = await metarepo();
    const url = "https://code.forge.example/forge/forge-meta.git";
    expect(await metarepoOrigin(root, gitWithOrigin(url))).toBeUndefined();
    await mkdir(join(root, ".git"));
    expect(await metarepoOrigin(root, gitWithOrigin(url))).toBe(url);
    expect(
      await metarepoOrigin(root, gitWithOrigin("ssh-user@code.forge.example:forge/meta.git")),
    ).toBe("ssh-user@code.forge.example:forge/meta.git");
    expect(
      await metarepoOrigin(root, gitWithOrigin("/srv/remotes/forge-meta.git")),
    ).toBeUndefined();
    expect(await metarepoOrigin(root, noGit)).toBeUndefined();
  });

  it("resolves a path against the metarepo root, or the home folder for ~/", () => {
    expect(storeDirOf("/m/forge-meta", "../s")).toBe(join("/m", "s"));
    expect(storeDirOf("/m/forge-meta", "~/openspec/s")).toBe(join(homedir(), "openspec", "s"));
    expect(storeDirOf("/m/forge-meta", join(FX, "x"))).toBe(join(FX, "x"));
  });

  it("looks a capability's spec up in the stores", async () => {
    const root = await metarepo(
      "schemaVersion: 1\nstores:\n  - path: ../forge-payments-store\n    label: payments\n",
    );
    expect(await storeSpecLookup(root, "refunds")).toEqual([
      {
        store: "payments",
        id: "refunds",
        purpose: "Refunds of settled Forge transfers, back to the account that paid.",
        file: join(
          dirname(root),
          "forge-payments-store",
          "openspec",
          "specs",
          "refunds",
          "spec.md",
        ),
      },
    ]);
    expect(await storeSpecLookup(root, "transfers")).toEqual([]);
  });
});

describe("hand-down's references: entry (ADR 0126)", () => {
  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "atticus-os-repo-"));
    await cp(join(FX, "forge-ledger"), dir, { recursive: true });
    return dir;
  }

  it("does nothing unless openspec.yaml turns it on", async () => {
    const root = await metarepo();
    const dir = await repo();
    const before = await readFile(join(dir, "openspec", "config.yaml"), "utf8");
    expect(await referenceMetarepoIn(root, dir, { git: noGit })).toEqual({ action: "off" });
    expect(await readFile(join(dir, "openspec", "config.yaml"), "utf8")).toBe(before);
  });

  it("adds the metarepo's store id with its origin, keeping the rest of the file", async () => {
    const root = await metarepo("schemaVersion: 1\nreferenceInRepos: true\n");
    await mkdir(join(root, ".openspec-store"));
    await writeFile(join(root, ".openspec-store", "store.yaml"), "version: 1\nid: forge\n");
    await mkdir(join(root, ".git"));
    const dir = await repo();
    const r = await referenceMetarepoIn(root, dir, {
      git: gitWithOrigin("https://code.forge.example/forge/forge-meta.git"),
    });
    expect(r).toEqual({ action: "added", file: "openspec/config.yaml" });
    expect(await readFile(join(dir, "openspec", "config.yaml"), "utf8")).toBe(
      await readFile(join(FX, "references", "forge-ledger-expected.yaml"), "utf8"),
    );
    // A second hand-down finds it there.
    expect(
      await referenceMetarepoIn(root, dir, {
        git: gitWithOrigin("https://code.forge.example/forge/forge-meta.git"),
      }),
    ).toEqual({ action: "present", file: "openspec/config.yaml" });
  });

  it("leaves a local-folder origin out of the remote", async () => {
    const root = await metarepo("schemaVersion: 1\nreferenceInRepos: true\n");
    await mkdir(join(root, ".openspec-store"));
    await writeFile(join(root, ".openspec-store", "store.yaml"), "version: 1\nid: forge\n");
    const dir = join(await mkdtemp(join(tmpdir(), "atticus-os-repo-")), "r");
    await mkdir(join(dir, "openspec"), { recursive: true });
    await cp(join(FX, "references", "no-references.yaml"), join(dir, "openspec", "config.yaml"));
    await mkdir(join(root, ".git"));
    await referenceMetarepoIn(root, dir, { git: gitWithOrigin("/srv/remotes/forge-meta.git") });
    expect(await readFile(join(dir, "openspec", "config.yaml"), "utf8")).toBe(
      await readFile(join(FX, "references", "no-references-expected.yaml"), "utf8"),
    );
  });

  it("skips, saying why, when the metarepo isn't a store or the repo has no OpenSpec config", async () => {
    const root = await metarepo("schemaVersion: 1\nreferenceInRepos: true\n");
    const dir = await repo();
    expect(await referenceMetarepoIn(root, dir, { git: noGit })).toEqual({
      action: "skipped",
      file: "openspec/config.yaml",
      why: "this metarepo isn't an OpenSpec store yet (no .openspec-store/store.yaml): run atticus upgrade --openspec-store, commit the file, then hand down again",
    });
    await mkdir(join(root, ".openspec-store"));
    await writeFile(join(root, ".openspec-store", "store.yaml"), "version: 1\nid: forge\n");
    const bare = await mkdtemp(join(tmpdir(), "atticus-os-bare-"));
    expect(await referenceMetarepoIn(root, bare, { git: noGit })).toEqual({
      action: "skipped",
      file: "openspec/config.yaml",
      why: "the repo has no openspec/config.yaml, so there is nowhere to add the metarepo as an OpenSpec reference",
    });
  });
});
