import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { CanaryPanel, TrustPage } from "../src/screens/map/Trust.js";

/** Map › Trust's canaries and silent error rate (ADR 0196, Z2): every state of the panel. */

const K = COPY.trust.canary;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const rate = (k: number, n: number, low: number | null = null, high: number | null = null) => ({
  k,
  n,
  rate: n ? k / n : null,
  low,
  high,
});
const NONE: Api.CanaryViewT = {
  reportsDir: "reports/canaries",
  latest: [],
  pending: [],
  silent: {
    silent: rate(0, 0),
    misread: rate(0, 0),
    recall: rate(0, 0),
    fabrication: rate(0, 0),
    passed: rate(0, 0),
    caught: 0,
    repos: { audited: 0, canaries: 0 },
  },
  commands: {
    plant: "atticus canary plant <repo>",
    score: "atticus canary score <repo>",
    report: "atticus canary report",
  },
  problems: [],
};
const ONE: Api.CanaryViewT = {
  ...NONE,
  latest: [
    {
      repo: "forge-portal-bff",
      path: "reports/canaries/2026-11-11-forge-portal-bff.yaml",
      at: "2026-11-11T10:00:00.000Z",
      by: "tom",
      seed: "s1",
      commit: "b0b0001",
      stacks: ["spring"],
      planted: { n: 5, found: 4, rejected: 0, missed: 1 },
      removed: { n: 3, absent: 0, kept: 1, rejected: 2 },
      recall: rate(4, 5, 0.376, 0.964),
      fabrication: rate(3, 3, 0.438, 1),
      passed: rate(1, 3, 0.061, 0.792),
    },
  ],
  pending: [{ repo: "forge-portal-ui", at: "2026-11-11T11:00:00.000Z", seed: "s1" }],
  silent: {
    silent: rate(2, 14, 0.04, 0.399),
    misread: rate(1, 9, 0.02, 0.435),
    recall: rate(4, 5, 0.376, 0.964),
    fabrication: rate(3, 3, 0.438, 1),
    passed: rate(1, 3, 0.061, 0.792),
    caught: 2,
    repos: { audited: 1, canaries: 1 },
  },
};
const ready = (data: Api.CanaryViewT) => ({ state: "ready" as const, data });

describe("CanaryPanel", () => {
  it("says the rate, its range and its parts, a row per repo, and what waits for a score", () => {
    const html = renderToStaticMarkup(<CanaryPanel of={ready(ONE)} />);
    expect(html).toContain(esc(K.title));
    expect(html).toContain(esc(K.silent({ k: 2, n: 14 })));
    expect(html).toContain("Silent error rate: 14.3% (2 of 14 claims graded as backed)");
    expect(html).toContain(esc(K.range(0.04, 0.399)));
    expect(html).toContain(esc(K.misread({ k: 1, n: 9 }, 1)));
    expect(html).toContain(esc(K.recall({ k: 4, n: 5 })));
    expect(html).toContain(esc(K.fabrication({ k: 3, n: 3 }, { k: 1 }, 2)));
    expect(html).toContain(esc(K.small));
    expect(html).toContain(`<caption class="sr">${esc(K.caption)}</caption>`);
    expect(html).toContain("reports/canaries/2026-11-11-forge-portal-bff.yaml");
    expect(html).toContain(esc(K.pending("forge-portal-ui")));
    expect(html).toContain("atticus canary score forge-portal-ui");
  });

  it("with nothing scored, says how to run one", () => {
    const html = renderToStaticMarkup(<CanaryPanel of={ready(NONE)} />);
    expect(html).toContain(esc(K.empty));
    expect(html).toContain("atticus canary plant &lt;repo&gt;");
    expect(html).toContain("atticus canary score &lt;repo&gt;");
    expect(html).toContain(esc(K.silent({ k: 0, n: 0 })));
  });

  it("loads and fails like every panel", () => {
    expect(renderToStaticMarkup(<CanaryPanel of={{ state: "loading" }} />)).toContain(
      'aria-busy="true"',
    );
    const err = renderToStaticMarkup(
      <CanaryPanel of={{ state: "error", error: "the server stopped" }} />,
    );
    expect(err).toContain('role="alert"');
    expect(err).toContain("the server stopped");
  });

  it("sits on the Trust page when it is given", () => {
    const html = renderToStaticMarkup(
      <TrustPage
        of={{ state: "ready", data: { factsDir: "facts", repos: [], problems: [] } }}
        canary={ready(ONE)}
      />,
    );
    expect(html).toContain(esc(K.title));
  });
});
