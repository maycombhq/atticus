import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ApplyPairsView } from "../src/screens/map/Decisions.js";

/**
 * ADR 0210 part 4: Map › Decided by AI says what the last Apply's pairing did: drawn as the AI's,
 * dropped with why, withdrawn (their lines changed) and left loose, in the copy file's words, the
 * same words the command line says.
 */
const W = COPY.decisions.applyPairs;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const R: Api.ApplyPairingT = {
  paired: [
    {
      call: "forge-edge-wallets call.get.account",
      entry: "forge-wallets-module entry.get.account",
    },
  ],
  dropped: [
    {
      call: "forge-edge-wallets call.get.account",
      entry: "forge-wallets-module entry.post.accounts",
      why: W.notCandidate,
    },
  ],
  withdrawn: [
    {
      call: "forge-edge-wallets call.get.holds",
      entry: "forge-wallets-module entry.get.account-blocks",
      why: "the quote isn't on line 12",
    },
  ],
  loose: ["forge-edge-wallets call.put.limits"],
  at: "2026-11-25T10:00:00.000Z",
};

describe("Paired by Apply, on Decided by AI", () => {
  it("lists what was drawn, dropped with why, withdrawn and left loose, each list labelled", () => {
    const out = renderToStaticMarkup(<ApplyPairsView r={R} />);
    expect(out).toContain(esc(W.line(1, 1)));
    expect(out).toContain(esc(W.withdrew(1)));
    expect(out).toContain(esc(W.at("2026-11-25")));
    expect(out).toContain(
      "forge-edge-wallets call.get.account → forge-wallets-module entry.get.account",
    );
    expect(out).toContain(esc(W.dropped(R.dropped[0]!.call, R.dropped[0]!.entry, W.notCandidate)));
    expect(out).toContain(esc("the quote isn't on line 12"));
    expect(out).toContain("forge-edge-wallets call.put.limits");
    for (const k of ["drawn", "dropped", "withdrawn", "loose"] as const)
      expect(out).toContain(`aria-label="${esc(W.lists[k])} (1)"`);
    expect(out).toContain('aria-labelledby="decisions-apply-pairs"');
    expect(out).toContain('role="status"');
  });

  it("says so when no Apply has paired yet, and why nothing was sent when nothing was", () => {
    expect(renderToStaticMarkup(<ApplyPairsView r={undefined} />)).toContain(esc(W.empty));
    const off = renderToStaticMarkup(
      <ApplyPairsView
        r={{ paired: [], dropped: [], withdrawn: [], loose: ["a c"], why: W.aiOff }}
      />,
    );
    expect(off).toContain(esc(W.aiOff));
    expect(off).not.toContain(esc(W.lists.drawn));
  });
});
