import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { scanEstate, serializeReadersSlot } from "@maycombhq/scanner";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * The Forge golden slots (ADR 0195 point 6, CS1): fixtures/forge/slots/ holds what the readers
 * read of each repo of fixtures/forge/repos/ (`readers/<repo>.json`) and the facts snapshot a
 * successful `verify forge-ledger --write` takes of packages/verify/test/fixtures
 * (`facts/forge-ledger.*`). They are golden files of the writers' output, reviewed as such:
 * this test makes them again and checks every byte, so regenerating changes nothing.
 * `pnpm fixtures:slots` (UPDATE_GOLDEN=1) rewrites them after a review. The legacy joins,
 * build.json and the dismissals are hand-made examples, checked in the scanner's slot tests.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const VERIFY = join(HERE, "../../verify/test/fixtures");
const update = process.env.UPDATE_GOLDEN === "1";
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function golden(rel: string, text: string): Promise<void> {
  const path = join(SLOTS, ...rel.split("/"));
  if (update) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  expect(text, rel).toBe(readFileSync(path, "utf8"));
}

describe("the Forge golden slots are what the writers write (ADR 0195, CS1)", () => {
  it("the readers slot of every Forge repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-forge-slots-"));
    made.push(root);
    const scan = await scanEstate({
      root,
      orgPack: join(FORGE, "metarepo/org-pack"),
      repoDir: (id) => join(FORGE, "repos", id),
      repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
      cache: null,
      inputsDir: null,
      scannedAt: "2026-10-18T09:00:00Z",
    });
    expect(scan.problems).toEqual([]);
    const repos = readdirSync(join(FORGE, "repos")).sort();
    expect(scan.observations.map((o) => [o.repo, o.full]).sort()).toEqual(
      repos.map((r) => [r, true]),
    );
    for (const o of scan.observations)
      if (o.full) await golden(`readers/${o.repo}.json`, serializeReadersSlot(o.slot));
  }, 180_000);

  it("the facts snapshot of forge-ledger after a successful verify --write", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-forge-slots-v-"));
    made.push(root);
    await cp(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
    await cp(join(VERIFY, "metarepo", "catalog"), join(root, "catalog"), { recursive: true });
    const dir = join(root, "workspace", "forge-ledger");
    await cp(join(VERIFY, "repo"), dir, { recursive: true });
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(
      join(root, "facts", "forge-ledger.jsonl"),
      await readFile(join(VERIFY, "forge-ledger.facts.jsonl")),
    );
    const err: string[] = [];
    const code = await verifyCommand(
      root,
      "forge-ledger",
      { commit: "0123abc", dir, write: true },
      { out: () => undefined, err: (l) => err.push(l) },
    );
    expect(code, err.join("\n")).toBe(0);
    for (const f of ["forge-ledger.jsonl", "forge-ledger.meta.json"]) {
      const p = join(root, "catalog", "sources", "facts", f);
      expect(existsSync(p), f).toBe(true);
      await golden(`facts/${f}`, readFileSync(p, "utf8"));
    }
  }, 180_000);
});
