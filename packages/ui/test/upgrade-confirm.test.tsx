import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { UpgradeOfferView } from "../src/app/upgrade.js";

/**
 * The review of 5cc4ce87: the app's Upgrade couldn't pass --allow-removals, so a step whose build
 * waits for its removals to be confirmed (ADR 0195 point 4) could be confirmed from a terminal
 * only. The refused run's job result gives the count and the plan (API 3.19.0, `confirm`); the
 * panel confirms exactly those, as other refusals' confirms do.
 */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const view = {
  pending: [{ id: "unresolved-ids-repo", summary: "loose ends", files: ["a.yaml"] }],
  atticus: "2.0.0-beta.30",
  newer: false,
} as unknown as Api.UpgradeViewT;

describe("the upgrade panel confirms a step's removals", () => {
  it("offers the confirm with its count and the terminal's command, and sends them", () => {
    const sent: number[] = [];
    const failed = renderToStaticMarkup(
      <UpgradeOfferView
        view={view}
        run={{
          state: "failed",
          lines: ["This would remove 240 records"],
          confirm: { removals: 240 },
        }}
        onRun={() => undefined}
        onConfirm={(c) => sent.push(c.removals ?? -1)}
      />,
    );
    expect(failed).toContain(esc(COPY.upgrade.confirmRemovals(240)));
    expect(failed).toContain("atticus upgrade --allow-removals 240");
    expect(failed).toMatch(/<button[^>]*>[^<]*Confirm/);
  });

  // The whole-release review of beta.30 (B2): a step's build that lists hand edits is confirmed
  // here too, as `atticus upgrade --discard-edits <n>` does it, with the way that keeps them.
  it("offers to discard a step's hand edits with their count, names curate, and the command", () => {
    const failed = renderToStaticMarkup(
      <UpgradeOfferView
        view={view}
        run={{
          state: "failed",
          lines: ["1 file under catalog/generated was changed by hand"],
          confirm: { edits: 1 },
        }}
        onRun={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(COPY.upgrade.confirmEdits(1)).toBe("Discard this hand edit and upgrade");
    expect(COPY.upgrade.confirmEdits(3)).toBe("Discard these 3 hand edits and upgrade");
    expect(failed).toContain(esc(COPY.upgrade.confirmEdits(1)));
    expect(failed).toContain(esc(COPY.upgrade.confirmEditsHint.split("'").at(-1)!));
    expect(failed).toContain("atticus catalog edits --curate");
    expect(failed).toContain("atticus upgrade --discard-edits 1");
    expect(failed).not.toContain("--allow-removals");
    const both = renderToStaticMarkup(
      <UpgradeOfferView
        view={view}
        run={{ state: "failed", lines: [], confirm: { edits: 2, removals: 240 } }}
        onRun={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(both).toContain(esc(COPY.upgrade.confirmBoth(2, 240)));
    expect(both).toContain("atticus upgrade --discard-edits 2 --allow-removals 240");
  });

  it("offers no confirm for a refusal nothing confirms", () => {
    const failed = renderToStaticMarkup(
      <UpgradeOfferView
        view={view}
        run={{ state: "failed", lines: ["Nothing of this step was written."] }}
        onRun={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(failed).not.toContain(esc(COPY.upgrade.confirmRemovals(240)));
    expect(failed).not.toContain("--allow-removals");
  });
});
