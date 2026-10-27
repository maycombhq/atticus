import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { newChange } from "@maycombhq/changes";
import { scanEstate } from "@maycombhq/scanner";
import {
  absorb,
  adopt,
  federationConflicts,
  federatedChanges,
  federatedSources,
  hashTree,
  listDirs,
  resolveMetarepo,
} from "../src/index.js";
import { cleanup, COMMIT, copyFixture, SCANNED_AT } from "./helpers.js";

afterAll(cleanup);

const state = async () => ({ commit: COMMIT, dirty: false });

/**
 * Atticus never writes where it was only asked to read (hard rule 6, ADR 0038, ADR 0119
 * addendum). Absorb, federation and the conflict check all read another team's metarepo; each
 * one is measured here against a byte-level fingerprint of the whole source — every file, its
 * path and its bytes, and every folder, so an empty one is caught too — taken before the read
 * and compared after. A record cache, a lock, a log or a `.gitignore` of ours landing in their
 * repo fails this test.
 *
 * The source is a copy of the fixture, never the committed fixture itself: a regression here
 * must fail a test, not dirty the repository.
 */

interface Print {
  files: Record<string, string>;
  dirs: string[];
}

const print = async (dir: string): Promise<Print> => ({
  files: await hashTree(dir),
  dirs: await listDirs(dir),
});

/** Their metarepo, as a copy, and ours, adopted in place beside it. */
async function estates(): Promise<{ ours: string; theirs: string }> {
  const theirs = await copyFixture("atticus-metarepo", "payments-meta");
  const ours = await copyFixture("openspec-repo", "catalog-service");
  await adopt(ours);
  return { ours, theirs };
}

/** Add the absorbed entry to our sources.yaml, as the reviewer of the proposal does. */
async function link(ours: string, entry: unknown): Promise<void> {
  const p = await resolveMetarepo(ours);
  const file = join(p.orgPackDir, "sources.yaml");
  const sources = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  sources.absorbed = [entry];
  await writeFile(file, stringify(sources), "utf8");
}

describe("reading another metarepo leaves it byte-identical", () => {
  it("absorb reads their metarepo and writes nothing into it", async () => {
    const { ours, theirs } = await estates();
    const before = await print(theirs);
    const r = await absorb(ours, theirs, { id: "payments" });
    expect(r.format).toBe("atticus");
    expect(r.problems).toEqual([]);
    expect(await print(theirs)).toEqual(before);
    // And nothing of theirs is listed as content of theirs: no cache of ours to translate.
    expect(r.items.filter((i) => i.path.startsWith(".atticus"))).toEqual([]);
  });

  it("passes over their own local state rather than listing it as content", async () => {
    // A linked estate has run Atticus itself, so its own record cache, log and index are on
    // disk. They are that machine's derived files, not their work: absorb leaves them out.
    const { ours, theirs } = await estates();
    await mkdir(join(theirs, ".atticus", "cache"), { recursive: true });
    await writeFile(join(theirs, ".atticus", "cache", "catalog-abc123.json"), "{}", "utf8");
    await mkdir(join(theirs, ".atticus", "logs"), { recursive: true });
    await writeFile(join(theirs, ".atticus", "logs", "atticus.log"), "ran\n", "utf8");
    await mkdir(join(theirs, ".runs", "add-refunds"), { recursive: true });
    await writeFile(join(theirs, ".runs", "add-refunds", "prompt.md"), "theirs\n", "utf8");
    const before = await print(theirs);
    const r = await absorb(ours, theirs, { id: "payments" });
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => i.path).filter((p) => /^(\.atticus|\.runs)\//.test(p))).toEqual([]);
    expect(await print(theirs)).toEqual(before);
  });

  it("a second absorb of the same source still writes nothing into it", async () => {
    const { ours, theirs } = await estates();
    await absorb(ours, theirs, { id: "payments" });
    const before = await print(theirs);
    await absorb(ours, theirs, { id: "payments" });
    expect(await print(theirs)).toEqual(before);
  });

  it("a scan with their catalog federated writes nothing into theirs", async () => {
    const { ours, theirs } = await estates();
    const r = await absorb(ours, theirs, { id: "payments" });
    await link(ours, r.entry);
    expect(await federatedSources(ours)).toEqual([{ id: "payments", dir: theirs }]);
    const before = await print(theirs);
    const scan = await scanEstate({ root: ours, repoState: state, scannedAt: SCANNED_AT });
    expect(scan.problems).toEqual([]);
    expect(scan.federated).toEqual([
      { id: "payments", added: 3, shadowed: ["Component/catalog-service"] },
    ]);
    expect(await print(theirs)).toEqual(before);
    // Twice: the second scan is the one that would read a cache, so it is the one that would
    // have written it.
    await scanEstate({ root: ours, repoState: state, scannedAt: SCANNED_AT });
    expect(await print(theirs)).toEqual(before);
  });

  it("the conflict check reads their changes and specs and writes nothing into theirs", async () => {
    const { ours, theirs } = await estates();
    const r = await absorb(ours, theirs, { id: "payments" });
    await link(ours, r.entry);
    await newChange(ours, {
      id: "add-product-notes",
      title: "Add product notes",
      type: "feature",
      by: "pat",
      systems: ["catalog-service"],
      now: SCANNED_AT,
    });
    const before = await print(theirs);
    expect((await federatedChanges(await federatedSources(ours))).length).toBe(1);
    await federationConflicts(ours);
    await federationConflicts(ours);
    expect(await print(theirs)).toEqual(before);
  });
});
