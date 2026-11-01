import { afterEach, describe, expect, it } from "vitest";
import type { OrgPack } from "@maycombhq/core";
import { memorySource } from "@maycombhq/verify";
import { taughtIn } from "../src/map-commands.js";

/**
 * G4: a framework taught in the org pack is given to the reader while the `framework-models`
 * helper is on, and not when a run switches it off (ATTICUS_HELPERS_OFF): the reader then reads
 * the house layer as ordinary code and asks about what it can't place.
 */

const op = {
  frameworks: [
    { name: "forge-starter", packages: ["forge.starter"], artifacts: ["forge:forge-starter"] },
  ],
} as unknown as OrgPack;
const src = memorySource({
  "pom.xml":
    "<project>\n  <dependency>\n    <artifactId>forge-starter</artifactId>\n  </dependency>\n</project>\n",
});

afterEach(() => {
  delete process.env.ATTICUS_HELPERS_OFF;
});

describe("the framework models helper", () => {
  it("gives the taught framework the build file declares, and none when switched off", () => {
    expect(taughtIn(src, op).map((m) => m.name)).toEqual(["forge-starter"]);
    process.env.ATTICUS_HELPERS_OFF = "framework-models";
    expect(taughtIn(src, op)).toEqual([]);
    process.env.ATTICUS_HELPERS_OFF = "all";
    expect(taughtIn(src, op)).toEqual([]);
  });
});
