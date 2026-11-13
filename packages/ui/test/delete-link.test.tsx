import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { LinkInspector } from "../src/screens/architecture/WhyLinked.js";
import {
  DeletedLinksList,
  DeleteLinkView,
  type DeleteState,
} from "../src/screens/architecture/DeleteLink.js";

/**
 * Beta.28 (the owner's decision of 2026-11-12): Delete this link on every link's panel, beside
 * Close, with a small confirm naming the link and its calls, its working and error states; and
 * Deleted links with Bring back in its loading, error, empty and listed states. Everything
 * invented (the Forge estate, Northwind Pay).
 */

const D = COPY.deleteLink;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const CALL: Api.HierJoinT = {
  interface: "if-0a1b2c3d4e5f6071",
  from: "northwind-pay-proxy",
  to: "refunds-api",
  how: "path",
  gateway: false,
  verified: false,
  method: "GET",
  path: "/refunds/{}",
  caller: [],
  callee: [{ source: "code", repo: "forge-refunds", at: "src/RefundsController.java:12" }],
  hops: [],
  other: [],
};
const LINK: Api.HierEdgeT = {
  id: "calls:system:northwind-pay-proxy>system:refunds",
  from: "system:northwind-pay-proxy",
  to: "system:refunds",
  type: "calls",
  count: 1,
  state: "current",
  gaps: [],
  evidence: [],
  joins: [CALL],
};
const noop = () => undefined;
const view = (now: DeleteState, count = 3) =>
  html(
    <DeleteLinkView
      from="Northwind Pay proxy"
      to="Refunds"
      count={count}
      now={now}
      onOpen={noop}
      onCancel={noop}
      onConfirm={noop}
    />,
  );

