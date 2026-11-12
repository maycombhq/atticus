import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deserializeRecord } from "@maycombhq/core";
import { serializeReadersSlot, SLOT_VERSION } from "@maycombhq/scanner";
import { main } from "../src/main.js";

/**
 * Another branch scanned beside the baseline (ADR 0123): `atticus scan --ref develop` reads each
 * repo's develop branch in a checkout of its own and keeps the catalog in
 * catalog/branches/develop/, never in catalog/generated. It says what develop changes against
 * the baseline. Invented Forge repos only, from a local remote.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const EXPORT = `package forge.notes;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ExportController {

  @GetMapping("/notes/export")
  public String export() {
    return "";
  }
}
`;

async function estate() {
  const base = await mkdtemp(join(tmpdir(), "atticus-branch-scan-"));
  const work = join(base, "src", "forge-notes");
  await cp(join(FIXTURES, "scan-settings/repos/forge-notes"), work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "notes");
  const url = join(base, "remotes", "forge-notes.git");
  await mkdir(dirname(url), { recursive: true });
  git(base, "clone", "-q", "--bare", work, url);
  git(work, "remote", "add", "origin", url);
  // develop adds an endpoint.
  git(work, "checkout", "-q", "-b", "develop");
  await writeFile(join(work, "src/main/java/forge/notes/ExportController.java"), EXPORT);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "export");
  git(work, "push", "-q", "origin", "develop");

  const root = join(base, "metarepo");
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    [
      "schemaVersion: 1",
      "platform: forge",
      "repos:",
      `  - { id: forge-notes, url: ${JSON.stringify(url)}, type: spring-boot, owner: team-notes, component: notes-svc, system: notes, branches: [develop] }`,
      "",
    ].join("\n"),
  );
  git(root, "init", "-q");
  return root;
}

describe("atticus scan --ref (ADR 0123)", { timeout: 300_000 }, () => {
  it("scans develop beside the baseline, keeps it in catalog/branches/develop, and says what it adds", async () => {
    const root = await estate();
    expect((await run(["workspace", "sync", "--root", root])).code).toBe(0);
    expect((await run(["scan", "--root", root])).code).toBeLessThan(2);
    const baseline = await readdir(join(root, "catalog", "generated"), { recursive: true });

    const r = await run(["scan", "--ref", "develop", "--root", root]);
    expect(r.code, r.err).toBeLessThan(2);
    expect(r.out).toContain("catalog/branches/develop");
    expect(r.out).toMatch(/develop against the baseline: [1-9]\d* added/);
    expect(r.out).toContain("+ Endpoint/notes-svc.get-export");

    // The baseline is untouched; develop's catalog is kept beside it, with what it read.
    expect(await readdir(join(root, "catalog", "generated"), { recursive: true })).toEqual(
      baseline,
    );
    expect(existsSync(join(root, "catalog", "branches", "develop", "generated"))).toBe(true);
    const meta = parse(
      await readFile(join(root, "catalog", "branches", "develop", "branch.yaml"), "utf8"),
    ) as { branch: string; repos: { id: string; commit: string }[] };
    expect(meta.branch).toBe("develop");
    expect(meta.repos[0]).toMatchObject({ id: "forge-notes" });
    expect(meta.repos[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps another repo's scan of the branch when one repo's row is scanned again", async () => {
    const root = await estate();
    expect((await run(["workspace", "sync", "--root", root])).code).toBe(0);
    expect((await run(["scan", "--ref", "develop", "--root", root])).code).toBeLessThan(2);
    const dir = join(root, "catalog", "branches", "develop");
    // As if forge-ledger's develop had been scanned from its own row before.
    const { readdir: ls } = await import("node:fs/promises");
    const kinds = await ls(join(dir, "generated"));
    const kind = kinds.find((k) => !k.endsWith(".yaml"))!;
    const file = (await ls(join(dir, "generated", kind)))[0]!;
    const text = await readFile(join(dir, "generated", kind, file), "utf8");
    // ADR 0195 (CS2): what that earlier scan read is forge-ledger's readers slot of the branch
    // (the branch's own sources/), from which every build of the branch makes its records.
    const p = deserializeRecord(
      text
        .replace(/^id: .*$/m, `id: ledger-${file.replace(/\.yaml$/, "")}`)
        .replace(/repo: forge-notes/g, "repo: forge-ledger"),
    );
    if (!p.ok) throw new Error("not a record");
    await mkdir(join(dir, "sources", "readers"), { recursive: true });
    await writeFile(
      join(dir, "sources", "readers", "forge-ledger.json"),
      serializeReadersSlot({
        slotVersion: SLOT_VERSION,
        kind: "readers",
        repo: "forge-ledger",
        commit: "a".repeat(40),
        status: "read",
        extractors: [],
        settings: "0".repeat(64),
        records: [p.record],
      }),
    );
    const meta = parse(await readFile(join(dir, "branch.yaml"), "utf8")) as {
      repos: { id: string; commit: string }[];
    };
    await writeFile(
      join(dir, "branch.yaml"),
      `schemaVersion: 1\nbranch: develop\nscannedAt: x\nrepos:\n  - { id: forge-ledger, commit: ${"a".repeat(40)} }\n  - { id: forge-notes, commit: ${meta.repos[0]!.commit} }\n`,
    );
    // forge-ledger is in the manifest too (its row scanned it before).
    const manifest = join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
    const listed = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      `${listed}  - { id: forge-ledger, url: "https://git.example.com/forge/forge-ledger.git", type: spring-boot, owner: team-ledger, component: ledger-svc, system: ledger, branches: [develop] }\n`,
    );
    const again = await run(["scan", "--ref", "develop", "--repos", "forge-notes", "--root", root]);
    expect(again.code, again.err).toBeLessThan(2);
    expect(existsSync(join(dir, "generated", kind, `ledger-${file}`))).toBe(true);
    const after = parse(await readFile(join(dir, "branch.yaml"), "utf8")) as {
      repos: { id: string }[];
    };
    expect(after.repos.map((x) => x.id)).toEqual(["forge-ledger", "forge-notes"]);
    // forge-ledger leaves the manifest: the next scan drops its records and its commit, once
    // the removals are confirmed with their count (ADR 0195 point 4: a removed repo's records
    // leave only through the confirmed removal guard).
    await writeFile(manifest, listed);
    const refused = await run([
      "scan",
      "--ref",
      "develop",
      "--repos",
      "forge-notes",
      "--root",
      root,
    ]);
    const n = /--allow-removals (\d+)/.exec(refused.err)?.[1];
    expect(n, refused.err).toBeDefined();
    expect(existsSync(join(dir, "generated", kind, `ledger-${file}`))).toBe(true);
    expect(
      (
        await run([
          "scan",
          "--ref",
          "develop",
          "--repos",
          "forge-notes",
          "--root",
          root,
          "--allow-removals",
          n!,
        ])
      ).code,
    ).toBeLessThan(2);
    expect(existsSync(join(dir, "generated", kind, `ledger-${file}`))).toBe(false);
    const gone = parse(await readFile(join(dir, "branch.yaml"), "utf8")) as {
      repos: { id: string }[];
    };
    expect(gone.repos.map((x) => x.id)).toEqual(["forge-notes"]);
  });

  it("refuses the default branch, and a branch no repo lists unless --repos names them", async () => {
    const root = await estate();
    await run(["workspace", "sync", "--root", root]);
    const main_ = await run(["scan", "--ref", "main", "--root", root]);
    expect(main_.code).toBe(2);
    expect(main_.err).toMatch(/main is the default branch.*baseline/);
    const none = await run(["scan", "--ref", "release", "--root", root]);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/No repo lists release/);
    const missing = await run([
      "scan",
      "--ref",
      "release",
      "--repos",
      "forge-notes",
      "--root",
      root,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/forge-notes has no branch release/);
  });
});

describe("a branch whose name has capitals (review round 46, NTFS)", { timeout: 300_000 }, () => {
  it("keeps its catalog in a lower-case folder of its own, and moves one an earlier version made", async () => {
    const root = await estate();
    const work = join(root, "..", "src", "forge-notes");
    git(work, "push", "-q", "origin", "develop:Release/Next");
    expect((await run(["workspace", "sync", "--root", root])).code).toBe(0);
    expect((await run(["scan", "--root", root])).code).toBeLessThan(2);
    const scan = () =>
      run(["scan", "--ref", "Release/Next", "--repos", "forge-notes", "--root", root]);
    const first = await scan();
    expect(first.code, first.err).toBeLessThan(2);
    const branches = join(root, "catalog", "branches");
    const [folder] = await readdir(branches);
    expect(folder).toMatch(/^release-next-[0-9a-f]{8}$/);
    // as an earlier version kept it: catalog/branches/Release-Next
    const { rename } = await import("node:fs/promises");
    await rename(join(branches, folder!), join(branches, "Release-Next"));
    const { compareBranch } = await import("../src/repo-branches.js");
    expect((await compareBranch(root, "Release/Next"))?.added).toContain(
      "Endpoint/notes-svc.get-export",
    );
    const again = await scan();
    expect(again.code, again.err).toBeLessThan(2);
    expect(await readdir(branches)).toEqual([folder]);
    expect((await compareBranch(root, "Release/Next"))?.added).toContain(
      "Endpoint/notes-svc.get-export",
    );
  });
});

describe("the Repos screen's API (ADR 0123)", { timeout: 300_000 }, () => {
  it("shows each repo's branches and scans, compares a branch, and edits the manifest", async () => {
    const { startServer } = await import("@maycombhq/server");
    const { uiRepoRoutes } = await import("../src/ui-api-repos.js");
    const root = await estate();
    await run(["workspace", "sync", "--root", root]);
    await run(["scan", "--root", root]);
    await run(["scan", "--ref", "develop", "--root", root]);
    const srv = await startServer({
      root,
      port: 0,
      user: "priya.nair",
      watch: false,
      extend: (r, ctx) => uiRepoRoutes(r, ctx),
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(srv.url + path, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      const list = await call("GET", "/api/repos/branches");
      expect(list.status).toBe(200);
      const [repo] = list.body.repos as Record<string, unknown>[];
      expect(repo).toMatchObject({
        id: "forge-notes",
        defaultBranch: "main",
        remoteDefault: "main",
        branches: ["develop"],
      });
      expect(repo!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(repo!.scans).toEqual([expect.objectContaining({ branch: "develop" })]);

      const cmp = await call("GET", "/api/repos/compare?branch=develop");
      expect(cmp.status).toBe(200);
      expect(cmp.body.added).toContain("Endpoint/notes-svc.get-export");
      expect((await call("GET", "/api/repos/compare?branch=release")).status).toBe(404);

      const edit = await call("PUT", "/api/repos/forge-notes/branches", {
        branches: ["develop", "release/2026.11"],
      });
      expect(edit.status).toBe(200);
      const text = await readFile(
        join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
        "utf8",
      );
      expect(text).toContain("release/2026.11");
      expect(text).toContain("component: notes-svc");
      const bad = await call("PUT", "/api/repos/forge-notes/branches", { branches: ["main"] });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toMatch(/default branch/);
      // A form opened before that edit: refused (409), the manifest kept as it is now.
      const stale = await call("PUT", "/api/repos/forge-notes/branches", {
        defaultBranch: "main",
        branches: ["develop", "hotfix"],
        was: { defaultBranch: "main", branches: ["develop"] },
      });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(stale.body)).toMatch(
        /changed in the manifest since you opened the form/,
      );
      const kept = await readFile(
        join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
        "utf8",
      );
      expect(kept).toContain("release/2026.11");
      expect(kept).not.toContain("hotfix");
      const staleAbout = await call("PUT", "/api/repos/forge-notes/description", {
        text: "Notes for the ledger.",
        was: "An older line.",
      });
      expect(staleAbout.status).toBe(409);
    } finally {
      srv.close();
    }
  });
});
