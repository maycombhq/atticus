import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { ApiError } from "../src/api/client.js";
import { RunsContext, type Ctx } from "../src/app/copilot-runs.js";
import { JobFailed } from "../src/app/job.js";
import { COPY } from "../src/copy.js";
import { revealOf } from "../src/screens/architecture/Architecture.js";
import {
  applyRefused,
  CATALOG_BUILDS_HREF,
  RefusalLink,
  ResultsInPanel,
  stepLines,
} from "../src/app/propose.js";
import {
  AddLinkForm,
  addOf,
  applyStaged,
  drawsAnother,
  pairOf,
  pairRowsForAdd,
  pairRowsForRedirect,
  PairRowsView,
  EditMapToggle,
  EditMapView,
  reReadAsk,
  StageLinkView,
  type ApplyState,
} from "../src/screens/architecture/EditMap.js";
import {
  countsWords,
  keptAfterApply,
  requestOf,
  rowWords,
  stage,
  stagedOf,
  STAGED_LINK,
  unstage,
  withStaged,
  type AddLink,
  type Staged,
  type StagedDelete,
} from "../src/screens/architecture/edit-map.js";
import type { CanvasGraph } from "../src/screens/architecture/model.js";
import {
  canDelete,
  DeleteLinkView,
  linkInterfaces,
} from "../src/screens/architecture/DeleteLink.js";

/**
 * Beta.28, Edit the map (the owner's ask of 2026-11-12: "delete arrows and add arrows in one go
 * and click a button"): the toggle, staging a delete, an add and a redirect without saving, the
 * list with its counts and Remove, the canvas's marks, Apply's one confirm, its working, refused,
 * failed and done states, and Re-read the repos these touch as one Copilot run. Everything
 * invented (the Forge estate, Northwind Pay).
 */

const E = COPY.editMap;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const noop = () => undefined;

const REFUNDS: StagedDelete = {
  link: "calls:component:northwind-pay-proxy>component:refunds-api",
  fromBox: "component:northwind-pay-proxy",
  toBox: "component:refunds-api",
  from: "northwind-pay-proxy",
  to: "refunds-api",
  // A lineless arrow: its Interface cites no line of its caller's, and is deleted all the same.
  interfaces: ["if-1111111111111111"],
};
const PAYMENTS: StagedDelete = {
  link: "calls:component:northwind-pay-proxy>component:payments-api",
  fromBox: "component:northwind-pay-proxy",
  toBox: "component:payments-api",
  from: "northwind-pay-proxy",
  to: "payments-api",
  interfaces: ["if-post-payments", "if-get-payment"],
};
const GET: Api.MapEditAddT = {
  kind: "call",
  system: "northwind-pay",
  route: "GET /northwind-pay/1.0/payments/{id}",
};
const POST: Api.MapEditAddT = {
  kind: "call",
  system: "northwind-pay",
  route: "POST /northwind-pay/1.0/payments",
};
const TOPIC: Api.MapEditAddT = {
  kind: "topic",
  system: "harbor-ledger",
  topic: "forge.refunds",
  side: "listens",
};

/** Declare a link…'s add. */
const D = (add: Api.MapEditAddT): AddLink => ({ by: "declare", add });

/** Three deletes, two adds and a redirect, as the owner's example counts them. */
function six(): Staged[] {
  let l: Staged[] = [];
  l = stage(l, { kind: "delete", delete: REFUNDS });
  l = stage(l, { kind: "delete", delete: { ...REFUNDS, link: "a", interfaces: ["if-a"] } });
  l = stage(l, { kind: "delete", delete: { ...REFUNDS, link: "b", interfaces: ["if-b"] } });
  l = stage(l, { kind: "add", link: D(GET), fromBox: "system:northwind-pay" });
  l = stage(l, { kind: "add", link: D(TOPIC) });
  l = stage(l, {
    kind: "redirect",
    delete: PAYMENTS,
    link: D(POST),
    fromBox: "system:northwind-pay",
    toBox: "component:northwind-pay-proxy",
  });
  return l;
}

