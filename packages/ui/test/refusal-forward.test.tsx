import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { CorrectionNextPanel } from "../src/app/correction-next.js";
import { LeftOutWay, RefusalLink } from "../src/app/propose.js";
import { trustFilterOf } from "../src/screens/map/Trust.js";
import { RefusalView } from "../src/screens/setup/CatalogBuild.js";
import { UpgradeOfferView } from "../src/app/upgrade.js";

/**
 * Beta.30, slice 2: every refusal says in plain words what happened and that nothing was
 * changed, and has one primary button that goes forward, to something that exists today (no new
 * route or field). Forge-shaped data.
 */

const B = COPY.catalogBuild;
const WY = COPY.waysOn;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
/** How many primary buttons or links a piece of the page has. */
const primaries = (out: string) => out.split('class="btn primary').length - 1;
const none = async () => undefined;
const removal = (id: string): Api.BuildRemovalT => ({
  path: `catalog/generated/gatewayroute/${id}.yaml`,
  kind: "GatewayRoute",
  id,
  repos: ["forge-gateway"],
  explainedBy: ["catalog/sources/readers/forge-gateway.json"],
});
const refusal = (
  reasons: Api.BuildRefusalViewT["reasons"],
  more: Partial<Api.BuildRefusalViewT> = {},
): Api.BuildRefusalViewT => ({
  reasons,
  message: "Nothing written.",
  command: "atticus catalog build",
  ...more,
});
const view = (r: Api.BuildRefusalViewT, more: Partial<Parameters<typeof RefusalView>[0]> = {}) =>
  html(
    <RefusalView refused={r} onAllowRemovals={none} onCurate={none} onDiscard={none} {...more} />,
  );
const EDIT = { path: "catalog/generated/table/ledger-db.account.yaml", how: "changed" as const };

