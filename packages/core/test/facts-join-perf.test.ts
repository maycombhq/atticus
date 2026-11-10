import { describe, expect, it } from "vitest";
import { joinFacts, type Fact, type JoinRepo } from "../src/index.js";

/**
 * The join at an estate's size (review of beta.24): 40 repos of 250 entries, calls and settings
 * each, a fifth of them gateways whose proxies cite a BasePath, every call's host a setting
 * nothing resolves so each is placed by its whole path. The join looks its candidates up by the
 * path's shape and the repo, never scanning every entry for every call, so it finishes in seconds.
 * Invented Forge repos only.
 */
const syntheticEstate = (nRepos: number, nEach: number): JoinRepo[] => {
  const gateways = Math.max(1, nRepos / 5);
  const repos: JoinRepo[] = [];
  const common = { commit: "1111aaa", verified: "line", by: "assistant", conf: "declared" };
  for (let r = 0; r < nRepos; r++) {
    const repo = `forge-svc-${r}`;
    const gw = r < gateways;
    const facts: Fact[] = [];
    for (let i = 0; i < nEach; i++) {
      const file = gw ? `p${i % 10}/apiproxy/proxies/default.xml` : `src/C${i}.java`;
      const base = gw ? `/r${r}/p${i % 10}/1.0` : "";
      const path = `${base}/res${i}/{id}`;
      facts.push({
        ...common,
        kind: "entry",
        id: `entry.get.e${i}`,
        repo,
        entryType: "rest",
        method: "GET",
        path,
        handler: `p${i % 10}/H${i}`,
        cite: {
          file,
          line: 1,
          value: path,
          quote: "q",
          ...(gw ? { with: [{ file, line: 2, value: base }] } : {}),
        },
      } as Fact);
      facts.push({
        ...common,
        kind: "call",
        id: `call.get.c${i}`,
        repo,
        callType: "rest",
        method: "GET",
        path: `/r${(r + 1) % gateways}/p${((i * 7) % nEach) % 10}/1.0/res${(i * 7) % nEach}/{x}`,
        base: "${FORGE_GW_URL}",
        cite: { file: `src/K${i}.java`, line: 1, value: "x", quote: "x" },
      } as Fact);
      facts.push({
        ...common,
        kind: "config",
        id: `config.k${i}`,
        repo,
        settingKind: "config",
        key: `forge.k${i}`,
        value: `v${i}`,
        cite: { file: "application.yml", line: i + 1, value: `k${i}`, quote: "q" },
      } as Fact);
    }
    repos.push({
      repo,
      facts,
      component: repo,
      ...(gw
        ? { gateway: true, hosts: ["gw.forge.example"] }
        : { hosts: [`${repo}.forge.internal`] }),
    });
  }
  return repos;
};

describe("the join at an estate's size", () => {
  it.skipIf(process.platform === "win32")(
    "joins 40 repos of 250 entries and calls in under 10 seconds",
    () => {
      const repos = syntheticEstate(40, 250);
      const t = Date.now();
      const out = joinFacts({ repos });
      const ms = Date.now() - t;
      // Every service's call reaches a proxy's flow by its BasePath; a gateway repo's own calls,
      // forwarding to a host nothing resolves, are asked about.
      expect(out.joins.length).toBe(32 * 250);
      expect(out.joins.every((j) => j.how === "base-path")).toBe(true);
      expect(out.asks.length).toBe(8 * 250);
      expect(ms).toBeLessThan(10_000);
    },
    120_000,
  );
});
