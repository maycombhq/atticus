import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Laid } from "../src/app/layout/index.js";
import {
  availableHeight,
  DiagramFrame,
  FIT_MAX,
  fitLegibly,
  KEYS_LINE,
  MAX_TOP,
  stageHeight,
  ZOOM,
} from "../src/app/viewer.js";
import {
  canvasFit,
  FIT_MIN_ZOOM,
  FIT_PADDING,
  fitPad,
  flowElements,
  LABEL_TRIES,
  labelSpot,
  labelSpots,
  linkLabelSize,
  type BoxRect,
} from "../src/screens/architecture/Canvas.js";
import type { CanvasBox, CanvasGraph } from "../src/screens/architecture/model.js";
import { ExcerptView } from "../src/screens/Questions.js";

/**
 * Beta.27: the map's canvas fitted so its words can be read, its link labels clear of the boxes,
 * and its keys line whole; the Questions page's cited code line read whole. Invented Forge names.
 */

const css = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const rule = (text: string, sel: string) => {
  const at = text.indexOf(`${sel} {`);
  expect(at, `${sel} is styled`).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf("}", at));
};

describe("the canvas is fitted so its words can be read", () => {
  it("never fits below the zoom whose words are legible", () => {
    // A box's name is 12 px, its kind line 11 px: at the floor both are about 10 px or more.
    expect(12 * FIT_MIN_ZOOM).toBeGreaterThanOrEqual(10.5);
    expect(11 * FIT_MIN_ZOOM).toBeGreaterThanOrEqual(9.5);
  });

  it("starts a picture too big for the floor at its top-left, to be panned", () => {
    // Beta.26: an estate 1400 px tall fitted at 60 % in an 800 px frame.
    const v = fitLegibly(
      { x: 10, y: 20, w: 600, h: 1400 },
      { width: 1000, height: 800 },
      { min: FIT_MIN_ZOOM, pad: 24 },
    );
    expect(v.k).toBe(FIT_MIN_ZOOM);
    // Too tall: its top at the top; narrow enough: centred across.
    expect(v.y).toBeCloseTo(24 - 20 * FIT_MIN_ZOOM);
    expect(v.x).toBeCloseTo((1000 - 600 * FIT_MIN_ZOOM) / 2 - 10 * FIT_MIN_ZOOM);
  });

  it("fits and centres a picture that fits", () => {
    const v = fitLegibly(
      { x: 0, y: 0, w: 400, h: 300 },
      { width: 1000, height: 800 },
      { min: FIT_MIN_ZOOM, max: 1 },
    );
    expect(v).toEqual({ k: 1, x: 300, y: 250 });
  });
});

