import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { screenOf } from "../src/app/screens.js";
import { changesIn, SystemPicker, systemHash } from "../src/screens/know/Systems.js";

/** A system's page (WP7.7): its guide, its open questions and the changes in its repos. */

const LEDGER = { id: "ledger", name: "Forge Ledger", repos: ["forge-ledger", "ledger-db"] };

describe("a system's page (WP7.7)", () => {
  it("is a page of Map, reached from a system's link", () => {
    expect(screenOf("systems")?.section).toBe("Map");
  });

  it("lists the changes in flight in the system's repos, not released ones or other systems'", () => {
    const changes = [
      { id: "add-limit", title: "Add transfer limit", state: "design", repos: ["forge-ledger"] },
      { id: "old-fix", title: "Old fix", state: "released", repos: ["forge-ledger"] },
      { id: "portal-css", title: "Portal styles", state: "build", repos: ["forge-portal"] },
    ];
    expect(changesIn(LEDGER, changes).map((c) => c.id)).toEqual(["add-limit"]);
  });

  it("picks a system by name, marking the one shown", () => {
    const out = renderToStaticMarkup(
      <SystemPicker systems={[LEDGER, { id: "portal" }]} current="ledger" />,
    );
    expect(out).toContain("Forge Ledger");
    expect(out).toContain(`href="${systemHash("portal")}"`);
    expect(out).toContain('aria-current="page"');
  });
});