describe("staging changes (nothing saved)", () => {
  it("counts them as the owner said it: 3 deleted, 2 added, 1 redirected", () => {
    const l = six();
    expect(l).toHaveLength(6);
    expect(countsWords(l)).toBe("3 deleted, 2 added, 1 redirected");
    expect(countsWords(l.slice(0, 1))).toBe("1 deleted");
  });

  it("removes one, and a second change of the same arrow takes the first one's place", () => {
    let l = six();
    const first = l[0]!;
    l = unstage(l, first.key);
    expect(l).toHaveLength(5);
    expect(stagedOf(l, REFUNDS.link)).toBeUndefined();
    // The payments arrow was redirected; deleting it instead replaces the redirect.
    l = stage(l, { kind: "delete", delete: PAYMENTS });
    expect(l.filter((x) => x.kind !== "add" && x.delete.link === PAYMENTS.link)).toHaveLength(1);
    expect(stagedOf(l, PAYMENTS.link)?.kind).toBe("delete");
    // The same add twice is one.
    expect(stage(l, { kind: "add", link: D(GET) }).filter((x) => x.kind === "add")).toHaveLength(2);
  });

  it("says each row in words, a lineless delete with its call", () => {
    const l = six();
    expect(rowWords(l[0]!)).toBe("Delete northwind-pay-proxy → refunds-api (1 call)");
    expect(rowWords(l[3]!)).toBe("Add: northwind-pay calls GET /northwind-pay/1.0/payments/{id}");
    expect(rowWords(l[4]!)).toBe("Add: harbor-ledger listens on forge.refunds");
    expect(rowWords(l[5]!)).toBe(
      "Redirect northwind-pay-proxy → payments-api to: northwind-pay calls POST /northwind-pay/1.0/payments",
    );
  });

  it("sends them in order, as POST /api/map/edits takes them: a delete, an add, a redirect", () => {
    const body = requestOf(six());
    expect(body.edits.map((e) => e.kind)).toEqual([
      "delete",
      "delete",
      "delete",
      "add",
      "add",
      "redirect",
    ]);
    expect(body.edits[0]).toEqual({
      kind: "delete",
      delete: {
        interfaces: ["if-1111111111111111"],
        from: "northwind-pay-proxy",
        to: "refunds-api",
      },
    });
    expect(body.edits[5]).toEqual({
      kind: "redirect",
      delete: {
        interfaces: ["if-post-payments", "if-get-payment"],
        from: "northwind-pay-proxy",
        to: "payments-api",
      },
      add: POST,
    });
    // An add is exactly what Declare a link… writes, without its preview.
    expect(addOf("northwind-pay", "call", "  GET /x ")).toEqual({
      kind: "call",
      system: "northwind-pay",
      route: "GET /x",
    });
    expect(addOf("harbor-ledger", "publishes", "")).toBeUndefined();
  });

  it("reads every Interface behind an arrow, lineless ones too, and never deletes in part", async () => {
    const join = {
      interface: "if-1111111111111111",
      from: "northwind-pay-proxy",
      to: "refunds-api",
      how: "path" as const,
      gateway: false,
      verified: false,
      caller: [],
      callee: [],
      hops: [],
      other: [],
    };
    const link: Api.HierEdgeT = {
      id: REFUNDS.link,
      from: REFUNDS.fromBox,
      to: REFUNDS.toBox,
      type: "calls",
      count: 2,
      state: "current",
      gaps: [],
      evidence: [],
      joins: [join],
    };
    expect(await linkInterfaces({ ...link, count: 1 })).toEqual(["if-1111111111111111"]);
    const second = { ...join, interface: "if-2222222222222222" };
    const all = await linkInterfaces(link, "/api/graph/edge-calls?edge=x", async () => ({
      edge: link.id,
      count: 2,
      joins: [join, second],
    }));
    expect(all).toEqual(["if-1111111111111111", "if-2222222222222222"]);
    // More calls than the view lists and no way to read them all: refused, not cut short.
    await expect(linkInterfaces(link)).rejects.toThrow(COPY.deleteLink.partial(2, 1));
    await expect(
      linkInterfaces(link, "/x", async () => ({ edge: link.id, count: 2, joins: [join] })),
    ).rejects.toThrow(COPY.deleteLink.partial(2, 1));
    // An arrow that merges a use of a table (no Interface behind it), or nothing at all.
    await expect(
      linkInterfaces({ ...link, count: 2, joins: [join, { ...join, interface: "table:ledger" }] }),
    ).rejects.toThrow(COPY.deleteLink.mixed);
    await expect(linkInterfaces({ ...link, count: 1, joins: [] })).rejects.toThrow(
      COPY.deleteLink.partial(1, 0),
    );
    // Delete is offered only on an arrow of calls.
    expect(canDelete({ ...link, count: 1 })).toBe(true);
    expect(canDelete({ ...link, joins: [] })).toBe(false);
    expect(canDelete({ ...link, type: "depends-on" })).toBe(false);
    expect(
      canDelete({ ...link, type: "reads", joins: [{ ...join, interface: "table:ledger" }] }),
    ).toBe(false);
  });

  it("says the other arrows the same calls draw (a topic's other side), in the row and the confirm", () => {
    const l = stage([], {
      kind: "delete",
      delete: { ...REFUNDS, also: ["forge.refunds → forge-ledger"] },
    });
    expect(rowWords(l[0]!)).toBe(
      "Delete northwind-pay-proxy → refunds-api (1 call), and with it forge.refunds → forge-ledger",
    );
    const page = html(
      <DeleteLinkView
        from="forge-refunds"
        to="forge.refunds"
        count={1}
        now={{ state: "confirm", interfaces: ["if-1111111111111111"] }}
        also={["forge.refunds → forge-ledger"]}
        onOpen={noop}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(page).toContain(esc(COPY.deleteLink.also("forge.refunds → forge-ledger")));
  });

  it("takes only the saved changes off the list: one staged while Apply ran stays", () => {
    const l = six();
    const saved = new Set(l.slice(0, 4).map((x) => x.key));
    expect(keptAfterApply(l, saved).map((x) => x.key)).toEqual(l.slice(4).map((x) => x.key));
    expect(keptAfterApply(l, new Set(l.map((x) => x.key)))).toEqual([]);
  });
});

describe("the canvas while editing", () => {
  const graph: CanvasGraph = {
    boxes: ["component:northwind-pay-proxy", "component:refunds-api", "component:payments-api"]
      .concat(["system:northwind-pay"])
      .map((id) => ({
        id,
        label: id.split(":")[1]!,
        kind: "component",
        gaps: [],
        childCount: 0,
        outside: false,
        group: false,
        inside: 0,
      })),
    links: [REFUNDS, PAYMENTS].map((d) => ({
      id: d.link,
      from: d.fromBox,
      to: d.toBox,
      type: "calls",
      count: d.interfaces.length,
      label: "calls",
      async: false,
      gaps: [],
    })),
  };

  it("dims a staged delete (and a redirect's) and draws a staged add dashed, both in words", () => {
    const g = withStaged(graph, six());
    const refunds = g.links.find((l) => l.id === REFUNDS.link)!;
    const payments = g.links.find((l) => l.id === PAYMENTS.link)!;
    expect(refunds.staged).toBe("delete");
    expect(payments.staged).toBe("delete");
    // The arrow keeps its label (the picture isn't laid out again for a delete).
    expect(refunds.label).toBe("calls");
    const added = g.links.filter((l) => l.id.startsWith(STAGED_LINK));
    // Only the redirect's add names both its boxes; the others aren't drawn until the build.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      from: "system:northwind-pay",
      to: "component:northwind-pay-proxy",
      staged: "add",
      declared: true,
    });
    expect(E.onCanvas).toEqual({ delete: "to delete", add: "to add" });
    expect(withStaged(graph, [])).toBe(graph);
  });

  it("opens the details for the list when Edit the map is turned on", () => {
    const base = {
      adding: false,
      connecting: undefined,
      declaring: undefined,
      owning: undefined,
      pickedLink: undefined,
      pickedBox: undefined,
    };
    expect(revealOf(base)).toBe("");
    expect(revealOf({ ...base, editing: true })).toBe("edit");
  });
});

