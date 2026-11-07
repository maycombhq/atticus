import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { contractGaps, findingsOfJoin } from "../src/app/contracts.js";
import { screenOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";
import { ContractFindings, WhyLinked } from "../src/screens/architecture/WhyLinked.js";
import { withContractGaps } from "../src/screens/architecture/model.js";
import { MismatchesPanels } from "../src/screens/map/Mismatches.js";
import { OutsideSystemPanels } from "../src/screens/map/Outside.js";
import { TrustPage } from "../src/screens/map/Trust.js";

/**
 * Map › Mismatches and the contract check's marks (plan item F7, ADR 0164): the estate-wide
 * page, the warning on a link and in Why is this linked?, the count on the Trust tab, and an
 * outside system's calls against its newest spec. The invented Forge estate.
 */

const M = COPY.mismatches;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

const call = {
  repo: "forge-portal-bff",
  fact: "call.get.forge-accounts-v1-accounts-id",
  component: "portal-bff",
  at: "src/main/java/forge/portal/AccountsClient.java:16",
};
const entry = {
  repo: "forge-accounts",
  fact: "entry.get.accounts-id",
  component: "accounts-api",
  at: "src/main/java/forge/accounts/AccountsController.java:19",
};
const KEY = "if-1|forge-portal-bff|call.get.forge-accounts-v1-accounts-id";
const finding = (n: number, status: "mismatch" | "unconfirmed", field: string) =>
  Api.ContractMismatchView.parse({
    id: `${KEY}#${n}:field-missing:response:${field}`,
    interface: "if-1",
    interfaces: ["if-1", "if-2"],
    call,
    entry,
    status,
    kind: "field-missing",
    side: "response",
    field,
    sender: {
      repo: "forge-proxy-accounts-v1",
      what: "forge-proxy-accounts-v1's spec",
      at: "openapi/forge-accounts-v1.yaml:36",
    },
    receiver: { repo: "forge-accounts", what: "forge-accounts's entry" },
    ...(status === "unconfirmed"
      ? { untraced: "forge-proxy-accounts-v1 apiproxy/resources/jsc/overdraft.js:3" }
      : {}),
    message: `the spec reads the response field ${field}, which forge-accounts's entry never returns`,
  });
const VIEW = Api.ContractsView.parse({
  links: [
    {
      key: KEY,
      interface: "if-1",
      call,
      entry,
      kind: "rest",
      method: "GET",
      path: "/accounts/{id}",
      through: ["forge-proxy-accounts-v1"],
      specs: ["forge-proxy-accounts-v1 openapi/forge-accounts-v1.yaml:9"],
      compared: 2,
      mismatches: 1,
      unconfirmed: 1,
    },
  ],
  findings: [
    finding(1, "mismatch", "data.currency"),
    finding(1, "unconfirmed", "data.overdraftLimit"),
  ],
  counts: { links: 3, compared: 1, mismatches: 1, unconfirmed: 1 },
  notes: ["forge-cards: some of its facts aren't verified yet"],
});

const join = (iface: string): Api.HierJoinT => ({
  interface: iface,
  from: "proxy-accounts-v1",
  to: "accounts-api",
  how: "host",
  gateway: false,
  verified: true,
  method: "GET",
  path: "/accounts/{id}",
  caller: [
    { source: "code", repo: "forge-proxy-accounts-v1", at: "apiproxy/proxies/default.xml:4" },
  ],
  callee: [],
  hops: [],
  other: [],
});

describe("Map › Mismatches", () => {
  it("is a page of Map, found by Ctrl+K and linked from Trust", () => {
    expect(screenOf("mismatches")).toMatchObject({ section: "Map", aside: true });
    expect(SCREEN_COMPONENTS.mismatches).toBeDefined();
  });

  it("lists each link with its findings, both ends and their lines, and the command", () => {
    const out = html(<MismatchesPanels view={VIEW} />);
    expect(out).toContain(esc(M.counts(1, 1, 3, 1)));
    expect(out).toContain(
      esc(
        M.link(
          "forge-portal-bff",
          "GET /accounts/{id}",
          "forge-accounts",
          "forge-proxy-accounts-v1",
        ),
      ),
    );
    expect(out).toContain(esc(VIEW.findings[0]!.message));
    expect(out).toContain(M.status.unconfirmed);
    expect(out).toContain("openapi/forge-accounts-v1.yaml:36");
    expect(out).toContain(M.command);
    // A table with a caption and column headers, for a screen reader.
    expect(out).toMatch(/<caption class="sr">/);
    expect(out).toContain('scope="col"');
    expect(out).toContain(M.notes);
  });
});

describe("the warning on a link and in Why is this linked?", () => {
  it("says so when every link compared matches", () => {
    const out = html(<MismatchesPanels view={{ ...VIEW, findings: [] }} />);
    expect(out).toContain(esc(M.noneAtAll));
  });

  it("finds a call's findings by its Interface, or a hop's forwarding call's", () => {
    expect(findingsOfJoin(join("if-2"), VIEW.findings)).toHaveLength(2);
    expect(findingsOfJoin(join("if-9"), VIEW.findings)).toEqual([]);
    expect(contractGaps([join("if-1")], VIEW.findings)).toEqual([
      "contract-mismatch",
      "contract-unconfirmed",
    ]);
  });

  it("finds a listener's findings against an outside publisher's spec, by the listener's line", () => {
    // forge-reports-py listens on a topic Tidewater (an invented outside system) publishes: the
    // finding names no Interface, and the link's listener line is on its callee side.
    const listener = {
      repo: "forge-reports-py",
      fact: "entry.listen.ledger-posted",
      component: "reports",
      at: "reports/consumer.py:5",
    };
    const outside = Api.ContractMismatchView.parse({
      id: "tidewater|forge-reports-py|entry.listen.ledger-posted#0:field-missing:message:currency",
      call: listener,
      entry: listener,
      system: "tidewater",
      status: "mismatch",
      kind: "field-missing",
      side: "message",
      field: "currency",
      sender: { system: "tidewater", what: "tidewater's spec ledger_posted.avsc" },
      receiver: {
        repo: "forge-reports-py",
        what: "forge-reports-py's listener",
        at: "reports/consumer.py:9",
      },
      message:
        "forge-reports-py's listener reads the message field currency, which tidewater's spec never sends",
    });
    const topic: Api.HierJoinT = {
      ...join("if-tidewater-ledger-posted"),
      from: "tidewater",
      to: "reports",
      how: "topic",
      caller: [],
      callee: [{ source: "code", repo: "forge-reports-py", at: "reports/consumer.py:5" }],
    };
    expect(findingsOfJoin(topic, [outside, ...VIEW.findings])).toEqual([outside]);
    expect(contractGaps([topic], [outside])).toEqual(["contract-mismatch"]);
    // Another link of the same repo's lines doesn't take it.
    expect(findingsOfJoin(join("if-9"), [outside])).toEqual([]);
  });

  it("marks the link on the canvas as it marks every gap", () => {
    const edge: Api.HierEdgeT = {
      id: "e1",
      from: "a",
      to: "b",
      type: "calls",
      count: 1,
      state: "current",
      gaps: [],
      evidence: [],
      joins: [join("if-1")],
    };
    const views = new Map([["estate", { edges: [edge] } as unknown as Api.GraphNodeViewT]]);
    const out = withContractGaps(views, VIEW.findings);
    expect(out.get("estate")!.edges[0]!.gaps).toEqual([
      "contract-mismatch",
      "contract-unconfirmed",
    ]);
    expect(withContractGaps(views, [])).toBe(views);
  });

  it("says each call's findings under it, with the way to all of them", () => {
    const edge = {
      id: "e1",
      from: "a",
      to: "b",
      type: "calls",
      count: 1,
      state: "current",
      gaps: [],
      evidence: [],
      joins: [join("if-1")],
    } as Api.HierEdgeT;
    const out = html(<WhyLinked link={edge} contracts={VIEW.findings} />);
    expect(out).toContain(esc(COPY.why.contractsOf(1, 1)));
    expect(out).toContain(esc(VIEW.findings[1]!.message));
    expect(out).toContain('href="#/mismatches"');
    expect(html(<ContractFindings list={[]} />)).toBe("");
  });
});

describe("the count on the Trust tab and the outside system's calls against its spec", () => {
  it("counts the mismatches on the Trust tab, with the way to the page", () => {
    const out = html(
      <TrustPage
        of={{
          state: "ready",
          data: {
            factsDir: "facts",
            repos: [],
            problems: [{ file: "x", message: "y" }],
            contracts: { links: 3, compared: 1, mismatches: 1, unconfirmed: 1 },
          },
        }}
      />,
    );
    expect(out).toContain(esc(COPY.trust.contracts(1, 1, 1)));
    expect(out).toContain('href="#/mismatches"');
  });

  it("says what a newer spec brought on the outside system's page", () => {
    const sys = Api.OutsideSystemView.parse({
      id: "northwind-pay",
      name: "Northwind Pay",
      boundary: "vendor",
      aliases: [],
      callers: [],
      unmatched: [],
      ambiguous: [],
      questions: [],
      spec: { path: "inputs/partner-specs/northwind-v2.yaml", operations: [] },
      contracts: { findings: [VIEW.findings[0]], new: [VIEW.findings[0]!.id] },
    });
    const out = html(<OutsideSystemPanels system={sys} />);
    expect(out).toContain(COPY.outside.contracts);
    expect(out).toContain(COPY.outside.newWithSpec);
    const none = html(<OutsideSystemPanels system={{ ...sys, contracts: { findings: [] } }} />);
    expect(none).toContain(esc(COPY.outside.noContracts));
  });
});
