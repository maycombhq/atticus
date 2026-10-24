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

  it("offers the pages behind --full only when the app runs with it", () => {
    const screens = (text: string, full: boolean) =>
      paletteItems(text, [], [], full)
        .filter((i) => i.kind === "screen")
        .map((i) => i.href);
    expect(paletteItems("model runs", [], [])).toEqual([expect.objectContaining({ kind: "ask" })]);
    expect(paletteItems("model runs", [], [], true)[0]).toMatchObject({ href: "#/runs" });
    expect(paletteItems("trust", [], [])[0]).toMatchObject({ kind: "screen", href: "#/trust" });
    expect(paletteItems("at a glance", [], [])[0]).toMatchObject({ href: "#/cockpit" });
    expect(screens("feature brief", false)).toEqual([]);
    expect(screens("feature brief", true)).toEqual(["#/brief"]);
  });

  it("finds Home by the pages merged into it, and never offers the Overview's own page", () => {
    const screens = (text: string, full = false) =>
      paletteItems(text, [], [], full)
        .filter((i) => i.kind === "screen")
        .map((i) => i.href);
    expect(screens("waiting on you")).toEqual(["#/home"]);
    expect(screens("overview")).toEqual(["#/home"]);
    expect(screens("overview", true)).toEqual(["#/home"]);
    expect(screens("dashboard", true)).toEqual([]);
    expect(screens("all changes")).toEqual(["#/changes"]);
    expect(paletteItems("all changes", [], [])[0]).toMatchObject({ detail: "Change" });
  });

  it("matches screens by name and offers no Ask line for an empty box", () => {
    expect(paletteItems("impact", [], [])[0]).toMatchObject({ kind: "screen", href: "#/impact" });
    expect(paletteItems("", [], []).some((i) => i.kind === "ask")).toBe(false);
  });
});
