import { describe, expect, it } from "vitest";
import { liveTrees, parseSyntax } from "../src/index.js";

/**
 * The native memory cause of the worker crashes ("Fatal process out of memory: Zone", exit
 * 0x80000003) seen under parallel test load. Tree-sitter grammars are generated C with very
 * large functions; when V8 tiered them up to optimised code it needed up to 2.2 GB of transient
 * compiler memory (measured with the TSX grammar, 1.3 GB with TypeScript, 0.5 GB with Kotlin),
 * and a worker died whenever the machine didn't have it. Grammars now run as baseline code only:
 * parsing hundreds of TSX files stays at a few hundred MB. Its own file, so the peak it reads is
 * this test's.
 */
describe("tree-sitter memory", () => {
  it("parses TSX hundreds of times without the optimising compiler's memory spike", async () => {
    const text =
      "export const Card = (x: number) => <div onClick={() => fetch(`/api/cards/${x}`)}>{x}</div>;\n".repeat(
        200,
      );
    const before = liveTrees();
    for (let i = 0; i < 300; i++) (await parseSyntax("tsx", text)).delete();
    // Give background compile jobs time to start, as they did before the fix.
    await new Promise((r) => setTimeout(r, 1000));
    for (let i = 0; i < 50; i++) (await parseSyntax("tsx", text)).delete();
    expect(liveTrees()).toBe(before);
    // maxRSS is the process's peak, in KB. With tier-up it passed 2 GB.
    expect(process.resourceUsage().maxRSS / 1024).toBeLessThan(700);
  }, 120_000);
});