describe("a link's label sits on its route, clear of the boxes", () => {
  // Portal above, Ledger below; Audit and payments.initiated side by side between them, the
  // route from Portal to Ledger running down the gap beside payments.initiated.
  const payments: BoxRect = { x: 200, y: 180, width: 160, height: 82 };
  const audit: BoxRect = { x: 0, y: 180, width: 150, height: 64 };
  const route = [
    { x: 180, y: 64 },
    { x: 180, y: 400 },
  ];
  const size = linkLabelSize({ label: "2 × calls", gaps: ["no-fact"] });
  const overlaps = (c: { x: number; y: number }, r: BoxRect) =>
    c.x - size.width / 2 < r.x + r.width &&
    c.x + size.width / 2 > r.x &&
    c.y - size.height / 2 < r.y + r.height &&
    c.y + size.height / 2 > r.y;

  it("counts the warning mark in the label's room", () => {
    expect(size.width).toBeGreaterThan(linkLabelSize({ label: "2 × calls", gaps: [] }).width);
  });

  it("moves along the route off a box it would run under", () => {
    // Beta.26: the middle (180, 232) is under payments.initiated.
    expect(overlaps({ x: 180, y: 232 }, payments)).toBe(true);
    const c = labelSpot(route, size, [audit, payments]);
    expect(c.x).toBe(180);
    expect(overlaps(c, payments)).toBe(false);
    expect(overlaps(c, audit)).toBe(false);
  });

  it("stays in the middle when the middle is clear, and there when nothing is", () => {
    expect(labelSpot(route, size, [])).toEqual({ x: 180, y: 232 });
    const wall: BoxRect = { x: 0, y: 0, width: 400, height: 600 };
    expect(labelSpot(route, size, [wall])).toEqual({ x: 180, y: 232 });
  });

  it("places each laid-out link's label so", () => {
    const box = (id: string, label: string, kind = "system"): CanvasBox => ({
      id,
      label,
      kind,
      gaps: [],
      childCount: 0,
      outside: false,
      group: false,
      inside: 0,
    });
    const graph: CanvasGraph = {
      boxes: [
        box("system:portal", "Portal"),
        box("system:audit", "Audit"),
        box("topic:payments.initiated", "payments.initiated", "topic"),
        box("system:ledger", "Ledger"),
      ],
      links: [
        {
          id: "l1",
          from: "system:portal",
          to: "system:ledger",
          label: "2 × calls",
          gaps: ["no-fact"],
        } as CanvasGraph["links"][number],
      ],
    } as CanvasGraph;
    const placed = (id: string, r: BoxRect) => ({ id, ...r, group: false });
    const laid = {
      boxes: {
        "system:portal": placed("system:portal", { x: 100, y: 0, width: 160, height: 64 }),
        "system:audit": placed("system:audit", audit),
        "topic:payments.initiated": placed("topic:payments.initiated", payments),
        "system:ledger": placed("system:ledger", { x: 100, y: 400, width: 160, height: 64 }),
      },
      routes: { l1: { id: "l1", from: "system:portal", to: "system:ledger", points: route } },
      dropped: [],
    } as unknown as Laid;
    const { edges } = flowElements(graph, laid, "DOWN");
    const at = edges[0]!.data!.labelAt!;
    expect(overlaps(at, payments)).toBe(false);
  });

  it("beta.27 review: keeps two links' labels off each other too, through flowElements", () => {
    // Portal calls Ledger twice (two routes side by side, 10 px apart): beta.27's first cut put
    // both labels at their routes' middles, one on the other.
    const box = (id: string, label: string): CanvasBox => ({
      id,
      label,
      kind: "system",
      gaps: [],
      childCount: 0,
      outside: false,
      group: false,
      inside: 0,
    });
    const link = (id: string, label: string) =>
      ({
        id,
        from: "system:portal",
        to: "system:ledger",
        label,
        gaps: [],
      }) as unknown as CanvasGraph["links"][number];
    const graph = {
      boxes: [box("system:portal", "Portal"), box("system:ledger", "Ledger")],
      links: [link("l1", "calls"), link("l2", "publishes to")],
    } as CanvasGraph;
    const placed = (id: string, r: BoxRect) => ({ id, ...r, group: false });
    const routeAt = (x: number) => [
      { x, y: 64 },
      { x, y: 400 },
    ];
    const laid = {
      boxes: {
        "system:portal": placed("system:portal", { x: 100, y: 0, width: 160, height: 64 }),
        "system:ledger": placed("system:ledger", { x: 100, y: 400, width: 160, height: 64 }),
      },
      routes: {
        l1: { id: "l1", from: "system:portal", to: "system:ledger", points: routeAt(175) },
        l2: { id: "l2", from: "system:portal", to: "system:ledger", points: routeAt(185) },
      },
      dropped: [],
    } as unknown as Laid;
    const { edges } = flowElements(graph, laid, "DOWN");
    const rect = (e: (typeof edges)[number]) => {
      const s = linkLabelSize(e.data!.link);
      const c = e.data!.labelAt!;
      return { x: c.x - s.width / 2, y: c.y - s.height / 2, width: s.width, height: s.height };
    };
    const [a, b] = edges.map(rect) as [BoxRect, BoxRect];
    const apart =
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
    expect(apart).toBe(true);
    // The first stays where it would alone: the middle of its route.
    expect(edges[0]!.data!.labelAt).toEqual({ x: 175, y: 232 });
  });

  it("beta.27 review: tries a bounded number of spots, then the first clear of the boxes", () => {
    // A route of many segments, every spot under a label already placed.
    const long = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 10 }));
    const everywhere: BoxRect = { x: -500, y: -500, width: 1000, height: 1000 };
    const c = labelSpot(long, size, [], [everywhere]);
    // Nothing is clear of the labels: the first spot clear of the boxes (the middle's).
    expect(c).toEqual(labelSpot(long, size, []));
    expect(LABEL_TRIES).toBeLessThanOrEqual(50);
    // labelSpots places them in order.
    const spots = labelSpots(
      [
        { id: "a", points: route, size },
        { id: "b", points: route, size },
        { id: "none", size },
      ],
      [],
    );
    expect([...spots.keys()]).toEqual(["a", "b"]);
    expect(spots.get("a")).toEqual({ x: 180, y: 232 });
    expect(spots.get("b")).not.toEqual(spots.get("a"));
  });
});

