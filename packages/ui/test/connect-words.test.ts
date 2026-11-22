import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { WORDS } from "../src/screens/architecture/words.js";

/**
 * Plain words (v30 slice 8, docs/guide/words.md) in Connect's own words: the keys slice 8 left
 * to the Connect slice say the glossary's names (Map, Read status, call with no arrow, your
 * changes, outside system, Set up › Activity › …), and a refusal leads with what to do.
 */

/** Every string a copy value says: functions are called with placeholder words and numbers. */
function said(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") {
    for (const args of [
      ["forge-orders", "forge-ledger", "forge-billing", "q-1", "x"],
      ["forge-orders", 2, "forge-ledger", "x", true],
      [
        "forge-orders",
        { here: 1, drawn: 1, waiting: 1, gone: 1, inside: 1, onward: 1 },
        "pat",
        "forge-ledger",
      ],
    ])
      try {
        said((v as (...a: unknown[]) => unknown)(...args), out);
      } catch {
        // A word that takes other arguments: the others cover it.
      }
  } else if (v && typeof v === "object") for (const x of Object.values(v)) said(x, out);
  return out;
}

const OLD = [
  /Map › Trust/,
  /\bpicture\b/i,
  /loose calls?\b/i,
  /Corrections and declarations/,
  /Estate (map|canvas)/,
  /Set up › Scans › Catalog builds/,
  /curated decision/,
  /\bthe canvas\b/i,
];

describe("Connect's words use the glossary's names (slice 8 and ADR 0204)", () => {
  const C = COPY as unknown as Record<string, Record<string, unknown>>;
  const blocks: Record<string, unknown> = {
    "editMap.add": (C.editMap as Record<string, unknown>).add,
    "editMap.doneWaits": C.editMap!.doneWaits,
    declare: C.declare,
    connect: C.connect,
    corrections: C.corrections,
    addBox: C.addBox,
    connectAB: C.connectAB,
    "commandCenter.corrections": (C.commandCenter as Record<string, Record<string, unknown>>).home
      ?.corrections,
    why: C.why,
    architecture: WORDS,
  };
  for (const [name, block] of Object.entries(blocks))
    it(`${name} says no old name`, () => {
      const words = said(block);
      expect(words.length, name).toBeGreaterThan(0);
      for (const w of words) for (const old of OLD) expect(w, `${name}: ${w}`).not.toMatch(old);
    });

  it("calls the box's list of what people told Atticus Your changes, as the glossary does", () => {
    expect(COPY.corrections.title).toBe("Your changes");
    expect(COPY.connect.undoHow("forge-orders")).toContain("Your changes");
    expect(COPY.addBox.open).toBe("Add to the map…");
  });

  it("leads a refusal with what to do", () => {
    expect(COPY.declare.noProfile("Harbor Unknown", "harbor-unknown")).toMatch(
      /^Add Harbor Unknown/,
    );
    expect(COPY.declare.noGateways).toMatch(/^Read the gateway's repo first/);
    expect(COPY.connect.dropNoRepo("Forge Rewards")).toMatch(/^Add Forge Rewards's repo/);
    expect(COPY.editMap.add.noApis("forge-ledger")).toMatch(/^Read forge-ledger first/);
    expect(COPY.editMap.add.fromNone).toMatch(/^Add an outside system/);
  });
});
