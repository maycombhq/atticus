import { describe, expect, it } from "vitest";
import { personOnlyWhy } from "@maycombhq/ai";
import { commandCatalog } from "../src/command-catalog.js";
import { HELP_TEXT } from "../src/main.js";

/**
 * Review round 34: every command that writes to a shared system once a person adds its approve
 * flag is refused, with that flag, inside a Copilot session, so a new approve flag can't be missed.
 */
describe("the catalog's approve flags", () => {
  const shared = commandCatalog(HELP_TEXT).filter((c) => c.runs === "shared" && c.approve);
  it("has some", () => expect(shared.length).toBeGreaterThan(3));
  it.each(shared.map((c) => [c.id, c.approve!]))("%s %s is a person's", (id, flag) => {
    expect(personOnlyWhy([...id.split(" "), "x", flag])).toBeTruthy();
  });
});
