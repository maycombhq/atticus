import { describe, expect, it } from "vitest";
import { definedInitialisms, initialismBook } from "../src/index.js";

// beta.28.3: an acronym and the words it stands for are one name, taken only from where a page
// defines it. A task that says "single sign-on" needs the page that only says "SSO"; a question
// about "the EDW" needs the page that only writes "enterprise data warehouse".

describe("definedInitialisms", () => {
  it("reads words (ACR), whatever the words' case, hyphens as spaces, only the words that spell it", () => {
    expect(
      definedInitialisms(
        "Every Forge service signs users in through single sign-on (SSO) and sends its rows to the Enterprise Data Warehouse (EDW).",
      ),
    ).toEqual([
      { acronym: "SSO", phrase: "single sign on" },
      { acronym: "EDW", phrase: "enterprise data warehouse" },
    ]);
  });

  it("reads ACR (words), and a joining word that gives a letter or none", () => {
    expect(
      definedInitialisms("The POS (point of sale) and the RPO (recovery point objective)."),
    ).toEqual([
      { acronym: "POS", phrase: "point of sale" },
      { acronym: "RPO", phrase: "recovery point objective" },
    ]);
    expect(definedInitialisms("Terminals at the point of sale terminal (PST) queue.")).toEqual([
      { acronym: "PST", phrase: "point of sale terminal" },
    ]);
    expect(definedInitialisms("EDW (the Enterprise Data Warehouse) is loaded nightly.")).toEqual([
      { acronym: "EDW", phrase: "enterprise data warehouse" },
    ]);
    // Two letters are too few: "you and I (UI)" and "is" are everywhere.
    expect(definedInitialisms("The user interface (UI) and information security (IS).")).toEqual(
      [],
    );
  });

  it("reads a line of an abbreviations list: a colon, a dash, a table row, bold", () => {
    expect(
      definedInitialisms(
        [
          "- CAB: Change Advisory Board, which meets on Tuesdays",
          "* **EDW** – Enterprise Data Warehouse",
          "| SSO | single sign-on | Forge Identity |",
          "RTO = recovery time objective",
        ].join("\n"),
      ),
    ).toEqual([
      { acronym: "CAB", phrase: "change advisory board" },
      { acronym: "EDW", phrase: "enterprise data warehouse" },
      { acronym: "SSO", phrase: "single sign on" },
      { acronym: "RTO", phrase: "recovery time objective" },
    ]);
  });

  it("takes nothing whose letters the words don't spell, and nothing from prose that only happens to", () => {
    expect(
      definedInitialisms("The gateway (API) is slow. See the note (TODO). HTTP: a protocol."),
    ).toEqual([]);
    // Chance runs of words are never a definition: no page sets them beside the acronym.
    expect(
      definedInitialisms(
        "A step still open is listed. The approval process is slow. SSO and the API are down.",
      ),
    ).toEqual([]);
    expect(definedInitialisms("CSV - comma separated values\nUTC: the time zone")).toEqual([
      { acronym: "CSV", phrase: "comma separated values" },
    ]);
  });

  it("stays quick on a very long line and on many joining words", () => {
    const t = Date.now();
    definedInitialisms(`${"of the and ".repeat(5000)}(OTA)`);
    definedInitialisms(`AAAAAZ: apple ${"a ".repeat(400)}`);
    definedInitialisms(`apple ${"a ".repeat(400)}(AAAAAZ)`);
    for (let i = 0; i < 200; i++) definedInitialisms(`apple ${"a ".repeat(12)}(AAAAAZ)`);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("initialismBook", () => {
  const book = initialismBook([
    ...definedInitialisms("single sign-on (SSO)\nEDW: Enterprise Data Warehouse"),
    { acronym: "EDW", phrase: "Enterprise  Data-Warehouse" },
  ]);

  it("keeps each definition once, sorted", () => {
    expect(book.entries()).toEqual([
      { acronym: "EDW", phrase: "enterprise data warehouse" },
      { acronym: "SSO", phrase: "single sign on" },
    ]);
  });

  it("links a text that writes the acronym to one that writes only its words, either way round", () => {
    expect(
      book.links(
        "OrderController.place takes the order only from a shopper signed in through single sign-on",
        "Send a user who isn't logged in to the SSO login page of Forge Identity.",
      ),
    ).toEqual([{ acronym: "SSO", phrase: "single sign on", acronymIn: "b" }]);
    expect(
      book.links(
        "everything about any app publishing data to the EDW",
        "The Enterprise Data\nWarehouse takes a nightly load.",
      ),
    ).toEqual([{ acronym: "EDW", phrase: "enterprise data warehouse", acronymIn: "a" }]);
  });

  it("gives nothing when both write the acronym, when neither side writes the other form, or for an acronym nothing defines", () => {
    expect(book.links("SSO login", "the SSO page, single sign-on")).toEqual([]);
    expect(book.links("SSO login", "a shopper's order history")).toEqual([]);
    expect(book.links("a step still open", "SSO login")).toEqual([]);
    expect(book.links("the CAB approves", "change advisory board")).toEqual([]);
    // A word in small letters is not the acronym.
    expect(book.links("the sso page", "single sign-on")).toEqual([]);
    expect(initialismBook([]).links("SSO", "single sign-on")).toEqual([]);
  });

  it("leaves out an acronym that is an ordinary word in capitals, however a page defines it", () => {
    const ordinary = initialismBook(
      definedInitialisms(
        [
          "POST: place order status tracking",
          "The point of sale terminal (POST) is replaced every five years.",
          "ADD (attention deficit disorder)",
          "NOTE: nothing ordinary to expect",
          "GET - gets every thing",
          "TODO: take over deployment of orders",
        ].join("\n"),
      ),
    );
    expect(ordinary.entries()).toEqual([]);
    expect(
      ordinary.links(
        "Add POST /orders/{id}/cancel to the gateway",
        "The point of sale terminal is replaced every five years.",
      ),
    ).toEqual([]);
  });

  it("reads an acronym only as a word of its own, and a phrase only within one sentence", () => {
    expect(book.links("MAX_SSO_RETRIES and SSO_ENABLED", "single sign-on")).toEqual([]);
    expect(book.links("the SSO page", "Stay single. Sign on to the portal.")).toEqual([]);
    expect(book.links("the SSOs we run", "every single sign-on, each day")).toHaveLength(1);
  });

  it("looks at the second text only for the names the first writes, however large the book", () => {
    const big = initialismBook([
      ...Array.from({ length: 3000 }, (_, i) => ({
        acronym: `Q${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (((i / 26) | 0) % 26))}${String.fromCharCode(65 + ((i / 676) | 0))}`,
        phrase: `quiet alpha ${i} bravo`,
      })),
      { acronym: "EDW", phrase: "enterprise data warehouse" },
    ]);
    const section = "The enterprise data warehouse takes a nightly load. ".repeat(40);
    const t = Date.now();
    for (let i = 0; i < 2000; i++) big.links("Who owns the EDW load?", `${section}${i}`);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(big.links("Who owns the EDW load?", section)).toHaveLength(1);
  });
});
