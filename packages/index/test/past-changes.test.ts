import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "@maycombhq/ai";
import { openIndex, searchIndex } from "../src/index.js";
import { FIX, retrievalRoot } from "./helpers.js";

// WP7.6: archived changes are indexed as PastChange, found only when asked for by kind, so a
// new brief can start from the earlier change most like it while no step's context changes.

async function withArchive(): Promise<string> {
  const root = await retrievalRoot();
  await cp(join(FIX, "past-changes"), join(root, "openspec/changes/archive"), {
    recursive: true,
    filter: (src) => !src.endsWith("README.md"),
  });
  return root;
}

const BRIEF =
  "Let premium accounts send more per day: the daily transfer limit for premium accounts goes up.";

describe("past changes (WP7.6)", () => {
  it("indexes each archived change once, from its brief, with no links and no names", async () => {
    const ix = await openIndex(await withArchive());
    const rows = ix.db
      .prepare("SELECT key, id, name FROM nodes WHERE kind = 'PastChange' ORDER BY key")
      .all() as { key: string; id: string; name: string }[];
    expect(rows).toEqual([
      {
        key: "change:PastChange:2026-05-12-raise-transfer-limit",
        id: "2026-05-12-raise-transfer-limit",
        name: "Raise the daily transfer limit for business accounts",
      },
      {
        key: "change:PastChange:2026-06-03-order-receipt-email",
        id: "2026-06-03-order-receipt-email",
        name: "Email a receipt when an order is placed",
      },
      {
        key: "change:PastChange:2026-07-20-ledger-retention",
        id: "2026-07-20-ledger-retention",
        name: "Keep ledger entries for seven years",
      },
    ]);
    const linked = ix.db
      .prepare("SELECT count(*) AS n FROM links WHERE from_key LIKE 'change:PastChange:%'")
      .get() as { n: number };
    expect(linked.n).toBe(0);
    ix.close();
  });

  it("a search by words finds them only when PastChange is asked for", async () => {
    const ix = await openIndex(await withArchive());
    expect(searchIndex(ix, BRIEF).some((h) => h.kind === "PastChange")).toBe(false);
    const asked = searchIndex(ix, BRIEF, { kinds: ["PastChange"] });
    expect(asked[0]?.id).toBe("2026-05-12-raise-transfer-limit");
    ix.close();
  });

  it("similar in meaning ranks the transfer-limit change first, and selection never picks one", async () => {
    const ix = await openIndex(await withArchive(), { embeddings: new HashEmbedder() });
    await ix.prepare({ text: BRIEF });
    const sim = ix.similar({ text: BRIEF }, { kinds: ["PastChange"], limit: 3, floor: -1 });
    expect("hits" in sim && sim.hits[0]?.key).toBe(
      "change:PastChange:2026-05-12-raise-transfer-limit",
    );
    const any = ix.similar({ text: BRIEF }, { limit: 200, floor: -1 });
    expect("hits" in any && any.hits.some((h) => h.key.includes(":PastChange:"))).toBe(false);
    const s = await ix.select({ text: BRIEF }, { budget: 4000 });
    expect(s.picked.some((p) => p.kind === "PastChange")).toBe(false);
    ix.close();
  });
});
