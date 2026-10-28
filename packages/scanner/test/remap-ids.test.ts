import { describe, expect, it } from "vitest";
import { RecordId } from "@maycombhq/core";
import { remapIds } from "../src/facts-catalog.js";

/**
 * A call's schemas (`<call>.<side>`) follow the Interface the call joined to. An interface id
 * names both ends and the path, so `<interface>.request` can pass the 120-character id limit:
 * a long id is shortened to a stable one, the same wherever it is renamed.
 */
const long = `connected-outside.connected-outside-instruments.put-${"outside-instruments-status-".repeat(2)}x`;

describe("remapIds: ids that follow a renamed record", () => {
  it("renames the record and every id under it", () => {
    const re = remapIds(new Map([["a.call-b", "a.b.get-x"]]));
    expect(re("a.call-b")).toBe("a.b.get-x");
    expect(re("a.call-b.request")).toBe("a.b.get-x.request");
    expect(re("a.other")).toBe("a.other");
    expect(re("a.call-bee")).toBe("a.call-bee");
  });

  it("keeps a renamed id within the 120-character limit, the same every time", () => {
    expect(long.length).toBeLessThanOrEqual(120);
    const re = remapIds(new Map([["svc.call-status", long]]));
    const req = re("svc.call-status.request");
    const res = re("svc.call-status.response");
    for (const id of [req, res]) {
      expect(id.length).toBeLessThanOrEqual(120);
      expect(RecordId.safeParse(id).success, id).toBe(true);
    }
    expect(req).not.toBe(res);
    expect(re("svc.call-status.request")).toBe(req);
    expect(remapIds(new Map([["svc.call-status", long]]))("svc.call-status.request")).toBe(req);
    // The record itself fits already and keeps its name.
    expect(re("svc.call-status")).toBe(long);
  });
});
