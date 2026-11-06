import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { Diff, OwnerForm } from "../src/screens/architecture/Owner.js";

/** G2 (ADR 0174): a repo's owner and system, set from its box: each state, and the diff. */

const O = COPY.owner;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const view: Api.RepoOwnerViewT = {
  repo: "forge-billing",
  owner: "team-billing",
  system: "billing",
  file: "org-pack/profiles/forge/repos.manifest.yaml",
  teams: [
    { id: "team-billing", name: "Billing team" },
    { id: "team-platform", name: "Platform team" },
  ],
  systems: [{ id: "billing", name: "Billing" }],
};

describe("the owner form", () => {
  it("says it is loading, and why it failed", () => {
    const f = (v: Parameters<typeof OwnerForm>[0]["view"]) =>
      un(
        renderToStaticMarkup(<OwnerForm repo="forge-billing" view={v} onClose={() => undefined} />),
      );
    expect(f({ state: "loading" })).toContain(O.loading);
    expect(f({ state: "error", error: "boom" })).toContain(O.failed("boom"));
  });

  it("has labelled pickers for the owner (and Add a team…) and the system, and names the file", () => {
    const out = un(
      renderToStaticMarkup(
        <OwnerForm
          repo="forge-billing"
          view={{ state: "ready", data: view }}
          onClose={() => undefined}
        />,
      ),
    );
    expect(out).toContain(O.title("forge-billing"));
    expect(out).toContain(O.intro(view.file));
    expect(out).toContain("Billing team (team-billing)");
    expect(out).toContain(O.addTeam);
    expect(out).toContain(O.system);
    expect(out).toMatch(/<label for="[^"]+" class="hud">Owner \(a team\)<\/label>/);
  });

  it("shows the lines that change, was and now", () => {
    const out = renderToStaticMarkup(
      <Diff
        r={{
          written: false,
          files: [
            {
              file: "org-pack/profiles/forge/repos.manifest.yaml",
              changes: [{ was: "    owner: team-billing", now: "    owner: team-platform" }],
            },
          ],
          verify: "atticus verify --all --write",
          commit: "git add x",
        }}
      />,
    );
    expect(out).toContain("-     owner: team-billing\n+     owner: team-platform");
  });
});
