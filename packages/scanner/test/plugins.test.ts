import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

/**
 * Scanner plugins (ADR 0080), in fixtures/scanner-plugins: one good plugin that reads the Forge
 * Anvil house framework, and six that pass their own tests but misbehave on a repo with Java
 * (read outside the repo, write a file, open a socket, start a process, loop, hog memory).
 * The scan runs each after the built-ins on the repos it applies to; each bad one is stopped
 * and reported, and the scan goes on.
 */
const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scanner-plugins");

async function scan(edit?: (orgPack: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atticus-plugins-"));
  const orgPack = join(root, "org-pack");
  await cp(join(FX, "metarepo/org-pack"), orgPack, { recursive: true });
  await edit?.(orgPack);
  const s = await scanEstate({
    root,
    orgPack,
    repoDir: (id) => join(FX, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    inputsDir: null,
    scannedAt: "2026-10-21T12:00:00Z",
  });
  type R = Record<string, unknown> & { kind: string; id: string };
  return {
    s,
    root,
    endpoints: (s.records as unknown as R[])
      .filter((r) => r.kind === "Endpoint")
      .map((r) => `${String(r.method)} ${String(r.pathOrTopic)} ${String(r.component)}`)
      .sort(),
    problems: s.problems.map((p) => `${p.repo ?? "-"} | ${p.source} | ${p.message}`).sort(),
  };
}

const onlyGood = async (op: string): Promise<void> => {
  await Promise.all(
    [
      "forge-reads-outside",
      "forge-writes-file",
      "forge-opens-socket",
      "forge-spawns",
      "forge-loops",
      "forge-hogs-memory",
    ].map((id) => rm(join(op, "plugins", id), { recursive: true, force: true })),
  );
};

describe("scanner plugins in the scan (ADR 0080)", () => {
  it("runs a pinned, tested plugin on the repos it applies to, after the built-ins", async () => {
    const { s, endpoints, problems } = await scan(onlyGood);
    expect(problems).toEqual([]);
    expect(endpoints).toEqual(["DELETE /notes/{id} notes-svc", "GET /notes/{id} notes-svc"]);
    const runs = (repo: string) =>
      s.repos.find((r) => r.repo === repo)!.runs.map((r) => r.extractor);
    expect(runs("forge-anvil-notes").at(-1)).toBe("plugin-forge-anvil-routes");
    // The UI is a web-app: the plugin applies to anvil-service repos only.
    expect(runs("forge-notes-ui").some((x) => x.startsWith("plugin-"))).toBe(false);
  }, 120_000);

  it("stops and reports each plugin that misbehaves; the scan and the good plugin go on", async () => {
    const { endpoints, problems } = await scan();
    expect(endpoints).toEqual(["DELETE /notes/{id} notes-svc", "GET /notes/{id} notes-svc"]);
    expect(problems).toEqual([
      "forge-anvil-notes | plugin-forge-hogs-memory | stopped: it used more than its 32 MB memory limit",
      "forge-anvil-notes | plugin-forge-loops | stopped after 1000 ms, its time limit",
      "forge-anvil-notes | plugin-forge-opens-socket | blocked: tried to use require",
      'forge-anvil-notes | plugin-forge-reads-outside | blocked: tried to read "../../org-pack/pack.yaml", which is outside the repo',
      "forge-anvil-notes | plugin-forge-spawns | blocked: tried to use process",
      "forge-anvil-notes | plugin-forge-writes-file | blocked: tried to import node:fs",
    ]);
  }, 180_000);

  it("refuses a plugin whose entry file changed after it was pinned, or that isn't pinned", async () => {
    const { endpoints, problems } = await scan(async (op) => {
      await onlyGood(op);
      const entry = join(op, "plugins", "forge-anvil-routes", "index.js");
      await writeFile(entry, (await readFile(entry, "utf8")) + "\n// an unreviewed edit\n");
    });
    expect(endpoints).toEqual([]);
    expect(problems).toEqual([
      "- | plugin forge-anvil-routes | index.js changed after it was pinned: its sha256 isn't the one in plugin.yaml. Review the change, then run atticus plugin pin; the plugin is not used",
    ]);
    const unpinned = await scan(async (op) => {
      await onlyGood(op);
      const m = join(op, "plugins", "forge-anvil-routes", "plugin.yaml");
      await writeFile(m, (await readFile(m, "utf8")).replace(/^sha256:.*\n/m, ""));
    });
    expect(unpinned.problems).toEqual([
      "- | plugin forge-anvil-routes | isn't pinned: run atticus plugin pin once it is reviewed; the plugin is not used",
    ]);
  }, 120_000);

  it("refuses a plugin whose golden tests fail, and leaves a disabled one alone", async () => {
    const failing = await scan(async (op) => {
      await onlyGood(op);
      const want = join(op, "plugins", "forge-anvil-routes", "test", "notes", "expected.yaml");
      await writeFile(want, (await readFile(want, "utf8")).replace("method: POST", "method: PUT"));
    });
    expect(failing.endpoints).toEqual([]);
    expect(failing.problems).toEqual([
      '- | plugin forge-anvil-routes | test "notes": notes.post-notes.method: expected "PUT", got "POST"; the plugin is not used',
    ]);
    const disabled = await scan(async (op) => {
      await onlyGood(op);
      const m = join(op, "plugins", "forge-anvil-routes", "plugin.yaml");
      await writeFile(m, (await readFile(m, "utf8")) + "enabled: false\n");
    });
    expect(disabled.problems).toEqual([]);
    expect(disabled.endpoints).toEqual([]);
  }, 120_000);
});
