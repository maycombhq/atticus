import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  changeSketchCommand,
  lineParts,
  readDrawioSketch,
  readMermaidSketch,
} from "../src/change-sketch.js";

/**
 * ADR 0179: a change drawn in draw.io or Mermaid first, read back as strokes into its target
 * flows. On the invented Forge stages fixture (forge-orders calls forge-stock today).
 */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/stages");
let root: string;
const io = () => {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`! ${l}`) } };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-change-sketch-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
});

const MERMAID = [
  "flowchart LR",
  "  %% the sketch",
  "  orders[forge-orders]",
  "  pay[Northwind Pay]",
  "  orders -->|[New] POST /v1/screenings| pay",
  "  orders -- POST /stock/reservations --> stock[forge-stock]",
  "  orders -->|[Retired] POST /stock/reservations| stock",
  "  orders -->|forge.orders.placed| stock",
  "  ghost[forge-ghost] -->|GET /x| orders",
  "  nonsense here",
  "  orders <--> stock",
  "  orders -.->|forge.orders.cancelled| pay",
  "  v2[Orders (v2)] --> stock",
].join("\n");

describe("reading a sketch", () => {
  it("reads Mermaid lines with their labels, marks and box names, and says what isn't one", () => {
    expect(lineParts("POST /v1/screenings")).toEqual({ method: "POST", path: "/v1/screenings" });
    expect(lineParts("forge.orders.placed")).toEqual({ topic: "forge.orders.placed" });
    expect(lineParts("screens the order")).toEqual({});
    const r = readMermaidSketch(MERMAID);
    expect(r.lines.map((l) => [l.from, l.to, l.label, l.legend])).toEqual([
      ["forge-orders", "Northwind Pay", "POST /v1/screenings", "new"],
      ["forge-orders", "forge-stock", "POST /stock/reservations", undefined],
      ["forge-orders", "forge-stock", "POST /stock/reservations", "retire"],
      ["forge-orders", "forge-stock", "forge.orders.placed", undefined],
      ["forge-ghost", "forge-orders", "GET /x", undefined],
      ["forge-orders", "Northwind Pay", "forge.orders.cancelled", undefined],
      ["Orders (v2)", "forge-stock", "", undefined],
    ]);
    expect(r.problems).toEqual([
      "line 10: not a box or a line: nonsense here",
      "line 11: a two-way line: draw one line each way: orders <--> stock",
    ]);
  });

  it("reads a draw.io export through the reconcile reader", () => {
    const xml = `<mxfile><diagram name="Sketch"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="forge-orders" vertex="1" parent="1"/>
      <mxCell id="b" value="Northwind Pay" style="legend=new" vertex="1" parent="1"/>
      <mxCell id="e" value="POST /v1/screenings" edge="1" source="a" target="b" parent="1"/>
    </root></mxGraphModel></diagram></mxfile>`;
    const r = readDrawioSketch(xml);
    expect(r.lines).toMatchObject([
      { from: "forge-orders", to: "Northwind Pay", method: "POST", path: "/v1/screenings" },
    ]);
  });
});

describe("atticus change sketch", () => {
  it("shows what it would draw and what it leaves out, writes nothing without --save, then draws", async () => {
    const file = join(root, "sketch.mmd");
    await writeFile(file, MERMAID);
    const a = io();
    expect(
      await changeSketchCommand(root, "add-fraud-check", { from: file, by: "pat" }, a.io),
    ).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("Would draw: forge-orders → Northwind Pay POST /v1/screenings (line 5)");
    expect(text).toContain(
      "Would draw: forge-orders → forge-stock POST /stock/reservations (line 7)",
    );
    expect(text).toContain("Would draw: forge-orders → forge-stock forge.orders.placed (line 8)");
    expect(text).toContain("(line 6): already on today's map; nothing to draw.");
    expect(text).toContain("forge-ghost isn't a component of the catalog");
    expect(text).toContain("Didn't read: line 10");
    expect(text).toContain("nothing written");
    expect(
      await readdir(join(root, "openspec/changes/add-fraud-check/target-flows")).catch(() => []),
    ).toEqual([]);
    const b = io();
    expect(
      await changeSketchCommand(
        root,
        "add-fraud-check",
        { from: file, save: true, by: "pat" },
        b.io,
      ),
    ).toBe(0);
    expect(b.out.join("\n")).toContain("4 strokes written");
    const files = await readdir(join(root, "openspec/changes/add-fraud-check/target-flows"));
    expect(files).toContain("forge-orders.place-order.yaml");
    // The listener's side of the topic lands on forge-stock's flow.
    expect(files).toContain("forge-stock.reserve-stock.yaml");
    expect(await changeSketchCommand(root, "no-such", { from: file }, io().io)).toBe(2);
    expect(await changeSketchCommand(root, undefined, {}, io().io)).toBe(2);
  });
});