describe("the toggle and the link panel", () => {
  it("is a toggle button named in words, with the changes not applied yet", () => {
    const off = html(<EditMapToggle on={false} count={0} onToggle={noop} />);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain(`aria-label="${esc(E.toggle)}"`);
    // An icon in the map's one row of controls, named in words (beta.28 CI: the bar wrapped).
    expect(off).toContain(`title="${esc(E.toggle)}"`);
    expect(off).not.toContain(`>${esc(E.toggle)}<`);
    const on = html(<EditMapToggle on count={3} onToggle={noop} />);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain(`aria-label="${esc(E.toggleOf(3))}"`);
    expect(E.toggleOf(3)).toBe("Edit the map, 3 changes not applied yet");
  });

  it("stages a delete or a redirect of the arrow picked, each button named for the arrow", () => {
    const page = html(
      <StageLinkView
        from="northwind-pay-proxy"
        to="refunds-api"
        now={{ state: "idle" }}
        onDelete={noop}
        onRedirect={noop}
        onUnstage={noop}
      />,
    );
    expect(page).toContain(esc(E.stage.deleteOf("northwind-pay-proxy", "refunds-api")));
    expect(page).toContain(esc(E.stage.redirectOf("northwind-pay-proxy", "refunds-api")));
    expect(page).toContain(esc(E.stage.delete));
    // Nothing is saved from here: no Delete confirm, no job.
    expect(page).not.toContain(esc(COPY.deleteLink.intro));
    expect(page).not.toContain('class="btn danger"');
    const staged = six()[0]!;
    const shown = html(
      <StageLinkView
        from="northwind-pay-proxy"
        to="refunds-api"
        staged={staged}
        now={{ state: "idle" }}
        onDelete={noop}
        onRedirect={noop}
        onUnstage={noop}
      />,
    );
    expect(shown).toContain(esc(E.stage.staged(rowWords(staged))));
    expect(shown).toContain(`aria-label="${esc(E.removeOf(rowWords(staged)))}"`);
    const reading = html(
      <StageLinkView
        from="a"
        to="b"
        now={{ state: "reading" }}
        onDelete={noop}
        onRedirect={noop}
        onUnstage={noop}
      />,
    );
    expect(reading).toContain('aria-busy="true"');
    expect(reading).toContain("disabled");
    const failed = html(
      <StageLinkView
        from="a"
        to="b"
        now={{ state: "error", text: "the server stopped" }}
        onDelete={noop}
        onRedirect={noop}
        onUnstage={noop}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(E.stage.readFailed("the server stopped")));
  });

  it("Add a link names every field, and says when no system is on the map", () => {
    const page = html(
      <AddLinkForm
        systems={[{ box: "system:northwind-pay", system: "northwind-pay", label: "Northwind Pay" }]}
        targets={[
          { box: "component:northwind-pay-proxy", label: "Component: northwind-pay-proxy" },
        ]}
        staged={[]}
        onStage={noop}
      />,
    );
    for (const w of [
      E.add.title,
      E.add.from,
      E.add.kind,
      COPY.declare.route,
      E.add.to,
      E.add.stage,
    ])
      expect(page).toContain(esc(w));
    // Each field has its label (WCAG 1.3.1, 4.1.2).
    const fors = [...page.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
    for (const id of fors) expect(page).toContain(`id="${id}"`);
    expect(fors).toHaveLength(3);
    const none = html(<AddLinkForm systems={[]} targets={[]} staged={[]} onStage={noop} />);
    expect(none).toContain(esc(E.add.fromNone));
    const redirect = html(
      <AddLinkForm
        systems={[{ box: "system:northwind-pay", system: "northwind-pay", label: "Northwind Pay" }]}
        targets={[]}
        staged={[]}
        redirect={{ ...PAYMENTS, fromBox: "system:northwind-pay" }}
        onStage={noop}
        onCancel={noop}
      />,
    );
    expect(redirect).toContain(esc(E.add.redirectTitle("northwind-pay-proxy", "payments-api")));
    expect(redirect).toContain(esc(E.add.cancel));
  });
});

describe("the list beside the canvas, and Apply my changes", () => {
  const view = (apply: ApplyState, staged: Staged[] = six(), ctx?: Ctx) => {
    const el = (
      <EditMapView
        staged={staged}
        apply={apply}
        onRemove={noop}
        onApply={noop}
        onConfirm={noop}
        onBack={noop}
      />
    );
    return html(ctx ? <RunsContext.Provider value={ctx}>{el}</RunsContext.Provider> : el);
  };

  it("says when nothing is staged, and Apply is off", () => {
    const page = view({ state: "idle" }, []);
    expect(page).toContain(esc(E.empty));
    expect(page).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${esc(E.apply)}</button>`));
  });

  it("lists every change with its counts and a Remove named for it", () => {
    const l = six();
    const page = view({ state: "idle" }, l);
    expect(page).toContain(esc("3 deleted, 2 added, 1 redirected"));
    expect(page).toContain(`aria-label="${esc(E.listLabel)}"`);
    for (const s of l) {
      expect(page).toContain(esc(rowWords(s)));
      expect(page).toContain(`aria-label="${esc(E.removeOf(rowWords(s)))}"`);
    }
    expect(page).toMatch(new RegExp(`<button[^>]*>${esc(E.apply)}</button>`));
    expect(page).not.toMatch(new RegExp(`<button[^>]*disabled[^>]*>${esc(E.apply)}</button>`));
  });

  it("asks once, listing the changes, before anything is saved", () => {
    const page = view({ state: "confirm" });
    expect(page).toContain(esc(E.confirm.title(6)));
    expect(page).toContain('role="group"');
    expect(page).toContain(esc(E.confirm.yes));
    expect(page).toContain(esc(E.confirm.back));
    expect(page.match(/<li>/g)?.length).toBe(6);
    // The list can't change under the confirm.
    expect(page).toMatch(/<button[^>]*disabled[^>]*>Remove<\/button>/);
  });

  it("says it is working, then one status line, each problem or outcome on its own row", () => {
    const working = view({ state: "working" });
    expect(working).toContain(esc(E.working));
    expect(working).toContain('aria-busy="true"');
    const l = six();
    const refused = view({
      state: "problems",
      problems: [{ edit: 3, message: "No system of the profiles is harbor-nowhere." }],
    });
    expect(refused).toContain('role="alert"');
    expect(refused).toContain(esc(E.problemsLine(1)));
    // On the row it is of, under that row's words, not stacked under the list.
    const row = refused.indexOf(esc(rowWords(l[3]!)));
    const why = refused.indexOf(esc("No system of the profiles is harbor-nowhere."));
    expect(row).toBeGreaterThan(0);
    expect(why).toBeGreaterThan(row);
    expect(why).toBeLessThan(refused.indexOf(esc(rowWords(l[4]!))));
    const failed = view({
      state: "failed",
      text: "Nothing was built. A long verify output…",
      outcomes: [{ edit: 5, state: E.outcome.failed!, message: "exists" }],
    });
    expect(failed).toContain(esc(E.failedLine));
    expect(failed).toContain(esc("not saved, exists"));
    expect(failed).not.toContain(esc("A long verify output"));
  });

  it("once applied, one status line and one primary button: Re-read the repos these touch", () => {
    const ctx = {
      run: null,
      allowed: true,
      ask: noop,
      stop: async () => undefined,
      stopping: false,
      consoleOpen: false,
      setConsoleOpen: noop,
      loadEarlier: noop,
    } as Ctx;
    const page = view(
      { state: "done", n: 3, callers: ["northwind_pay_1-0"], waitsOn: [] },
      [],
      ctx,
    );
    expect(page).toContain(esc(E.done(3)));
    expect(page).toContain(esc(E.reReadWhy("northwind_pay_1-0")));
    expect(page.match(/class="btn primary"/g)).toHaveLength(1);
    expect(page).toMatch(new RegExp(`class="btn primary"[^>]*>${esc(E.reRead)}<`));
    expect(page.match(/role="status"/g)).toHaveLength(1);
    expect(reReadAsk(["northwind_pay_1-0"])).toEqual({
      kind: "repos",
      repos: ["northwind_pay_1-0"],
      force: true,
    });
    // A new link that waits on another repo's facts says so in the same line.
    const waits = view(
      { state: "done", n: 1, callers: ["northwind_pay_1-0"], waitsOn: ["forge-checkout"] },
      [],
      ctx,
    );
    expect(waits).toContain(esc(E.doneWaits(1, "forge-checkout")));
    // No Copilot here: what to do instead, and no button.
    const off = view({ state: "done", n: 1, callers: ["northwind_pay_1-0"], waitsOn: [] }, [], {
      ...ctx,
      allowed: false,
    });
    expect(off).toContain(esc(E.reReadNoCopilot("northwind_pay_1-0")));
    expect(off).not.toContain(esc(E.reRead));
    const none = view({ state: "done", n: 1, callers: [], waitsOn: [] }, [], ctx);
    expect(none).toContain(esc(E.reReadNone));
  });

  it("saved with the build waiting: one line and Review the N removals, to Catalog builds", () => {
    const refused = {
      reasons: ["large-removals" as const],
      message: "waits",
      removals: [
        { id: "if-a", kind: "Interface", path: "interface/if-a.yaml", reasons: ["curated"] },
        { id: "if-b", kind: "Interface", path: "interface/if-b.yaml", reasons: ["curated"] },
      ],
      allowRemovals: 2,
      command: "atticus catalog build --allow-removals 2",
    } as unknown as Api.BuildRefusalViewT;
    const page = view({ state: "saved", n: 2, refused }, []);
    expect(page).toContain(esc(COPY.panelResults.waitsRemovals(2)));
    expect(page).toMatch(
      new RegExp(
        `<a class="btn primary" href="${CATALOG_BUILDS_HREF}">${esc(COPY.panelResults.reviewRemovals(2))}</a>`,
      ),
    );
    // No removal list or confirm here: that is the full-width page's.
    expect(page).not.toContain("if-a");
    expect(
      html(
        <RefusalLink
          refused={
            {
              ...refused,
              removals: [],
              allowRemovals: undefined,
            } as unknown as Api.BuildRefusalViewT
          }
        />,
      ),
    ).toContain(esc(COPY.panelResults.reviewBuild));
  });

  it("Apply sends the list once and reads its 422, a failed job's outcomes, a waiting build and the callers", async () => {
    const l = six();
    const sent: unknown[] = [];
    const done = await applyStaged(l, async (path, body) => {
      sent.push([path, body]);
      return {
        code: 0,
        lines: [],
        result: { callers: ["northwind_pay_1-0"], waitsOn: ["forge-checkout"] },
      };
    });
    expect(sent).toEqual([["/api/map/edits", requestOf(l)]]);
    expect(done).toEqual({
      state: "done",
      n: 6,
      callers: ["northwind_pay_1-0"],
      waitsOn: ["forge-checkout"],
    });

    const refused = await applyStaged(l, async () => {
      throw new ApiError({
        type: "about:blank",
        title: "Some changes can't be made",
        status: 422,
        problems: [{ edit: 3, message: "No system of the profiles is northwind-pay." }],
      });
    });
    expect(refused).toEqual({
      state: "problems",
      problems: [{ edit: 3, message: "No system of the profiles is northwind-pay." }],
    });

    const failed = await applyStaged(l.slice(5), async () => {
      throw new JobFailed("Nothing was built.", ["Nothing was built."], undefined, 1, {
        edits: [{ edit: 0, kind: "redirect", state: "failed", message: "already declared" }],
        built: false,
      });
    });
    expect(failed).toEqual({
      state: "failed",
      text: "Nothing was built.",
      outcomes: [{ edit: 0, state: "not saved", message: "already declared" }],
    });

    const waiting = await applyStaged(l.slice(0, 1), async () => {
      throw new JobFailed("waits", ["waits"], undefined, 1, {
        edits: [{ edit: 0, kind: "delete", state: "saved" }],
        built: false,
        refused: { reasons: ["large-removals"], message: "waits", command: "x" },
      });
    });
    expect(waiting).toMatchObject({
      state: "saved",
      n: 1,
      refused: { reasons: ["large-removals"] },
    });
  });
});

describe("adding and redirecting from a repo's box: Connect to…'s pairing", () => {
  const FACTS = {
    repo: "northwind_pay_1-0",
    file: "facts/northwind_pay_1-0.jsonl",
    present: true,
    facts: [
      ["call.get.refunds-id", "GET", "/refunds/{id}", 13],
      ["call.post.refunds", "POST", "/refunds", 10],
      ["call.get.payments-id", "GET", "/payments/{id}", 4],
    ].map(([id, method, path, line]) => ({
      id: id as string,
      kind: "call",
      label: `${method as string} ${path as string}`,
      claim: { method: method as string, path: path as string },
      cite: { file: "apiproxy/proxies/default.xml", line: line as number, value: "x" },
      verified: "line" as const,
      by: "assistant" as const,
    })),
    corrections: { file: "facts/northwind_pay_1-0.corrections.jsonl", count: 0, stale: [] },
    questions: [],
    verify: "atticus verify northwind_pay_1-0",
    problems: [],
  } as unknown as Api.RepoFactsViewT;
  const APIS = [
    {
      id: "entry.get.refund-status-id",
      kind: "entry" as const,
      method: "GET",
      path: "/refund-status/{id}",
    },
  ];
  const LINELESS: StagedDelete = {
    ...REFUNDS,
    fromRepo: "northwind_pay_1-0",
    callerLines: [],
    shapes: [{ method: "GET", path: "/refunds/{}" }],
  };

  it("offers a lineless arrow's call by its method and path, and says the person picks it", () => {
    const { rows, lineless } = pairRowsForRedirect(FACTS, LINELESS, APIS);
    expect(lineless).toBe(true);
    expect(rows[0]).toEqual({
      call: "call.get.refunds-id",
      label: "GET /refunds/{id}",
      at: "apiproxy/proxies/default.xml:13",
      api: "entry.get.refund-status-id",
    });
    expect(rows.slice(1).every((r) => r.api === "")).toBe(true);
    expect(E.add.lineless("northwind_pay_1-0")).toContain("cites no line");
    // A lined arrow's calls are its caller's lines.
    const lined = pairRowsForRedirect(
      FACTS,
      { ...LINELESS, callerLines: ["apiproxy/proxies/default.xml:10"] },
      APIS,
    );
    expect(lined.lineless).toBe(false);
    expect(lined.rows[0]!.call).toBe("call.post.refunds");
    expect(lined.rows[0]!.api).toBe("entry.get.refund-status-id");
  });

  it("picks no call for a lineless arrow when two of the repo's calls have its method and path", () => {
    const two = {
      ...FACTS,
      facts: [
        ...FACTS.facts,
        {
          ...FACTS.facts[0]!,
          id: "call.get.refunds-id-again",
          cite: { ...FACTS.facts[0]!.cite, line: 40 },
        },
      ],
    } as Api.RepoFactsViewT;
    const r = pairRowsForRedirect(two, LINELESS, APIS);
    expect(r.lineless).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.rows.every((x) => x.api === "")).toBe(true);
    expect(E.add.linelessAmbiguous("northwind_pay_1-0")).toContain("none is picked");
    // One of them: picked, and not ambiguous.
    expect(pairRowsForRedirect(FACTS, LINELESS, APIS).ambiguous).toBe(false);
  });

  it("warns when a call picked already draws another arrow", () => {
    const { rows } = pairRowsForRedirect(FACTS, LINELESS, APIS);
    // GET /refunds/{id} isn't loose: it draws an arrow already.
    expect(drawsAnother(rows, new Set(["call.post.refunds"]), LINELESS).map((r) => r.call)).toEqual(
      ["call.get.refunds-id"],
    );
    // A lined arrow's own call doesn't count as another arrow.
    const lined = { ...LINELESS, callerLines: ["apiproxy/proxies/default.xml:13"] };
    const own = pairRowsForRedirect(FACTS, lined, APIS).rows;
    expect(drawsAnother(own, new Set(), lined)).toEqual([]);
    expect(E.add.drawsAnother("GET /refunds/{id}")).toContain("already draws another arrow");
  });

  it("stages the pairing as a redirect and sends exactly Connect to…'s pairs", () => {
    const { rows } = pairRowsForRedirect(FACTS, LINELESS, APIS);
    const pair = pairOf("northwind_pay_1-0", { repo: "forge-checkout" }, rows)!;
    expect(pair).toEqual({
      from: "northwind_pay_1-0",
      to: { repo: "forge-checkout" },
      pairs: [{ call: "call.get.refunds-id", api: "entry.get.refund-status-id" }],
    });
    expect(pairOf("northwind_pay_1-0", { repo: "forge-checkout" }, [])).toBeUndefined();
    const l = stage([], {
      kind: "redirect",
      delete: LINELESS,
      link: { by: "pair", pair, from: "Repo: northwind_pay_1-0", to: "Repo: forge-checkout" },
      fromBox: REFUNDS.fromBox,
      toBox: "component:payments-api",
    });
    expect(rowWords(l[0]!)).toBe(
      "Redirect northwind-pay-proxy → refunds-api to: Repo: northwind_pay_1-0 → Repo: forge-checkout, 1 call paired",
    );
    expect(requestOf(l).edits[0]).toEqual({
      kind: "redirect",
      delete: {
        interfaces: ["if-1111111111111111"],
        from: "northwind-pay-proxy",
        to: "refunds-api",
      },
      pair,
    });
    // The same call paired again elsewhere is the same change.
    expect(stage(l, { kind: "add", link: { by: "pair", pair, from: "a", to: "b" } })).toHaveLength(
      1,
    );
  });

  it("an add from a repo pairs its loose calls, each suggestion that is sure picked", () => {
    const rows = pairRowsForAdd({
      from: "forge-checkout",
      to: { repo: "forge-refunds" },
      toName: "forge-refunds",
      calls: [
        {
          fact: "c1",
          callType: "rest",
          method: "GET",
          path: "/refunds/{id}",
          at: "A.java:3",
          status: "left",
          suggestion: { api: "e1", score: 1, why: "same-path" },
          confident: true,
        },
        { fact: "c2", callType: "rest", path: "/x", at: "A.java:9", status: "left" },
        {
          fact: "c3",
          callType: "rest",
          path: "/y",
          at: "A.java:12",
          status: "paired",
          paired: "e1",
        },
      ],
      apis: [],
    } as unknown as Api.LinkCandidatesViewT);
    expect(rows.map((r) => [r.call, r.api])).toEqual([
      ["c1", "e1"],
      ["c2", ""],
    ]);
  });

  it("names every call's API field, and a box with no repo can't be redirected by pairing", () => {
    const page = html(
      <PairRowsView
        caption={E.add.redirectCalls("northwind_pay_1-0")}
        rows={pairRowsForRedirect(FACTS, LINELESS, APIS).rows}
        apis={APIS}
        onPick={noop}
      />,
    );
    expect(page).toContain("<fieldset");
    expect(page).toContain(esc(E.add.redirectCalls("northwind_pay_1-0")));
    for (const label of ["GET /refunds/{id}", "POST /refunds", "GET /payments/{id}"])
      expect(page).toContain(`aria-label="${esc(E.add.callApi(label))}"`);
    expect(page).toContain(esc(E.add.notPaired));
    const fromSystem = html(
      <AddLinkForm
        systems={[
          { box: "system:northwind-pay", system: "northwind-pay", label: "System: Northwind Pay" },
        ]}
        targets={[]}
        staged={[]}
        redirect={{ ...LINELESS, fromBox: "component:other" }}
        onStage={noop}
      />,
    );
    expect(fromSystem).toContain(esc(E.add.redirectNoRepo));
    const fromRepo = html(
      <AddLinkForm
        systems={[
          { box: "repo:forge-checkout", repo: "forge-checkout", label: "Repo: forge-checkout" },
        ]}
        targets={[
          {
            box: "repo:forge-refunds",
            label: "Repo: forge-refunds",
            link: { repo: "forge-refunds" },
          },
        ]}
        staged={[]}
        onStage={noop}
      />,
    );
    expect(fromRepo).toContain(esc(E.add.pairIntro));
    expect(fromRepo).toContain(esc(E.add.toPick));
    expect(fromRepo).not.toContain(esc(E.add.kind));
  });
});

describe("results in the canvas's narrow panel (the re-review of beta.28)", () => {
  const refused = {
    reasons: ["large-removals" as const],
    message: "waits",
    removals: [{ id: "if-a", kind: "Interface", path: "interface/if-a.yaml", reasons: ["slot"] }],
    allowRemovals: 1,
    command: "atticus verify forge-web --write --allow-removals 1",
  } as unknown as Api.BuildRefusalViewT;
  const ok = async () => undefined;

  it("confirms a refused verify Apply in place: a refused verify writes nothing to confirm elsewhere", () => {
    const page = html(
      <ResultsInPanel.Provider value={true}>
        {applyRefused({ refused, onAllowRemovals: ok, onCurate: ok, onDiscard: ok })}
      </ResultsInPanel.Provider>,
    );
    expect(page).toContain(esc(COPY.catalogBuild.refusedTitle));
    // Its own confirm, a button here, never a link away to a page with nothing to confirm.
    expect(page).not.toContain(CATALOG_BUILDS_HREF);
    expect(page).not.toContain("<a ");
    expect(page).toMatch(/<button type="button" class="btn primary">[^<]+<\/button>/);
  });

  it("folds what a step printed under one line, in full outside the panel", () => {
    const folded = html(<>{stepLines(["a", "b"], true)}</>);
    expect(folded).toContain("<details");
    expect(folded).toContain(esc(COPY.panelResults.printed(2)));
    expect(folded).toContain("a\nb");
    expect(html(<>{stepLines(["a"], false)}</>)).not.toContain("<details");
  });
});
