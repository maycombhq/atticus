import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { StandingLineView } from "../src/app/standing.js";
import { UPGRADE_HREF } from "../src/app/ways-on.js";
import { COPY } from "../src/copy.js";

/**
 * ADR 0202 point 8: Home's top line is the one `atticus status` prints (GET /api/status), with
 * one button for what to do. Invented Forge metarepo's words; the view only reads.
 */
const view = (o: Partial<Api.StandingViewT>): Api.StandingViewT => ({
  atticus: "2.0.0-beta.30",
  state: "up-to-date",
  stamp: "2.0.0-beta.30",
  catalog: "read",
  pendingSteps: 0,
  line: "You are on Atticus 2.0.0-beta.30. This metarepo is at 2.0.0-beta.30 (.atticus/metarepo.yaml), and this Atticus reads its catalog. Nothing to do.",
  ...o,
});
const html = (load: Parameters<typeof StandingLineView>[0]["load"]) =>
  renderToStaticMarkup(<StandingLineView load={load} />);

describe("Home's line: where the metarepo stands", () => {
  it("up to date: the line, and no button", () => {
    const h = html({ state: "ready", data: view({}) });
    expect(h).toContain("Nothing to do.");
    expect(h).toContain(`aria-label="${COPY.standing.label}"`);
    expect(h).not.toContain("<button");
    expect(h).not.toContain("<a ");
  });

  it("the metarepo is behind: one button, to the upgrade panel", () => {
    const h = html({
      state: "ready",
      data: view({
        state: "metarepo-behind",
        stamp: "2.0.0-beta.9",
        pendingSteps: 2,
        do: "atticus upgrade",
        line: "You are on Atticus 2.0.0-beta.30. This metarepo is at 2.0.0-beta.9 (.atticus/metarepo.yaml), and this Atticus reads its catalog. Do: atticus upgrade",
      }),
    });
    expect(h).toContain("Do: atticus upgrade");
    expect(h).toContain(`href="${UPGRADE_HREF}"`);
    expect(h).toContain(">Upgrade the metarepo</a>");
    expect(h).not.toContain("<button");
  });

  it("this Atticus is behind, by the stamp or by the catalog: one button, Copy the command", () => {
    for (const state of ["atticus-behind", "catalog-newer"] as const) {
      const command = "npm install -g @maycombhq/atticus@2.0.0-beta.31";
      const h = html({
        state: "ready",
        data: view({
          state,
          do: command,
          line: `You are on Atticus 2.0.0-beta.30. Do: ${command}`,
        }),
      });
      expect(h.match(/<button/g)).toHaveLength(1);
      expect(h).toContain(">Copy the command</button>");
      expect(h).toContain(`aria-label="Copy the command: ${command}"`);
      expect(h).not.toContain("<a ");
    }
  });

  it("loading says so; an error says the command; an older server (404) shows nothing", () => {
    expect(html({ state: "loading" })).toBe(
      '<p class="muted" role="status" style="margin:0;font-size:12px">Checking where this metarepo stands…</p>',
    );
    const failed = html({ state: "error", error: "500" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("atticus status");
    expect(html({ state: "error", error: "Not found", status: 404 })).toBe("");
  });
});
