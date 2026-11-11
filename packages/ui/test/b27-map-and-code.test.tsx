import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Laid } from "../src/app/layout/index.js";
import { DiagramFrame, fitLegibly, KEYS_LINE, stageHeight } from "../src/app/viewer.js";
import {
  FIT_MIN_ZOOM,
  flowElements,
  labelSpot,
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
