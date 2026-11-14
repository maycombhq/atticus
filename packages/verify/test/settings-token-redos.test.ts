import { describe, expect, it } from "vitest";
import { configLineProblem } from "../src/settings-path.js";

/**
 * The hunt of beta.28.1 (N1): a `with` line of a YAML file that sets a deploy token was matched
 * with a pattern that backtracks on long runs of spaces (4,000 spaces took 36 s). A line of
 * 16,000 spaces, or a word and 16,000 spaces with no colon, is read in well under 500 ms; a token
 * set on a key line still holds. Invented Forge files.
 */

const Y = "src/main/resources/application.yml";
const W = "deploy/values.yml";
const check = (withLine: string) => {
  const files: Record<string, string[]> = {
    [Y]: ["forge-ledger:", "  schema: '@FORGE_SCHEMA@'"],
    [W]: ["# Forge deploy values", withLine],
  };
  const t = Date.now();
  const problem = configLineProblem(
    {
      key: "forge-ledger.schema",
      value: "ledger_core",
      cite: { file: Y, line: 2, with: [{ file: W, line: 2, value: "ledger_core" }] },
    },
    (p) => files[p],
    () => Object.keys(files),
  );
  return { problem, ms: Date.now() - t };
};

describe("a token's `with` line is read in linear time", () => {
  for (const [what, line] of [
    ["16,000 spaces", " ".repeat(16_000)],
    ["a word and 16,000 spaces", `forge${" ".repeat(16_000)}`],
    ["a quote, a word and 16,000 spaces", `"forge${" ".repeat(16_000)}x`],
    ["a word, 16,000 spaces and a word", `forge${" ".repeat(16_000)}ledger`],
  ] as const)
    it(`${what}: under 500 ms, and it sets nothing`, () => {
      const r = check(line);
      // Wall time on a slow CI machine (Windows); the old form took 36 s at 4,000 spaces.
      expect(r.ms).toBeLessThan(500);
      expect(r.problem).toMatch(/to the token @FORGE_SCHEMA@/);
    });

  it("a key line with spaces around it still sets the token", () => {
    expect(check("FORGE_SCHEMA  :   ledger_core   ").problem).toBeUndefined();
    expect(check('"FORGE_SCHEMA": ledger_core').problem).toBeUndefined();
  });
});
