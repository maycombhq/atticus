import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import {
  detectFeaturesWithReport,
  featureMergeDecision,
  featureSplitDecisions,
  FeatureError,
} from "../src/index.js";
import { detectFeaturesWithReport as onMain } from "./oracle/detect-main.js";
import { build } from "./helpers.js";

/**
 * beta.28.1 (field report 6): the features' grouping works by number (a union-find of places in
 * the entry list that joins exactly when the groups do, and who another member's flow reaches
 * worked out once every group is joined). `oracle/detect-main.ts` is detect.ts as it was before
 * (main at 63869566, its imports pointed at src/), kept as the oracle: over random estates (calls
 * through a gateway and from a UI, events across systems, tables, schedules and jobs, few nouns
 * so many flows share a resource) and random decisions (membership pins that split features, an
 * entry point pinned twice, a pin of an id not in the catalog, merges), detection gives the same
 * features, flows and problems, in the same order.
 */
const NOUNS = ["account", "balance", "payment", "transfer", "card", "ledger", "refund", "fee"];
const METHODS = ["GET", "POST", "PUT", "DELETE"];
const TYPES = ["service", "service", "service", "spa", "batch-job"];
const AT = (n: number) => `2026-11-${String(10 + (n % 9)).padStart(2, "0")}T09:00:00Z`;

/** mulberry32. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function estate(seed: number): CatalogRecord[] {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const out = new Map<string, CatalogRecord>();
  const put = (r: CatalogRecord) => out.set(`${r.kind}|${r.id}`, r);
  const systems = ["contoso", "fabrikam", "tailspin"];
  for (const s of systems) put(build.system(s));
  put(build.system("northwind", "vendor"));
  const comps: { id: string; type: string; system: string }[] = [];
  const n = 4 + Math.floor(rnd() * 9);
  for (let k = 0; k < n; k++) {
    const c = { id: `svc-${k}`, type: pick(TYPES), system: pick(systems) };
    comps.push(c);
    put(build.component(c.id, c.system, c.type));
  }
  put(build.component("northwind-api", "northwind"));
  const endpoints: { id: string; component: string; method: string; path: string }[] = [];
  for (const c of comps) {
    if (c.type === "spa") continue;
    for (let k = 0, m = 1 + Math.floor(rnd() * 6); k < m; k++) {
      const method = pick(METHODS);
      const path = `/${pick(NOUNS)}s/{id}/${pick(NOUNS)}s`;
      const e = build.endpoint(c.id, method, path, `Api${k}.java`, k + 1);
      if (out.has(`Endpoint|${e.id}`)) continue;
      put(e);
      endpoints.push({ id: e.id, component: c.id, method, path });
    }
    if (c.type === "batch-job" && rnd() < 0.5)
      put(build.schedule(c.id, `schedule.${pick(NOUNS)}-sync`));
  }
  for (let k = 0, m = Math.floor(rnd() * 6 * n); k < m && endpoints.length; k++) {
    const e = pick(endpoints);
    const from = pick(comps).id;
    if (from === e.component) continue;
    const via = rnd() < 0.2 ? "gateway" : "direct";
    put(build.call(from, e.component, e.method, e.path, { endpoint: e.id, via }));
  }
  // Calls out to a vendor, and calls with no endpoint (a loose end).
  for (let k = 0; k < 2; k++)
    put(build.call(pick(comps).id, "northwind-api", "POST", `/v2/${pick(NOUNS)}s`));
  for (let k = 0, m = Math.floor(rnd() * n); k < m; k++) {
    const topic = `${pick(NOUNS)}.${pick(["created", "settled"])}`;
    const from = pick(comps).id;
    const to = pick(comps).id;
    if (from === to) continue;
    put(build.topic(from, topic));
    put(build.event(from, to, topic));
  }
  for (let k = 0, m = Math.floor(rnd() * n); k < m; k++) {
    const some = () => comps.filter(() => rnd() < 0.3).map((c) => c.id);
    put(build.table(`db-${k % 3}`, `${pick(NOUNS)}_${k}`, { readers: some(), writers: some() }));
  }
  return [...out.values()];
}

/** Random decisions on what main detects: splits, a double pin, a pin of nothing, merges. */
function decisions(seed: number, records: CatalogRecord[]): CatalogRecord[] {
  const rnd = prng(seed * 7 + 3);
  const found = onMain(records).features;
  const out: CatalogRecord[] = [];
  let n = 0;
  const by = () => ({ by: "a.owner", at: AT(n++) });
  for (const f of found) {
    const r = rnd();
    if (r < 0.6 && f.entryPoints.length > 1) {
      const some = f.entryPoints.filter(() => rnd() < 0.5);
      if (some.length && some.length < f.entryPoints.length)
        try {
          out.push(...featureSplitDecisions(f, some, { into: `${f.id}-split-${n}`, ...by() }));
        } catch (e) {
          if (!(e instanceof FeatureError)) throw e;
        }
    } else if (r < 0.7 && found.length > 1) {
      const other = found[Math.floor(rnd() * found.length)]!;
      if (other.id !== f.id)
        try {
          out.push(featureMergeDecision(f, [other], by()));
        } catch (e) {
          if (!(e instanceof FeatureError)) throw e;
        }
    }
  }
  // An entry point pinned to two features (the later pin wins), and a pin of an id not there.
  const attempt = (make: () => CatalogRecord[]) => {
    try {
      out.push(...make());
    } catch (e) {
      if (!(e instanceof FeatureError)) throw e;
    }
  };
  // Single entry points pinned to features of their own (only the split's first decision): the
  // rest of their features stay unpinned, so an unpinned flow can reach two pinned groups, and
  // the order of its joins decides which it joins.
  for (let k = 0, m = Math.floor(rnd() * 4); k < m && found.length; k++) {
    const f = found[Math.floor(rnd() * found.length)]!;
    const e = f.entryPoints[Math.floor(rnd() * f.entryPoints.length)]!;
    attempt(() => featureSplitDecisions(f, [e], { into: `feature.pin-${k}`, ...by() }).slice(0, 1));
  }
  const f0 = found[0];
  if (f0 && found.length > 1 && rnd() < 0.5)
    attempt(() =>
      featureSplitDecisions(f0, [f0.entryPoints[0]!], {
        into: "feature.pinned-again",
        ...by(),
      }).slice(0, 1),
    );
  if (f0 && rnd() < 0.3)
    attempt(() =>
      featureSplitDecisions(
        { ...f0, entryPoints: ["svc-0.not-there", ...f0.entryPoints] },
        ["svc-0.not-there"],
        { into: "feature.nothing", ...by() },
      ).slice(0, 1),
    );
  return out;
}

