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
        onConfirm={(n) => sent.push(n)}
      />,
    );
    expect(failed).toContain(esc(COPY.upgrade.confirmRemovals(240)));
    expect(failed).toContain("atticus upgrade --allow-removals 240");
    expect(failed).toMatch(/<button[^>]*>[^<]*Confirm/);
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
