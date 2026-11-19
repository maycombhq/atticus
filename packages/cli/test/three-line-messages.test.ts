import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORDS_LINK } from "@maycombhq/scanner";
import { addressRefusal } from "../src/model-address.js";
import { newerWords } from "../src/upgrade.js";

/**
 * v30 slice 8 (messages lead with what to do): the longest refusals and build messages are three
 * lines: what happened, that nothing was changed (when true), then the command. A house word
 * left in one points at the glossary (docs/guide/words.md).
 */
describe("a long refusal in three lines", () => {
  it("a metarepo stamped by an Atticus this one can't read: what, nothing changed, the install", () => {
    const lines = newerWords({
      atticus: "2.0.0-beta.30",
      newer: true,
      unreadStamp: { why: "it doesn't read as YAML" },
      pending: [],
    }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^This metarepo was upgraded by a newer or unknown Atticus/);
    expect(lines[1]).toBe("Nothing was changed.");
    expect(lines[2]).toMatch(
      /^Install the newer Atticus before working here \(npm i -g @maycombhq\/atticus@beta\)/,
    );
    expect(lines[2]).toContain("git checkout -- .atticus/metarepo.yaml");
  });

  it("a model address not confirmed: what, nothing sent, where to confirm", async () => {
    const root = await mkdtemp(join(tmpdir(), "b30-three-lines-"));
    const said = await addressRefusal(root, {
      type: "openai-compatible",
      settings: { baseUrl: "https://llm.example/v1" },
    });
    const lines = said!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^runtime\.yaml sends the model's key to .*, which you haven't confirmed/,
    );
    expect(lines[1]).toBe("Nothing was sent.");
    expect(lines[2]).toMatch(/^Open AI settings in the Atticus app and press Test/);
  });

  it("points at the glossary for a house word", () => {
    expect(WORDS_LINK).toBe("Words: docs/guide/words.md.");
  });
});