describe("a refused build has one button that goes forward", () => {
  it("every reason says nothing was written", () => {
    for (const reasons of [
      ["large-removals"],
      ["hand-edits"],
      ["unexplained-removals"],
      ["not-upgraded"],
      ["empty"],
      ["nothing-read"],
      ["newer-atticus"],
    ] as Api.BuildRefusalViewT["reasons"][])
      expect(B.refusalTitle(reasons)).toMatch(/nothing has been written/i);
  });

  it("large removals: Review the removals", () => {
    const out = view(
      refusal(["large-removals"], {
        removals: [removal("gw-a"), removal("gw-b")],
        allowRemovals: 2,
      }),
    );
    expect(primaries(out)).toBe(1);
    expect(out).toContain(`class="btn primary">${esc(B.reviewRemovals(2))}<`);
  });

  it("hand edits: Keep my edits first, Use Atticus's version second, in plain words", () => {
    expect(B.curate(1)).toBe("Keep my edit");
    expect(B.curate(3)).toBe("Keep my 3 edits");
    expect(B.discard(1)).toBe("Use Atticus's version…");
    expect(B.discard(3)).toBe("Use Atticus's version…");
    const out = view(refusal(["hand-edits"], { edits: [EDIT], discardEdits: 1 }));
    expect(primaries(out)).toBe(1);
    expect(out).toMatch(new RegExp(`class="btn primary"[^>]*>${esc(B.curate(1))}<`));
    expect(out).toContain(`class="btn">${esc(B.discard(1))}<`);
    // What each choice does, in the words under them.
    expect(out).toContain(esc(B.editsIntro));
    expect(B.editsIntro).toMatch(/Keep my edit/);
    expect(B.editsIntro).toMatch(/Use Atticus&#x27;s version|Use Atticus's version/);
  });

  it("hand edits beside large removals: still one primary (the edits come first)", () => {
    const out = view(
      refusal(["large-removals", "hand-edits"], {
        removals: [removal("gw-a")],
        allowRemovals: 1,
        edits: [EDIT],
        discardEdits: 1,
      }),
    );
    expect(primaries(out)).toBe(1);
    expect(out).toMatch(new RegExp(`class="btn primary"[^>]*>${esc(B.curate(1))}<`));
    expect(out).toContain(`class="btn">${esc(B.reviewRemovals(1))}<`);
  });

  it("an unreadable build.json: Build again over the record files", () => {
    const out = view(
      refusal(["hand-edits"], { edits: [EDIT], discardEdits: 96, unreadableManifest: true }),
    );
    expect(primaries(out)).toBe(1);
    expect(out).toContain(`class="btn primary">${esc(B.buildAgain(96))}<`);
    expect(out).toContain(esc(B.unreadableManifest(96)));
  });

  it("unexplained removals: Build again, and the support bundle's command to copy", () => {
    const calls: number[] = [];
    const r = refusal(["unexplained-removals"], { unexplained: [removal("gw-a")] });
    const out = view(r, { onAgain: async () => void calls.push(1) });
    expect(primaries(out)).toBe(1);
    expect(out).toMatch(new RegExp(`class="btn primary"[^>]*>${esc(WY.buildAgain)}<`));
    expect(out).toContain(esc(B.way.unexplained));
    expect(B.way.unexplained).toMatch(/Nothing was changed/);
    // A support bundle is saved from a terminal today: its command, with Copy.
    expect(out).toContain("atticus support bundle");
    expect(out).toContain(`aria-label="${esc(WY.copySupportLabel(WY.supportCommand))}"`);
    // With no build to run again from here, the way on is the page that builds.
    const linked = view(r);
    expect(primaries(linked)).toBe(1);
    expect(linked).toContain(
      `<a class="btn primary" href="#/catalog-builds">${esc(WY.buildAgainOn)}<`,
    );
  });

  it("a catalog from before beta.27: the upgrade, below on Catalog builds and linked elsewhere", () => {
    const r = refusal(["not-upgraded"], { discardEdits: 96 });
    const here = view(r, { upgradeHere: true });
    expect(primaries(here)).toBe(1);
    expect(here).toContain(`class="btn primary">${esc(WY.upgradeBelow)}<`);
    const elsewhere = view(r);
    expect(primaries(elsewhere)).toBe(1);
    expect(elsewhere).toContain(
      `<a class="btn primary" href="#/catalog-builds?at=upgrade">${esc(WY.upgradeOnBuilds)}<`,
    );
  });

  it("an empty catalog, or nothing read: the link to read the repos", () => {
    for (const reason of ["empty", "nothing-read"] as const) {
      const out = view(refusal([reason]));
      expect(primaries(out)).toBe(1);
      expect(out).toContain(`<a class="btn primary" href="#/trust">${esc(WY.readOnTrust)}<`);
      expect(out).toContain(esc(B.way.read));
      expect(B.way.read).toMatch(/Nothing was changed/);
    }
  });

  it("a newer Atticus's catalog: Copy the install command, and nothing to confirm", () => {
    const out = view(refusal(["newer-atticus"], { command: "npm i -g @maycombhq/atticus@beta" }));
    expect(primaries(out)).toBe(1);
    expect(out).toMatch(
      new RegExp(
        `class="btn primary[^"]*"[^>]*aria-label="${esc(WY.copyInstallLabel(WY.installCommand))}"[^>]*>${esc(WY.copyInstall)}<`,
      ),
    );
    expect(WY.installCommand).toBe("npm i -g @maycombhq/atticus@beta");
    expect(out).not.toContain(esc(B.curate(0)));
  });
});

describe("a refusal in a narrow panel", () => {
  it("a newer Atticus's catalog has Copy the install command there too", () => {
    const out = html(<RefusalLink refused={refusal(["newer-atticus"])} />);
    expect(out).toContain(esc(COPY.panelResults.newerAtticus));
    expect(primaries(out)).toBe(1);
    expect(out).toContain(`>${esc(WY.copyInstall)}<`);
  });

  it("Home's note of a newer Atticus's catalog has it as well", () => {
    const out = html(
      <UpgradeOfferView
        view={{ atticus: "2.0.0-beta.30", newer: false, pending: [], newerCatalog: "Newer." }}
        run={{ state: "idle" }}
        onRun={() => undefined}
      />,
    );
    expect(out).toContain(esc(COPY.upgrade.newerCatalog));
    expect(primaries(out)).toBe(1);
    expect(out).toContain(`>${esc(WY.copyInstall)}<`);
  });
});

describe("rejected facts and facts of another commit", () => {
  it("Map › Trust takes the repo to show from its address", () => {
    expect(trustFilterOf("#/trust?repo=forge-ledger")).toBe("forge-ledger");
    expect(trustFilterOf("#/trust?repo=forge%20x")).toBe("forge x");
    expect(trustFilterOf("#/trust")).toBe("");
    // A mangled address is a filter that matches nothing, never a blank page.
    expect(trustFilterOf("#/trust?repo=%")).toBe("%");
  });

  it("an Apply that left facts out links straight to them", () => {
    const out = html(<LeftOutWay repo="forge-ledger" n={3} />);
    expect(primaries(out)).toBe(1);
    expect(out).toContain(
      `<a class="btn primary" href="#/trust?repo=forge-ledger&amp;rejected=1">${esc(WY.rejectedOnTrust(3))}<`,
    );
    expect(html(<LeftOutWay repo="forge-ledger" n={0} />)).toBe("");
  });

  const VIEW = Api.VerifyPreviewView.parse({
    repo: "forge-payments",
    wrote: "facts/forge-payments.corrections.jsonl",
    branch: "propose/corrections/x",
    steps: [{ step: "verify", command: "atticus verify forge-payments --write" }],
    preview: {
      facts: { dropped: [], edited: [], kept: 8 },
      staleCorrections: [],
    },
  });
  const panel = (preview: Record<string, unknown>) =>
    html(
      <CorrectionNextPanel
        file="facts/forge-payments.corrections.jsonl"
        preview={{
          state: "ready",
          data: { ...VIEW, preview: { ...VIEW.preview!, ...preview } } as never,
        }}
      />,
    );

  it("the preview of an Apply that rejected facts block links to them on Map › Trust", () => {
    const out = panel({ blocked: { rejected: 2 } });
    expect(out).toContain(esc(COPY.correctionNext.blocked(2)));
    expect(out).toContain(
      `<a class="btn primary" href="#/trust?repo=forge-payments&amp;rejected=1">${esc(WY.rejectedOnTrust(2))}<`,
    );
  });

  it("facts of another commit than the checkout: Read it again, on Map › Trust", () => {
    const out = panel({ headMoved: { head: "b".repeat(40), commit: "a".repeat(40) } });
    expect(out).toContain(
      `<a class="btn" href="#/trust?repo=forge-payments">${esc(WY.readAgainOnTrust("forge-payments"))}<`,
    );
  });

  it("an Apply that will refuse whatever is confirmed has its one way on", () => {
    const newer = panel({ confirm: { refused: ["newer-atticus"] } });
    expect(primaries(newer)).toBe(1);
    expect(newer).toContain(`>${esc(WY.copyInstall)}<`);
    const bug = panel({ confirm: { refused: ["unexplained-removals", "empty"] } });
    expect(primaries(bug)).toBe(1);
    expect(bug).toContain(`<a class="btn primary" href="#/catalog-builds">${esc(WY.seeOnBuilds)}<`);
    expect(bug).toContain("atticus support bundle");
    const empty = panel({ confirm: { refused: ["empty"] } });
    expect(empty).toContain(`<a class="btn primary" href="#/trust">${esc(WY.readOnTrust)}<`);
    const old = panel({ confirm: { upgrade: true, command: "atticus upgrade --yes" } });
    expect(primaries(old)).toBe(1);
    expect(old).toContain(
      `<a class="btn primary" href="#/catalog-builds?at=upgrade">${esc(WY.upgradeOnBuilds)}<`,
    );
  });
});
