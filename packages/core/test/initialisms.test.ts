import { describe, expect, it } from "vitest";
import { acronymsIn, initialismLinks, spelledOut } from "../src/index.js";

// beta.28.3: an acronym and the words it stands for are the same name. A task that says "single
// sign-on" needs the page that only says "SSO"; a search for "EDW" needs the page that only
// writes "enterprise data warehouse". Read from the letters, no model and no glossary.

describe("acronymsIn", () => {
  it("finds the all-capital words of three to six letters, once each, plurals folded", () => {
    expect(acronymsIn("Put an endpoint behind SSO login. SSOs and the EDW, via HTTP2.")).toEqual([
      "SSO",
      "EDW",
      "HTTP2",
    ]);
  });

  it("leaves out two-letter words, ordinary words, identifiers and a shouted sentence", () => {
    expect(acronymsIn("An ID in the DB of orderId, and Sso or sso")).toEqual([]);
    expect(acronymsIn("DO NOT DEPLOY ON FRIDAY")).toEqual([]);
  });
});

describe("spelledOut", () => {
  it("finds the words an acronym stands for, whatever their case, hyphens as spaces", () => {
    expect(spelledOut("SSO", "a shopper signed in through single sign-on places it")).toBe(
      "single sign-on",
    );
    expect(spelledOut("EDW", "Publish to the Enterprise Data Warehouse nightly.")).toBe(
      "Enterprise Data Warehouse",
    );
  });

  it("lets a joining word between the words give a letter or none (point of sale: POS, PST)", () => {
    expect(spelledOut("POS", "every point of sale terminal")).toBe("point of sale");
    expect(spelledOut("PST", "every point of sale terminal")).toBe("point of sale terminal");
    expect(spelledOut("TPO", "the terminal's point of")).toBeUndefined();
    expect(spelledOut("RPO", "the recovery point objective is one hour")).toBe(
      "recovery point objective",
    );
  });

  it("never starts on a joining word, never crosses punctuation or a line, and needs whole words", () => {
    expect(spelledOut("SSO", "to sign in, single. Sign on")).toBeUndefined();
    expect(spelledOut("SSO", "single\nsign on")).toBeUndefined();
    expect(spelledOut("OTS", "on the shelf")).toBeUndefined();
    expect(spelledOut("EDW", "the EDW itself")).toBeUndefined();
  });

  it("is not fooled by a two-letter or seven-letter word", () => {
    expect(spelledOut("DB", "data base")).toBeUndefined();
    expect(spelledOut("ABCDEFG", "a b c d e f g")).toBeUndefined();
  });
});

describe("initialismLinks", () => {
  it("links an acronym on either side to its words on the other, in a fixed order", () => {
    expect(
      initialismLinks(
        "OrderController.place takes the order only from a shopper signed in through single sign-on",
        "Send a user who isn't logged in to the SSO login page of Forge Identity.",
      ),
    ).toEqual([{ acronym: "SSO", phrase: "single sign-on", acronymIn: "b" }]);
    expect(
      initialismLinks(
        "everything about any app publishing data to the EDW",
        "The enterprise data warehouse takes a nightly load.",
      ),
    ).toEqual([{ acronym: "EDW", phrase: "enterprise data warehouse", acronymIn: "a" }]);
  });

  it("gives nothing when both say the acronym (that is a word in common) or neither spells it", () => {
    expect(initialismLinks("SSO login", "the SSO page")).toEqual([]);
    expect(initialismLinks("SSO login", "a shopper's order history")).toEqual([]);
  });
});
