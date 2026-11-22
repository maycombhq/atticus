import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { AppBoundary, ScreenBoundary } from "../src/app/boundary.js";
import { LoadError, View } from "../src/app/ui.js";
import { ErrorWaysOn, UNDO_HREF } from "../src/app/ways-on.js";
import { EditMapView } from "../src/screens/architecture/EditMap.js";
import { panelAsked, UNDO_PANEL, UPGRADE_PANEL } from "../src/screens/setup/CatalogBuild.js";

/**
 * Beta.30, slice 2: every error state offers what exists today: Undo the last build (Set up ›
 * Catalog builds' undo, which lists the files first), Build again where a build is what failed,
 * and the command for a support bundle to copy (it is saved from a terminal; no route runs it).
 */

const W = COPY.waysOn;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
/** The three ways on, as every error state shows them. */
function offersUndoAndBundle(out: string) {
  expect(out).toContain(`role="group" aria-label="${esc(W.label)}"`);
  expect(out).toContain(`href="${UNDO_HREF.replace(/&/g, "&amp;")}"`);
  expect(out).toContain(`>${esc(W.undoLast)}<`);
  expect(out).toContain(`<code class="mono">${esc(W.supportCommand)}</code>`);
  expect(out).toContain(`aria-label="${esc(W.copySupportLabel(W.supportCommand))}"`);
}

describe("the ways on from an error", () => {
  it("Undo the last build goes to Catalog builds' undo", () => {
    expect(UNDO_HREF).toBe("#/activity?tab=catalog-builds&at=undo");
    expect(panelAsked(UNDO_HREF)).toBe(UNDO_PANEL);
    expect(panelAsked("#/activity?tab=catalog-builds&at=upgrade")).toBe(UPGRADE_PANEL);
    expect(panelAsked("#/activity?tab=catalog-builds")).toBeUndefined();
    expect(panelAsked("#/activity?tab=catalog-builds&at=else")).toBeUndefined();
  });

  it("offers Undo and the support bundle's command; Build again only where it applies", () => {
    const bare = html(<ErrorWaysOn />);
    offersUndoAndBundle(bare);
    expect(bare).not.toContain(esc(W.buildAgain));
    // Words say why each is there (the full form), and none in a panel's short form.
    expect(bare).toContain(esc(W.undoWhy));
    expect(bare).toContain(esc(W.supportWhy));
    const short = html(<ErrorWaysOn short />);
    offersUndoAndBundle(short);
    expect(short).not.toContain(esc(W.supportWhy));
    const again = html(<ErrorWaysOn onAgain={() => undefined} />);
    expect(again).toContain(`<button type="button" class="btn">${esc(W.buildAgain)}</button>`);
    const linked = html(<ErrorWaysOn againHref="#/activity?tab=catalog-builds" />);
    expect(linked).toContain(
      `<a class="btn" href="#/activity?tab=catalog-builds">${esc(W.buildAgainOn)}</a>`,
    );
  });
});

describe("every error state offers them", () => {
  it("a screen that couldn't be shown", () => {
    const b = new ScreenBoundary({ name: "Trust", children: null });
    b.state = { error: "boom" };
    const out = html(<>{b.render()}</>);
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(COPY.boundary.couldntBeShown("Trust")));
    offersUndoAndBundle(out);
  });

  it("the app itself: Go to Home still first", () => {
    const b = new AppBoundary({ children: null });
    b.state = { error: "boom" };
    const out = html(<>{b.render()}</>);
    expect(out).toContain(esc(COPY.boundary.goHome));
    offersUndoAndBundle(out);
    expect(out.indexOf(esc(COPY.boundary.goHome))).toBeLessThan(out.indexOf(esc(W.undoLast)));
  });

  it("a panel that couldn't load, beside Try again; not while the server is down", () => {
    const out = html(
      <View of={{ state: "error", error: "boom", reload: () => undefined }}>{() => null}</View>,
    );
    expect(out).toContain(COPY.app.tryAgain);
    offersUndoAndBundle(out);
    offersUndoAndBundle(html(<LoadError error="boom" />));
    // The server is down: the one note above the page says so; a section offers nothing.
    const off = html(<LoadError error={COPY.app.offline} />);
    expect(off).not.toContain(esc(W.undoLast));
  });

  it("Edit the map's Apply that failed: where to build again too", () => {
    const out = html(
      <EditMapView
        staged={[]}
        apply={{ state: "failed", text: "The build stopped." }}
        onRemove={() => undefined}
        onApply={() => undefined}
        onBack={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(out).toContain(esc(COPY.editMap.failed("The build stopped.")));
    offersUndoAndBundle(out);
    expect(out).toContain(`href="#/activity?tab=catalog-builds">${esc(W.buildAgainOn)}<`);
  });
});
