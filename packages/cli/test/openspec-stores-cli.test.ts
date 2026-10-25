/**
 * ADR 0126 in the CLI: the OpenSpec stores org-pack/openspec.yaml names show in atticus change
 * list (read-only, labelled) and in atticus openspec check's summary; without the file, both are
 * as before. Forge fixtures from fixtures/openspec-stores.
 */
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeList } from "../src/change-commands.js";
import { storeSummaryLines } from "../src/openspec-stores-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const STORES = join(FIXTURES, "openspec-stores");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function metarepo(openspecYaml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-stores-"));
  await cp(join(FIXTURES, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  if (openspecYaml) await writeFile(join(root, "org-pack/openspec.yaml"), openspecYaml);
  return root;
}

const NAMED = `schemaVersion: 1
stores:
  - path: ${join(STORES, "forge-payments-store")}
    label: payments
  - path: ${join(STORES, "unmarked-store")}
`;

describe("atticus change list with OpenSpec stores (ADR 0126)", () => {
  it("is as before when the org pack names no store", async () => {
    const c = capture();
    expect(await changeList(await metarepo(), {}, c.io)).toBe(0);
    expect(c.out).toEqual(["No changes yet. Start one with atticus change new."]);
    expect(c.err).toEqual([]);
  });

  it("lists the stores' open changes after the metarepo's, read-only and labelled", async () => {
    const root = await metarepo(NAMED);
    const c = capture();
    expect(await changeList(root, {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "No changes yet. Start one with atticus change new.",
      "From OpenSpec stores (read-only, beta):",
      "STORE           ID                 TASKS  TITLE",
      "payments        add-refund-window  1/2    Add a refund window",
      "unmarked-store  rename-fee-codes",
    ]);
    expect(c.err).toEqual([
      "OpenSpec store unmarked-store: no .openspec-store/store.yaml: read as a plain OpenSpec folder",
    ]);
  });

  it("marks them in --json, so nothing takes one for a change of the metarepo's", async () => {
    const root = await metarepo(NAMED);
    const c = capture();
    expect(await changeList(root, { json: true }, c.io)).toBe(0);
    expect(JSON.parse(c.out.join("\n"))).toEqual([
      {
        id: "add-refund-window",
        title: "Add a refund window",
        store: "payments",
        readOnly: true,
        tasks: { done: 1, total: 2 },
      },
      { id: "rename-fee-codes", store: "unmarked-store", readOnly: true },
    ]);
  });

  it("says when openspec.yaml doesn't read, and still lists the metarepo's changes", async () => {
    const root = await metarepo("schemaVersion: 1\nstores: payments\n");
    const c = capture();
    expect(await changeList(root, {}, c.io)).toBe(0);
    expect(c.out).toEqual(["No changes yet. Start one with atticus change new."]);
    expect(c.err[0]).toMatch(/^org-pack\/openspec\.yaml: stores: /);
  });
});

describe("the stores' summary in atticus openspec check", () => {
  it("names each store's open changes and specs", async () => {
    expect(await storeSummaryLines(await metarepo())).toEqual({ out: [], err: [] });
    expect(await storeSummaryLines(await metarepo(NAMED))).toEqual({
      out: [
        "OpenSpec store payments (read-only, beta): 1 open change, 2 specs (ledger-postings, refunds)",
        "OpenSpec store unmarked-store (read-only, beta): 1 open change, 0 specs",
      ],
      err: [
        "OpenSpec store unmarked-store: no .openspec-store/store.yaml: read as a plain OpenSpec folder",
      ],
    });
  });
});
