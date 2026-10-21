import { describe, expect, it } from "vitest";
import {
  Api,
  DiagramLayout,
  layoutPath,
  openApiDocument,
  workspaceJsonSchemas,
} from "../src/index.js";

describe("the hierarchical graph API (ADR 0081)", () => {
  it("is in the OpenAPI document with its views and the layout file routes", () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths["/api/graph/node/{id}"]!.get!.operationId).toBe("getGraphNode");
    expect(doc.paths["/api/graph/focus/{id}"]!.get!.operationId).toBe("getGraphFocus");
    expect(doc.paths["/api/graph/layout/{viewKey}"]!.put!.operationId).toBe("putViewLayout");
    expect(doc.components.schemas).toHaveProperty("GraphNodeView");
    expect(doc.components.schemas).toHaveProperty("GraphFocusView");
  });

  it("takes node ids of the form estate or <kind>:<record id>, and nothing that leaves a folder", () => {
    expect(Api.HierId.safeParse("estate").success).toBe(true);
    expect(Api.HierId.safeParse("system:ledger").success).toBe(true);
    expect(Api.HierId.safeParse("table:ledger-db.entry").success).toBe(true);
    for (const bad of ["", "System:ledger", "system:../x", "system:", "a/b"])
      expect(Api.HierId.safeParse(bad).success, bad).toBe(false);
  });

  it("checks a keep-this-arrangement request", () => {
    const ok = {
      lens: "architecture",
      node: "estate",
      positions: { "system:ledger": { x: 1, y: 2 } },
    };
    expect(Api.PutLayoutRequest.safeParse(ok).success).toBe(true);
    expect(Api.PutLayoutRequest.safeParse({ ...ok, lens: "flow" }).success).toBe(false);
    expect(
      Api.PutLayoutRequest.safeParse({ ...ok, positions: { "../x": { x: 1, y: 2 } } }).success,
    ).toBe(false);
  });
});

describe("a kept arrangement file (C6, ADR 0081)", () => {
  it("lives at diagrams/layouts/<view-key>.yaml and has a JSON Schema", () => {
    expect(layoutPath("architecture.estate")).toBe("diagrams/layouts/architecture.estate.yaml");
    const f = {
      schemaVersion: 1,
      view: "architecture.estate",
      lens: "architecture",
      node: "estate",
      by: "Pat Doe",
      at: "2026-10-21T10:00:00Z",
      positions: { "system:ledger": { x: 10, y: 20 } },
    };
    expect(DiagramLayout.parse(f)).toEqual(f);
    expect(DiagramLayout.safeParse({ ...f, view: "../escape" }).success).toBe(false);
    expect(DiagramLayout.safeParse({ ...f, schemaVersion: 2 }).success).toBe(false);
    const s = workspaceJsonSchemas() as Record<string, { $id: string }>;
    expect(s.DiagramLayout!.$id).toContain("/workspace/v1/DiagramLayout.json");
  });
});
