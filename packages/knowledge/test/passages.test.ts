import { describe, expect, it } from "vitest";
import {
  knowledgeAnswer,
  pageSections,
  rankPassages,
  sectionOf,
  type PassagePage,
} from "../src/index.js";

/** ADR 0189: what the wikis and inputs/ files say to a question, and a section opened in place. */

const firewall: PassagePage = {
  source: "inputs",
  page: "wiki/snow-firewall-request.md",
  path: "inputs/wiki/snow-firewall-request.md",
  text: [
    "# Firewall rules",
    "",
    "Northwind Pay's network team owns the firewall.",
    "",
    "## Requesting a firewall rule",
    "",
    "Raise a Network Access request in the service desk with the source, the destination and the port.",
    "It takes three working days.",
    "",
    "```",
    "# not a heading",
    "```",
    "",
    "## Removing a rule",
    "",
    "Close the request with the rule's id.",
  ].join("\n"),
};
const retries: PassagePage = {
  source: "eng-wiki",
  page: "standards/retries.md",
  path: "knowledge/snapshots/eng-wiki/2026-11-01/standards/retries.md",
  text: "# Retry standard\n\nRetry a call three times with backoff.\n",
};

describe("a page's sections", () => {
  it("are its headings with the text under each, a fenced line no heading", () => {
    const s = pageSections(firewall);
    expect(s.map((x) => x.heading)).toEqual([
      "Firewall rules",
      "Firewall rules › Requesting a firewall rule",
      "Firewall rules › Removing a rule",
    ]);
    expect(s[1]!.line).toBe(5);
    expect(s[1]!.text).toContain("Network Access request");
    expect(s[1]!.text).toContain("# not a heading");
  });

  it("is found by the id a change's knowledge gives it: its heading, its path or a slug", () => {
    const pages = [firewall, retries];
    expect(
      sectionOf(pages, "inputs/wiki/snow-firewall-request.md#Requesting a firewall rule")?.line,
    ).toBe(5);
    expect(
      sectionOf(pages, "inputs/wiki/snow-firewall-request.md#requesting-a-firewall-rule")?.line,
    ).toBe(5);
    expect(
      sectionOf(pages, "inputs/wiki/snow-firewall-request.md#Firewall rules › Removing a rule")
        ?.text,
    ).toContain("Close the request");
    expect(sectionOf(pages, "eng-wiki/standards/retries.md")?.heading).toBe("Retry standard");
    expect(sectionOf(pages, "eng-wiki/nope.md#x")).toBeUndefined();
  });
});

describe("answering from knowledge", () => {
  it("finds the passage that says how to request a firewall rule, with where it is", () => {
    const [top] = rankPassages("How do I request a firewall rule for a new service?", [
      retries,
      firewall,
    ]);
    expect(top).toMatchObject({
      source: "inputs",
      page: "wiki/snow-firewall-request.md",
      heading: "Firewall rules › Requesting a firewall rule",
      line: 5,
    });
  });

  it("finds nothing for words no page has", () => {
    expect(rankPassages("quarterly bonus payout dates", [firewall, retries])).toEqual([]);
    expect(
      knowledgeAnswer("quarterly bonus payout dates", { items: [], pages: [firewall] }),
    ).toEqual({
      items: [],
      passages: [],
    });
  });
});
