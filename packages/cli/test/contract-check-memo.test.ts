import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { contractCheckOf } from "../src/contract-check-files.js";
import { contractsView } from "../src/ui-api-contracts.js";

/**
 * The contract check from the files on disk, once (review item 4, ADR 0164): GET /api/contracts,
 * /api/trust and /api/outside each ask for it, the Architecture canvas on every open; it is
 * worked out once per metarepo and kept until a file of facts/, the inputs, the org pack, the
 * questions or the curated catalog changes. A generated estate of 40 invented Forge repos.
 */

const REPOS = 40;
const ENTRIES = 5;
const FIELDS = 6;
/** The first check of an estate reads and joins it all: given room on a busy machine. */
const ROOM = 60_000;
const COMMIT = "abc1234def5678abc1234def5678abc1234def56";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-contracts-memo-"));
  const repos = Array.from({ length: REPOS }, (_, r) => `forge-gen-${r}`);
  const dir = join(root, "org-pack", "profiles", "forge");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "profile.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      name: "Forge, generated",
      systems: [{ id: "gen", name: "Gen", boundary: "product", owner: "team-gen", aliases: [] }],
      environments: ["dev"],
    }),
  );
  await writeFile(
    join(dir, "repos.manifest.yaml"),
    stringify({
      schemaVersion: 3,
      platform: "forge",
      repos: repos.map((id) => ({
        id,
        url: `https://git.forge.example/gen/${id}.git`,
        type: "spring-boot",
        owner: "team-gen",
        component: id,
        system: "gen",
        hosts: [`${id}.forge.internal`],
      })),
    }),
  );
  await mkdir(join(root, "facts"), { recursive: true });
  const C = { verified: "line", by: "assistant", conf: "declared", commit: COMMIT };
  for (let r = 0; r < REPOS; r++) {
    const repo = repos[r]!;
    const next = repos[(r + 1) % REPOS]!;
    const lines: string[] = [];
    const put = (f: Record<string, unknown>) => lines.push(JSON.stringify({ repo, ...f, ...C }));
    for (let e = 0; e < ENTRIES; e++) {
      put({
        kind: "entry",
        id: `entry.get.r${r}-e${e}`,
        entryType: "rest",
        method: "GET",
        path: `/r${r}/e${e}`,
        cite: { file: "src/App.java", line: e + 1, value: `/r${r}/e${e}` },
      });
      put({
        kind: "call",
        id: `call.get.r${(r + 1) % REPOS}-e${e}`,
        callType: "rest",
        method: "GET",
        host: `${next}.forge.internal`,
        path: `/r${(r + 1) % REPOS}/e${e}`,
        cite: { file: "src/Client.java", line: e + 1, value: `/r${(r + 1) % REPOS}/e${e}` },
      });
      for (let f = 0; f < FIELDS; f++)
        for (const owner of [`entry.get.r${r}-e${e}`, `call.get.r${(r + 1) % REPOS}-e${e}`])
          put({
            kind: "field",
            id: `field.${owner}.response.n${f}`,
            owner,
            side: "response",
            name: `n${f}`,
            type: "string",
            cite: { file: "src/Dto.java", line: f + 1, value: `n${f}` },
          });
    }
    await writeFile(join(root, "facts", `${repo}.jsonl`), lines.join("\n") + "\n");
  }
  return root;
}

const cpu = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = process.cpuUsage();
  const v = await fn();
  const u = process.cpuUsage(t);
  return [v, (u.user + u.system) / 1000];
};

describe("the contract check, kept per metarepo", () => {
  it(
    "is worked out once and reused while nothing on file changes",
    async () => {
      const root = await estate();
      const [first] = await cpu(() => contractCheckOf(root));
      expect(first.result.counts).toMatchObject({
        links: REPOS * ENTRIES,
        compared: REPOS * ENTRIES,
      });
      // The second ask (another view, or the canvas opened again) only looks at the files' times.
      const [second, ms] = await cpu(() => contractCheckOf(root));
      expect(second).toBe(first);
      expect(ms).toBeLessThan(250);
      // Two asks at once share one check.
      const [a, b] = await Promise.all([contractCheckOf(root), contractCheckOf(root)]);
      expect(a).toBe(first);
      expect(b).toBe(first);
      expect((await contractsView(root)).counts).toEqual(first.result.counts);
    },
    ROOM,
  );

  it(
    "is worked out again when a file of facts/, the org pack or the inputs changes",
    async () => {
      const root = await estate();
      const first = await contractCheckOf(root);
      const later = new Date(Date.now() + 60_000);
      await utimes(join(root, "facts", "forge-gen-3.jsonl"), later, later);
      const second = await contractCheckOf(root);
      expect(second).not.toBe(first);
      expect(second.result).toEqual(first.result);
      await writeFile(join(root, "org-pack", "notes.txt"), "a person's note\n");
      const third = await contractCheckOf(root);
      expect(third).not.toBe(second);
      await mkdir(join(root, "inputs"), { recursive: true });
      await writeFile(join(root, "inputs", "readme.txt"), "taken in\n");
      expect(await contractCheckOf(root)).not.toBe(third);
    },
    ROOM,
  );

  it(
    "keeps each metarepo's apart",
    async () => {
      const [x, y] = [await estate(), await estate()];
      const a = await contractCheckOf(x);
      const b = await contractCheckOf(y);
      expect(a).not.toBe(b);
      expect(await contractCheckOf(x)).toBe(a);
    },
    ROOM,
  );
});
