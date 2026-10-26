import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { openIndex } from "../src/index.js";
import { FIX, RETRIEVAL } from "./helpers.js";

/**
 * ADR 0124 addendum A-ledger (trial problem 7): a call out of the estate is an Interface with its
 * method and path and no Endpoint of its own, because nobody reads a vendor's code. The index knew
 * an endpoint name only from an Endpoint record, so `POST /messages` and `POST /chat/completions`
 * were listed as gaps at the architecture stage ("names that neither the catalog, the knowledge,
 * the specs nor the code has") although the catalog held both calls. No model, no network.
 */

async function records(root: string, dir: string, file: string) {
  for (const r of parse(readFileSync(file, "utf8")) as Record<string, unknown>[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** The Forge estate plus the calls out to Thornefield Models, an invented model provider. */
async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-outside-calls-"));
  await cp(join(FIX, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await records(root, "catalog/generated", join(FIX, "forge/expected/scan.yaml"));
  await records(root, "catalog/generated", join(RETRIEVAL, "outside-calls.yaml"));
  return root;
}

describe("a call out of the estate is a name the catalog has (A-ledger)", () => {
  it("knows an outside call by its method and path, with no Endpoint record", async () => {
    const ix = await openIndex(await estate());
    const s = ix.selectContext(
      {
        title: "Summarise a transfer for the customer",
        text: "The ledger asks Thornefield Models for a summary with `POST /messages`, falling back to `POST /chat/completions`.\n",
      },
      { budget: 4000 },
    );
    expect(s.unknown).toEqual([]);
    // The call's own record is selected, so the step reads what the catalog holds about it.
    expect(s.picked.map((p) => p.id)).toContain("if-a358633ab639503b");
    ix.close();
  });

  it("an outside call the catalog doesn't hold is still a gap", async () => {
    const ix = await openIndex(await estate());
    const s = ix.selectContext(
      { text: "Score the transfer with `POST /v1/risk/score` first.\n" },
      { budget: 4000 },
    );
    expect(s.unknown).toEqual(["POST /v1/risk/score"]);
    ix.close();
  });

  it("names the endpoint of a hop inside the estate the same way", async () => {
    const ix = await openIndex(await estate());
    // if-d99f508a2ac9b6e0 is portal-bff → ledger-api, POST /transfers.
    const s = ix.selectContext({ text: "Change the `POST /transfers` hop.\n" }, { budget: 4000 });
    expect(s.unknown).toEqual([]);
    ix.close();
  });
});
