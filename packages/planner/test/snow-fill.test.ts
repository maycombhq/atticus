import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fillSnowFields, SnowFillError } from "../src/snow.js";

/**
 * Round 36 (UX review): the app fills a draft's missing fields in snow.md, the file a person
 * would edit. Only the value cells of that request's table change (a field the table lacks is
 * added as a row); the comments, the other requests and every other line stay as written, and
 * the "To fill" note of a field now filled goes. Golden files: fixtures/snow-fill.
 */
const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/snow-fill");
const before = readFileSync(join(FX, "before.md"), "utf8");
const after = readFileSync(join(FX, "after.md"), "utf8");
const HEADING = "Gateway proxy deployment: gw-northwind-v2";

describe("fillSnowFields", () => {
  it("writes the values into that request's table and keeps everything else", () => {
    expect(
      fillSnowFields(before, HEADING, {
        target: "ledger-api:8443",
        Justification: "ledger-api calls Northwind Pay's velocity check",
      }),
    ).toBe(after);
  });

  it("keeps Windows line ends", () => {
    const crlf = before.replace(/\n/g, "\r\n");
    expect(fillSnowFields(crlf, HEADING, { Target: "ledger-api:8443" })).toContain(
      "| Target | ledger-api:8443 |\r\n",
    );
  });

  it("refuses a request snow.md doesn't have, a value a table can't hold, or nothing to fill", () => {
    const why = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(SnowFillError);
        return (e as Error).message;
      }
      throw new Error("not refused");
    };
    expect(why(() => fillSnowFields(before, "Nope: x", { Target: "a" }))).toBe(
      'snow.md has no request "Nope: x". Reload the page to see its requests.',
    );
    expect(why(() => fillSnowFields(before, HEADING, { Target: "a | b" }))).toBe(
      "Target: a value can't hold | or a line break (snow.md keeps it in a table cell).",
    );
    expect(why(() => fillSnowFields(before, HEADING, { Target: "a\nb" }))).toMatch(/line break/);
    expect(why(() => fillSnowFields(before, HEADING, {}))).toBe("Give at least one field to fill.");
  });
});
