import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { joinMeasure } from "../src/measure-commands.js";

/**
 * atticus join measure <reference> (plan item R5): a person's map measured against the entries
 * and calls they listed by hand, read from their metarepo. Here the metarepo holds the invented
 * bank-shaped estate of fixtures/link-estate (P1) and its reference.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-measure-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  await mkdir(join(root, "measure"));
  await cp(join(FIX, "reference-links.yaml"), join(root, "measure", "links.yaml"));
  return root;
}

const tree = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .map((e) => join(e.parentPath, e.name).slice(dir.length))
    .sort();

describe("atticus join measure", () => {
  it("prints reading recall, join precision and recall, and each call, and writes nothing", async () => {
    const root = await metarepo();
    const before = await tree(root);
    const c = capture();
    expect(await joinMeasure(root, "measure/links.yaml", {}, c.io)).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.slice(0, 5)).toEqual([
      "Measured against measure/links.yaml (forge-bank): 9 repos, 15 entries and 17 calls listed.",
      "Reading: 15 of 15 entries and 16 of 17 calls are in the facts (97%).",
      "Join precision 0.889: 8 of the 9 listed calls joined to a repo reach the one you named.",
      "Join recall 0.615: 8 of the 13 calls that should reach a repo of the estate do.",
      "4 asked, 3 guessed (2 right), 2 of 4 outside right, 1 unlinked, 1 not read.",
    ]);
    expect(c.out).toContain(
      "  ok  forge-portal-bff GET /forge/accounts/v1/accounts/{id}: wanted forge-accounts, got forge-accounts GET /accounts/{id} via forge-proxy-accounts-v1",
    );
    expect(c.out).toContain(
      "  --  forge-accounts POST /events: wanted outside harbor-audit, got forge-notifications POST /events (a guess: joined-by-path)",
    );
    expect(c.out).toContain(
      "  --  forge-payments POST /accounts/{id}/debits: wanted forge-accounts, got asked (unknown-host): atticus questions",
    );
    expect(c.out).toContain("  forge-portal-bff call GET /forge/payments/v1/payments/{id}");
    expect(c.out.at(-1)).toBe("Nothing was written.");
    expect(await tree(root)).toEqual(before);
  });

  it("gives the measure as JSON with --json", async () => {
    const root = await metarepo();
    const c = capture();
    expect(await joinMeasure(root, join(root, "measure/links.yaml"), { json: true }, c.io)).toBe(0);
    const m = JSON.parse(c.out.join("\n"));
    expect(m.links).toMatchObject({ precision: 0.889, recall: 0.615, asked: 4 });
    expect(m.reading.calls).toEqual({ want: 17, found: 16 });
    expect(m.calls).toHaveLength(17);
  });

  it("says what is wrong with a reference, where, and exits 2", async () => {
    const root = await metarepo();
    await writeFile(
      join(root, "measure", "bad.yaml"),
      "repos:\n  - repo: forge-cards\n    calls:\n      - { call: GET /x }\n",
    );
    const c = capture();
    expect(await joinMeasure(root, "measure/bad.yaml", {}, c.io)).toBe(2);
    expect(c.err).toEqual([
      "measure/bad.yaml isn't a reference Atticus can read:",
      "  repos.0.calls.0: give one of reaches (a repo, or none) and outside (a system)",
    ]);
  });

  it("says how to start when the file isn't there, or no file is named", async () => {
    const root = await metarepo();
    const c = capture();
    expect(await joinMeasure(root, "measure/none.yaml", {}, c.io)).toBe(2);
    expect(c.err[0]).toMatch(/^There is no reference file at measure\/none.yaml/);
    const d = capture();
    expect(await joinMeasure(root, undefined, {}, d.io)).toBe(2);
    expect(d.err).toEqual([
      "Usage: atticus join measure <reference.yaml> [--json] (docs/guide/measure.md)",
    ]);
  });

  it("notes a listed repo with no verified facts", async () => {
    const root = await metarepo();
    await writeFile(
      join(root, "measure", "one.yaml"),
      "repos:\n  - repo: forge-ledger\n    entries: [GET /ledger]\n",
    );
    const c = capture();
    expect(await joinMeasure(root, "measure/one.yaml", {}, c.io)).toBe(0);
    expect(c.out).toContain(
      "forge-ledger: no verified facts in the estate, so nothing of it is found (atticus map forge-ledger, then atticus verify forge-ledger).",
    );
  });
});
