import { createHash } from "node:crypto";
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

/** remapIds as it was before beta.28.1: a walk of the whole map, the first prefix in its order. */
function walked(remap: ReadonlyMap<string, string>): (id: string) => string {
  return (id) => {
    const exact = remap.get(id);
    if (exact) return exact;
    for (const [from, to] of remap)
      if (id.startsWith(`${from}.`)) {
        const out = to + id.slice(from.length);
        if (out.length <= 120) return out;
        const hash = createHash("sha256").update(out, "utf8").digest("hex").slice(0, 16);
        return `${out.slice(0, 120 - hash.length - 1).replace(/[-._]+$/, "")}.${hash}`;
      }
    return id;
  };
}

describe("remapIds looks prefixes up (beta.28.1) and gives what the walk gave", () => {
  it("over many maps with nested, empty and long names, in every order", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const parts = ["a", "b", "svc", "call-b", "x", "", "request", "get-x"];
    const pick = () => parts[Math.floor(rnd() * parts.length)]!;
    const idOf = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, pick).join(".");
    for (let n = 0; n < 400; n++) {
      const remap = new Map<string, string>();
      for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++)
        remap.set(idOf(), rnd() < 0.1 ? "" : rnd() < 0.2 ? long : idOf());
      const fast = remapIds(remap);
      const slow = walked(remap);
      for (let k = 0; k < 30; k++) {
        const id = idOf();
        expect(fast(id), `${id} in ${JSON.stringify([...remap])}`).toBe(slow(id));
      }
      for (const key of remap.keys()) expect(fast(`${key}.request`)).toBe(slow(`${key}.request`));
    }
  });
});

describe("remapIds on a big estate (beta.28.1)", () => {
  it("renames 20,000 ids against a 20,000-entry map in well under a second of CPU", () => {
    // The walk of the whole map for each id it doesn't hold was 400 million comparisons here.
    const remap = new Map<string, string>();
    for (let k = 0; k < 20_000; k++) remap.set(`svc-${k % 60}.call-${k}`, `if-${k}`);
    const re = remapIds(remap);
    const c = process.cpuUsage();
    let renamed = 0;
    for (let k = 0; k < 20_000; k++) {
      if (re(`svc-${k % 60}.call-${k}.request`) !== `svc-${k % 60}.call-${k}.request`) renamed++;
      re(`svc-${k % 60}.get-items-${k}`);
    }
    const used = process.cpuUsage(c);
    expect(renamed).toBe(20_000);
    expect((used.user + used.system) / 1e6).toBeLessThan(1);
  });
});
