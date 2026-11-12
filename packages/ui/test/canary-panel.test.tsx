import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { CanaryPanel, TrustPage } from "../src/screens/map/Trust.js";

/**
 * Map › Trust's canaries (ADR 0196, Z2): every state of the panel, and the two numbers (the audit
 * misread rate and the canary pass-through rate) side by side, never pooled, named as the CLI
 * names them.
 */

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
  rates: {
    misread: rate(0, 0),
    passed: rate(0, 0),
    recall: rate(0, 0),
    fabrication: rate(0, 0),
    caught: 0,
    elsewhere: 0,
    repos: { audited: 0, canaries: 0 },
    covers: [],
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
      covers: [{ stack: "spring", what: ["entry", "call", "config"] }],
      skipped: [
        { stack: "spring", what: "topic-in", reason: "no Kafka client" },
        { stack: "spring", what: "topic-out", reason: "no Kafka client" },
      ],
      unread: 0,
      planted: { n: 3, found: 2, rejected: 0, missed: 1 },
      removed: { n: 3, absent: 1, kept: 1, rejected: 1, elsewhere: 0 },
      recall: rate(2, 3, 0.208, 0.939),
      fabrication: rate(2, 3, 0.208, 0.939),
      passed: rate(1, 3, 0.061, 0.792),
    },
  ],
  pending: [{ repo: "forge-portal-ui", at: "2026-11-11T11:00:00.000Z", seed: "s1" }],
  rates: {
    misread: rate(1, 9, 0.02, 0.435),
    passed: rate(1, 3, 0.061, 0.792),
    recall: rate(2, 3, 0.208, 0.939),
    fabrication: rate(2, 3, 0.208, 0.939),
    caught: 1,
    elsewhere: 0,
    repos: { audited: 1, canaries: 1 },
    covers: [{ stack: "spring", what: ["entry", "call", "config"] }],
  },
};
const ready = (data: Api.CanaryViewT) => ({ state: "ready" as const, data });

describe("CanaryPanel", () => {
  it("gives the two numbers side by side, each with its range, what they cover, a row per repo, and what waits", () => {
    const html = renderToStaticMarkup(<CanaryPanel of={ready(ONE)} />);
    expect(html).toContain(esc(K.title));
    // named as `atticus canary report` names them
    expect(K.misread(1)).toBe(
      "Audit misread rate (real lines read wrongly, of the sample audit's answers; 1 repo)",
    );
    expect(K.passed(1)).toBe(
      "Canary pass-through rate (lines taken out, still claimed and kept by the verifier, of those taken out; 1 repo)",
    );
    expect(html).toContain(`${esc(K.misread(1))}:</strong> 11.1% (1 of 9)`);
    expect(html).toContain(`${esc(K.passed(1))}:</strong> 33.3% (1 of 3)`);
    expect(html).toContain(esc(K.range(0.02, 0.435)));
    expect(html).toContain(esc(K.range(0.061, 0.792)));
    // never pooled, and never twice
    expect(html).not.toMatch(/Silent error rate:|of 12|of 13/);
    expect(html.split("33.3% (1 of 3)").length - 1).toBe(1);
    expect(html).toContain(esc(K.covers("spring (a route, a call, a config key)")));
    expect(html).toContain(esc(K.recall({ k: 2, n: 3 })));
    expect(html).toContain(esc(K.fabrication({ k: 2, n: 3 }, 1, 0)));
    expect(html).toContain(esc(K.small));
    expect(html).toContain(`<caption class="sr">${esc(K.caption)}</caption>`);
    expect(html).toContain(esc(K.skipped(2)));
    expect(html).toContain("reports/canaries/2026-11-11-forge-portal-bff.yaml");
    expect(html).toContain(esc(K.pending("forge-portal-ui")));
    expect(html).toContain("atticus canary score forge-portal-ui");
  });

  it("gives the warning sign a text alternative", () => {
    const html = renderToStaticMarkup(<CanaryPanel of={ready(ONE)} />);
    expect(html).toContain(`<span role="img" aria-label="${esc(K.passedWarn)}"`);
    expect(html).not.toMatch(/aria-hidden="true">⚠/);
  });

  it("with the audit only, names its number as the CLI does and says no canary covers anything", () => {
    const audit: Api.CanaryViewT = {
      ...NONE,
      rates: {
        ...NONE.rates,
        misread: rate(1, 9, 0.02, 0.435),
        repos: { audited: 1, canaries: 0 },
      },
    };
    const html = renderToStaticMarkup(<CanaryPanel of={ready(audit)} />);
    expect(html).toContain(`${esc(K.misread(1))}:</strong> 11.1% (1 of 9)`);
    expect(html).toContain(`${esc(K.passed(0))}:</strong> not measured`);
    expect(html).toContain(esc(K.coversNone));
    expect(html).not.toContain(esc(K.recall({ k: 0, n: 0 })));
  });

  it("with nothing scored, says how to run one", () => {
    const html = renderToStaticMarkup(<CanaryPanel of={ready(NONE)} />);
    expect(html).toContain(esc(K.empty));
    expect(html).toContain("atticus canary plant &lt;repo&gt;");
    expect(html).toContain("atticus canary score &lt;repo&gt;");
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
