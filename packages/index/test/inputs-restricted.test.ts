import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex } from "../src/index.js";

// beta.28.3: a document dropped into inputs/ that says it is restricted (or classified above the
// limit) was indexed with its full text until inputs/ was next synced, since only the newest
// sync's skipped list kept it out. The index is what AI steps and suggested knowledge select from.

async function root(pack?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-inputs-restricted-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
  await mkdir(join(dir, "inputs"), { recursive: true });
  await writeFile(join(dir, "org-pack/sources.yaml"), "schemaVersion: 3\nwikis: []\n");
  if (pack) await writeFile(join(dir, "org-pack/pack.yaml"), pack);
  return dir;
}

const ids = async (dir: string, word: string) => {
  const ix = await openIndex(dir);
  const found = ix
    .search(word, { limit: 20 })
    .map((h) => h.id)
    .sort();
  ix.close();
  return found;
};

describe("inputs/ files the index must not read before any sync", () => {
  it("keeps out a file classified above the limit, under view restrictions, or whose front matter doesn't read", async () => {
    const dir = await root();
    const w = (name: string, text: string) => writeFile(join(dir, "inputs", name), text);
    await w("open.md", "# Open\n\nThe axolotl is a salamander.\n");
    await w(
      "internal.md",
      "---\nclassification: internal\n---\n# Internal\n\nThe axolotl tank is on floor 2.\n",
    );
    await w(
      "secret.md",
      "---\nclassification: restricted\n---\n# Vault\n\nThe axolotl vault code is 4411.\n",
    );
    await w(
      "confidential.md",
      "---\r\nclassification: confidential\r\n---\r\n# Deal\r\n\r\nThe axolotl deal closes in May.\r\n",
    );
    await w("viewers.md", "---\nrestrictions: [board]\n---\n# Board\n\nThe axolotl budget.\n");
    await w("flagged.md", "---\nrestricted: true\n---\n# Flagged\n\nThe axolotl audit.\n");
    await w("odd.md", "---\nclassification: top-secret\n---\n# Odd\n\nThe axolotl codeword.\n");
    await w("spaced.md", "--- \nclassification: restricted\n--- \n# Spaced\n\nThe axolotl key.\n");
    // A file that only starts with a rule has no front matter: it is read, as a sync reads it.
    await w("rule.md", "---\n# Rule\n\nThe axolotl page begins with a rule.\n");
    await w("broken.md", "---\nclassification: [restricted\n---\n# Broken\n\nThe axolotl leak.\n");
    expect(await ids(dir, "axolotl")).toEqual([
      "inputs/internal.md#Internal",
      "inputs/open.md#Open",
    ]);
    expect(await ids(dir, "rule")).toContain("inputs/rule.md#Rule");
  });

  it("goes by the organisation's own levels when pack.yaml lists them", async () => {
    const dir = await root("classification: [open, internal, board-only]\n");
    await writeFile(
      join(dir, "inputs/board.md"),
      "---\nclassification: board-only\n---\n# Board\n\nThe quokka plan.\n",
    );
    await writeFile(
      join(dir, "inputs/all.md"),
      "---\nclassification: open\n---\n# All\n\nThe quokka picnic.\n",
    );
    expect(await ids(dir, "quokka")).toEqual(["inputs/all.md#All"]);
  });
});
