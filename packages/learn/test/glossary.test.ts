import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explain, PRODUCT_TERMS, termNamed } from "../src/index.js";

/**
 * The words nobody outside Atticus knows (WP5.1): one plain sentence each, for `atticus explain
 * <term>` and the app's "What the words mean". The app's copy holds the same list; this test
 * fails when the two differ.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe("the product glossary (WP5.1)", () => {
  it("says each of Atticus's own words in one plain sentence, found by its name or another it goes by", () => {
    const names = PRODUCT_TERMS.map((t) => t.term);
    for (const w of [
      "metarepo",
      "org pack",
      "hand-off",
      "gate",
      "lens",
      "critic",
      "target flow",
      "dialect",
      "base clone",
      "estate",
      "service desk",
    ])
      expect(names, w).toContain(w);
    for (const t of PRODUCT_TERMS) {
      expect(t.says.trim().length, t.term).toBeGreaterThan(20);
      expect(t.says, t.term).toMatch(/[.]$/);
    }
    expect(termNamed("Hand-off PR")?.term).toBe("hand-off");
    expect(termNamed("org-pack")?.term).toBe("org pack");
    expect(termNamed("snow")?.term).toBe("service desk");
    expect(termNamed("nothing like it")).toBeUndefined();
  });

  it("is what atticus explain says for a term, after ids and before a command's name", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-glossary-"));
    await mkdir(join(root, "catalog", "generated"), { recursive: true });
    const e = await explain(root, "gate");
    expect(e.kind).toBe("term");
    expect(e.title).toBe("gate");
    expect(e.lines[0]).toBe(termNamed("gate")!.says);
    expect((await explain(root, "atticus scan")).kind).toBe("command");
    // what verify's help points to (feedback from the A4 run)
    expect((await explain(root, "verify")).kind).toBe("command");
    expect((await explain(root, "atticus map")).title).toMatch(/^atticus map:/);
    expect((await explain(root, "atticus map render")).title).toMatch(/^atticus map render:/);
    expect((await explain(root, "atticus change knowledge")).kind).toBe("command");
  });

  it("is the same list as the app's What the words mean", async () => {
    const copyFile = join(HERE, "../../ui/src/copy.ts");
    const { COPY } = (await import(copyFile)) as {
      COPY: { glossary: { terms: { term: string; says: string }[] } };
    };
    expect(COPY.glossary.terms).toEqual(PRODUCT_TERMS.map(({ term, says }) => ({ term, says })));
  });
});