const RUNS = 300;

describe("the features' grouping by number gives what main's grouping gave (beta.28.1)", () => {
  it(`${RUNS} random estates, with and without people's decisions`, () => {
    let pinned = 0;
    let grouped = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const records = estate(seed);
      const ds = seed % 3 === 0 ? [] : decisions(seed, records);
      if (ds.length) pinned++;
      const now = detectFeaturesWithReport(records, { decisions: ds });
      const was = onMain(records, { decisions: ds });
      expect(now.features, `seed ${seed}`).toEqual(was.features);
      expect(now.problems, `seed ${seed}`).toEqual(was.problems);
      expect([...now.flows.keys()], `seed ${seed}`).toEqual([...was.flows.keys()]);
      for (const [id, f] of now.flows) {
        const w = was.flows.get(id)!;
        expect([...f.records], `seed ${seed} ${id}`).toEqual([...w.records]);
        expect([...f.reached], `seed ${seed} ${id}`).toEqual([...w.reached]);
      }
      // As a scan detects (no flows kept).
      expect(
        detectFeaturesWithReport(records, { decisions: ds, keepFlows: false }).features,
      ).toEqual(was.features);
      if (now.features.some((f) => f.entryPoints.length > 1)) grouped++;
    }
    // The estates exercise what changed: features of several entry points, and pins.
    expect(grouped).toBeGreaterThan(RUNS / 3);
    expect(pinned).toBeGreaterThan(RUNS / 3);
  });
});
