import { describe, expect, it } from "vitest";
import { paletteItems } from "../src/app/palette.js";

describe("the command palette", () => {
  const changes = [
    { id: "add-transfer-limit", title: "Add a daily transfer limit", state: "plan" },
  ];
  const records = [
    { kind: "Component", id: "ledger-api" },
    { kind: "Capability", id: "feature.transfers", name: "Transfers" },
  ];

  it("lists screens first, then changes and records, then an Ask line", () => {
    const items = paletteItems("trans", changes, records);
    expect(items.map((i) => i.kind)).toEqual(["change", "record", "record", "ask"]);
    expect(items[0]!.href).toBe("#/changes/add-transfer-limit");
    expect(items[2]!.href).toBe("#/features?id=feature.transfers");
    expect(items.at(-1)!.href).toBe("#/explore?ask=trans");
  });

  it("matches screens by name and offers no Ask line for an empty box", () => {
    expect(paletteItems("impact", [], [])[0]).toMatchObject({ kind: "screen", href: "#/impact" });
    expect(paletteItems("", [], []).some((i) => i.kind === "ask")).toBe(false);
  });
});