describe("the canvas's fit, as Fit and a resize run it", () => {
  it("beta.27 review: never zooms a small picture in past actual size", () => {
    // Beta.27's first cut passed ZOOM.max (3): a two-box estate filled the frame at 300 %.
    const v = canvasFit({ x: 0, y: 0, w: 300, h: 100 }, { width: 1200, height: 800 });
    expect(v.k).toBe(FIT_MAX);
    expect(v.k).toBeLessThan(ZOOM.max);
    expect(v).toEqual({ k: 1, x: 450, y: 350 });
  });

  it("keeps fitView's 0.08 padding round a picture that fills the frame", () => {
    // fitView(padding 0.08) fits the bounds to the view over 1.08; canvasFit's pad matches it.
    const view = { width: 1080, height: 1080 };
    expect(fitPad(view)).toBe(Math.round((1080 - 1080 / (1 + FIT_PADDING)) / 2));
    const v = canvasFit({ x: 0, y: 0, w: 1000, h: 1000 }, view);
    expect(v.k).toBeCloseTo(1, 2);
    expect(v.x).toBeCloseTo(40, 0);
    expect(v.y).toBeCloseTo(40, 0);
  });

  it("starts a picture too big for the legible floor at its top-left, padded", () => {
    const view = { width: 1000, height: 800 };
    const v = canvasFit({ x: 10, y: 20, w: 600, h: 1400 }, view);
    expect(v.k).toBe(FIT_MIN_ZOOM);
    expect(v.y).toBeCloseTo(fitPad(view) - 20 * FIT_MIN_ZOOM);
  });
});

describe("the keys line under a picture is read whole", () => {
  it("is in sentence case and wraps, never the HUD's capitals in one line", () => {
    const out = renderToStaticMarkup(
      <DiagramFrame title="Estate" full={false} height={600} toolbar={null} onKeyAction={() => {}}>
        <div />
      </DiagramFrame>,
    );
    expect(out).toContain('<p class="viewer-keys">');
    const r = rule(css("../src/styles/hud.css"), ".viewer-keys");
    expect(r).not.toMatch(/nowrap|uppercase/);
    expect(r).toMatch(/overflow-wrap: anywhere/);
  });

  it("takes the room a wrapped line needs from the picture", () => {
    expect(stageHeight(600, KEYS_LINE)).toBe(600);
    expect(stageHeight(600, KEYS_LINE * 2)).toBe(600 - KEYS_LINE);
  });

  it("beta.27 review: the picture's height leaves the keys line's one line under it", () => {
    // The window less the picture's top, the keys line and a small margin.
    expect(availableHeight(900, 100)).toBe(900 - 100 - KEYS_LINE - 8);
    expect(availableHeight(900, 2400)).toBe(900 - MAX_TOP - KEYS_LINE - 8);
    // DiagramFrame's own doc comment sits on DiagramFrame.
    const src = css("../src/app/viewer.tsx");
    const at = src.indexOf("export function DiagramFrame(");
    expect(src.slice(src.lastIndexOf("*/", at) - 400, at)).toMatch(/The frame round a picture/);
    expect(src.slice(src.lastIndexOf("*/", at), at).trim()).toBe("*/");
  });
});

describe("the cited line on Questions is read whole", () => {
  const long =
    '    return http.get().uri("http://rates-cache:8080/cache/" + key).retrieve().body(Cached.class);';

  it("wraps each line of code under itself, its number in its own column", () => {
    const out = renderToStaticMarkup(
      <ExcerptView
        e={{
          ref: "src/main/java/forge/teller/RatesClient.java:17",
          line: 17,
          start: 16,
          lines: ["  public Cached cached(String key) {", long, "  }"],
          found: true,
        }}
      />,
    );
    // The whole line is there, marked, in the column that wraps.
    expect(out).toContain(
      `<span class="qs-lc"><mark>${long.replace(/"/g, "&quot;")}</mark></span>`,
    );
    expect(out).toContain('<span class="qs-line" aria-current="true">');
    // Still a region the keyboard reaches and scrolls (it is as tall as 16 lines at most).
    expect(out).toMatch(/<pre class="mono qs-code" tabindex="0" role="region" aria-label="[^"]+"/);
    const text = css("../src/screens/questions.css");
    expect(rule(text, ".qs-lc")).toMatch(/white-space: pre-wrap/);
    expect(rule(text, ".qs-lc")).toMatch(/overflow-wrap: anywhere/);
    expect(rule(text, ".qs-code > .qs-line")).toMatch(/grid-template-columns: max-content/);
  });
});
