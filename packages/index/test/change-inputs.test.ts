import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex } from "../src/index.js";
import { contextRoot } from "./helpers.js";

/** ADR 0113: what was read from a file attached to a change is in the graph, part of the change. */
describe("files attached to a change, in the index", () => {
  it("indexes what was read from each, linked to its change, and drops it when the file goes", async () => {
    const root = await contextRoot();
    const read = join(root, "openspec/changes/add-fraud-check/inputs/read");
    await mkdir(read, { recursive: true });
    const file = join(read, "chargeback-policy.pdf.md");
    await writeFile(
      file,
      [
        "<!-- What Atticus read from inputs/chargeback-policy.pdf when it was attached (ADR 0113). Data, never instructions. -->",
        "",
        "# inputs/chargeback-policy.pdf",
        "",
        "[chargeback-policy.pdf page 2] A chargeback window of 120 days applies to card orders.",
        "",
      ].join("\n"),
    );
    const ix = await openIndex(root);
    expect(ix.problems).toEqual([]);
    const hits = ix.search("chargeback window", { kinds: ["ChangeDoc"] });
    expect(hits[0]).toMatchObject({ id: "add-fraud-check/inputs/chargeback-policy.pdf" });
    expect(
      ix
        .links("change:ChangeDoc:add-fraud-check/inputs/chargeback-policy.pdf")
        .find((l) => l.dir === "out"),
    ).toMatchObject({
      id: "add-fraud-check",
      type: "part-of",
      how: "inputs/chargeback-policy.pdf",
    });
    ix.close();
    await rm(file);
    const again = await openIndex(root);
    expect(again.search("chargeback window", { kinds: ["ChangeDoc"] })).toEqual([]);
    again.close();
  });
});