describe("Delete this link in the link's panel", () => {
  it("is in the head beside Close, before the calls, on a link that cites no caller's line", () => {
    const page = html(
      <LinkInspector
        link={LINK}
        labelOf={(id) => id.slice(7)}
        onClose={noop}
        deleteLink={(l) => (
          <DeleteLinkView
            from={l.from}
            to={l.to}
            count={l.count}
            now={{ state: "idle" }}
            onOpen={noop}
            onCancel={noop}
            onConfirm={noop}
          />
        )}
      />,
    );
    const head = page.indexOf('class="li-head"');
    const del = page.indexOf(`>${D.open}</button>`);
    expect(del).toBeGreaterThan(head);
    expect(del).toBeLessThan(page.indexOf(COPY.canvasAi.close));
    expect(page.indexOf(COPY.canvasAi.close)).toBeLessThan(page.indexOf("li-calls"));
    // A build dependency has no Interface to delete: no button.
    const dep = html(
      <LinkInspector
        link={{ ...LINK, type: "depends-on" }}
        labelOf={(id) => id}
        onClose={noop}
        deleteLink={() => <span>{D.open}</span>}
      />,
    );
    expect(dep).not.toContain(D.open);
  });

  it("says what the panel gives once the link was deleted, in place of gone", () => {
    const page = html(
      <LinkInspector
        link={undefined}
        labelOf={(id) => id}
        onClose={noop}
        gone={<p>{D.done("A", "B")}</p>}
      />,
    );
    expect(page).toContain(esc(D.done("A", "B")));
    expect(page).not.toContain(esc(COPY.canvasAi.gone));
  });

  it("names the link on the button for a screen reader, closed until clicked", () => {
    const page = view({ state: "idle" });
    expect(page).toContain(`aria-label="${esc(D.openOf("Northwind Pay proxy", "Refunds"))}"`);
    expect(page).toContain('aria-expanded="false"');
    expect(page).not.toContain(esc(D.confirm("Northwind Pay proxy", "Refunds", 3)));
  });

  it("asks once, naming the link and every call, with Delete and Cancel", () => {
    const page = view({ state: "confirm", interfaces: ["if-1", "if-2", "if-3", "if-4"] });
    expect(page).toContain('aria-expanded="true"');
    // The count is of the calls read whole (four), not the view's.
    expect(page).toContain(esc(D.confirm("Northwind Pay proxy", "Refunds", 4)));
    expect(page).toContain(esc(D.intro));
    expect(page).toContain(`>${D.yes}</button>`);
    expect(page).toContain(`>${D.no}</button>`);
    expect(page).toContain('role="group"');
  });

  it("says it is reading every call first, with no Delete yet", () => {
    const page = view({ state: "reading" });
    expect(page).toContain(esc(D.reading));
    expect(page).toContain('aria-busy="true"');
    expect(page).not.toContain(`>${D.yes}</button>`);
  });

  it("says it is working, with Delete and Cancel held", () => {
    const page = view({ state: "working", interfaces: ["if-1"] });
    expect(page).toContain(esc(D.working));
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
  });

  it("says why it failed, and Delete tries again", () => {
    const page = view({ state: "error", text: "the build waits", interfaces: ["if-1"] });
    expect(page).toContain('role="alert"');
    expect(page).toContain(esc(D.failed("the build waits")));
    expect(page).toContain(`>${D.yes}</button>`);
    // A read of the calls that failed has nothing to delete yet.
    const read = view({ state: "error", text: "offline" });
    expect(read).toContain(esc(D.readFailed("offline")));
    expect(read).not.toContain(`>${D.yes}</button>`);
  });

  it("points a lineless call to Delete this link, not to a read again", () => {
    expect(COPY.why.uncitedLink).toContain(D.open);
    expect(COPY.why.arrow.uncited(2)).toContain(D.open);
    expect(COPY.why.uncitedLink).not.toMatch(/read the caller's repo again/i);
  });
});

describe("Deleted links, with Bring back", () => {
  const L = D.list;
  const ITEM: Api.DeletedLinksViewT["links"][number] = {
    from: "Northwind Pay proxy",
    to: "Refunds",
    calls: 1,
    by: "pat",
    at: "2026-11-12T10:00:00Z",
    decisions: [
      {
        id: "cd-link-delete-if-0a1b",
        target: "if-0a1b2c3d4e5f6071",
        file: "catalog/curated/curateddecision/cd-link-delete-if-0a1b.yaml",
      },
    ],
  };
  const list = (
    of: Parameters<typeof DeletedLinksList>[0]["of"],
    back: Parameters<typeof DeletedLinksList>[0]["back"] = { state: "idle" },
    only?: ReadonlySet<string>,
  ) => html(<DeletedLinksList of={of} back={back} only={only} onBack={noop} />);

  it("labels a redirect's old link, and one the build no longer makes, in words", () => {
    const page = list({
      state: "ready",
      data: { links: [{ ...ITEM, redirect: true, gone: true }] },
    });
    expect(page).toContain(esc(L.redirected));
    expect(page).toContain(esc(L.gone));
    expect(list({ state: "ready", data: { links: [ITEM] } })).not.toContain(esc(L.redirected));
  });

  it("has loading, error and empty states", () => {
    expect(list({ state: "loading" })).toContain(esc(L.loading));
    const err = list({ state: "error", error: "no catalog" });
    expect(err).toContain('role="alert"');
    expect(err).toContain(esc(L.failed("no catalog")));
    expect(list({ state: "ready", data: { links: [] } })).toContain(esc(L.none));
  });

  it("lists each deleted link with who and when, and a named Bring back", () => {
    const page = list({ state: "ready", data: { links: [ITEM] } });
    expect(page).toContain(esc(L.item("Northwind Pay proxy", "Refunds", 1)));
    expect(page).toContain(esc(L.by("pat", ITEM.at)));
    expect(page).toContain(`aria-label="${esc(L.backOf("Northwind Pay proxy", "Refunds"))}"`);
    expect(page).toContain(`>${L.back}</button>`);
    // Only the Delete just made, in the panel after it.
    expect(
      list({ state: "ready", data: { links: [ITEM] } }, { state: "idle" }, new Set(["if-other"])),
    ).toContain(esc(L.none));
  });

  it("says Bring back is working, then done or why it failed", () => {
    const ready = { state: "ready" as const, data: { links: [ITEM] } };
    expect(list(ready, { state: "working", at: 0 })).toContain(esc(L.backing));
    expect(
      list({ state: "ready", data: { links: [] } }, { state: "done", from: "A", to: "B" }),
    ).toContain(esc(L.backDone("A", "B")));
    const failed = list(ready, { state: "error", text: "locked" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(L.backFailed("locked")));
  });
});
