import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEWER_ATTICUS_COMMAND, WORDS_LINK } from "@maycombhq/scanner";
import { addressRefusal } from "../src/model-address.js";
import { newerWords } from "../src/upgrade.js";

/**
 * v30 slice 8 (messages lead with what to do): the longest refusals and build messages are three
 * lines: what to do first, then what happened, then what wasn't changed (when true). A house
 * word left in one points at the glossary (docs/guide/words.md).
 */
describe("a long refusal in three lines", () => {
  it("a metarepo stamped by an Atticus this one can't read: the install, what, nothing changed", () => {
    const lines = newerWords({
      atticus: "2.0.0-beta.30",
      newer: true,
      unreadStamp: { why: "it doesn't read as YAML" },
      pending: [],
    }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^This metarepo was upgraded by a newer or unknown Atticus/);
    expect(lines[2]).toBe("Nothing was changed.");
    expect(lines[0]).toMatch(
      /^Install the newer Atticus before working here \(npm i -g @maycombhq\/atticus@beta\)/,
    );
    expect(lines[0]).toContain("git checkout -- .atticus/metarepo.yaml");
    // The install is the scanner's one command for a newer Atticus no stamp names (90d860cf).
    expect(lines[0]).toContain(`(${NEWER_ATTICUS_COMMAND})`);
  });

  it("a model address not confirmed: where to confirm, what, nothing sent", async () => {
    const root = await mkdtemp(join(tmpdir(), "b30-three-lines-"));
    const said = await addressRefusal(root, {
      type: "openai-compatible",
      settings: { baseUrl: "https://llm.example/v1" },
    });
    const lines = said!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Open AI settings in the Atticus app and press Test/);
    expect(lines[1]).toMatch(
      /^runtime\.yaml sends the model's key to .*, which you haven't confirmed/,
    );
    expect(lines[2]).toBe("Nothing was sent.");
  });

  it("a refused build says once, first, that only the catalog is unchanged", async () => {
    const { catalogUnchanged } = await import("@maycombhq/scanner");
    expect(catalogUnchanged("catalog/generated")).toBe(
      "The catalog wasn't changed: catalog/generated is as it was.",
    );
  });

  it("points at the glossary for a house word", () => {
    expect(WORDS_LINK).toBe("Words: docs/guide/words.md.");
  });
});
