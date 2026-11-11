import { describe, expect, it } from "vitest";
import { itemKey, paletteItems } from "../src/app/palette.js";
import { layoutCommands, panelCommands } from "../src/app/App.js";

describe("the palette's items (beta.26 CI)", () => {
  it("have a key of their own, the bottom panel's commands included", () => {
    const cmds = [...layoutCommands("ide", () => {}), ...panelCommands()];
    for (const typed of ["a", "e", "s", "o", "panel"]) {
      const keys = paletteItems(typed, [], [], cmds).map(itemKey);
      expect(new Set(keys).size, typed).toBe(keys.length);
    }
  });

  it("offer no command for words none of them is found by", () => {
    const cmds = [...layoutCommands("ide", () => {}), ...panelCommands()];
    expect(paletteItems("governance", [], [], cmds).map((i) => i.kind)).not.toContain("command");
  });
});
