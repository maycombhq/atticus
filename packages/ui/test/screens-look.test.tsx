import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { COPY } from "../src/copy.js";
import {
  focusInPlace,
  QuestionDetail,
  Questions,
  type QuestionView,
} from "../src/screens/Questions.js";
import { LOOKS, SCREEN_COMPONENTS, withLook, type Screen } from "../src/screens/registry.js";

/**
 * Beta.26 (the IDE look for Questions, Knowledge and Set up): a question's options are one
 * column, each radio with its words beside it; an answer given stays short, its form folded
 * under Change the answer; opening a question moves the focus without moving the page; and the
 * Knowledge and Set up pages take their look's wrapper. On the invented Forge estate.
 */

const C = COPY.questions;
const html = (el: ReactElement) => renderToStaticMarkup(el);

const open: QuestionView = {
  schemaVersion: 6,
  id: "q-0123456789ab",
  askedBy: {
    step: "change-feature",
    command: "atticus change feature add-transfer-limit",
    at: "2026-11-10T12:00:00.000Z",
  },
  repo: "add-transfer-limit",
  question: "What happens when the account has too little money on the day?",
  options: [
    { label: "Reject the transfer", means: "It fails at once", changes: "The brief says so" },
    { label: "Hold it a day", means: "It waits", changes: "The brief adds a held state" },
  ],
  evidence: ["openspec/changes/add-transfer-limit/proposal.md:1"],
  scope: { level: "repo", id: "add-transfer-limit" },
  state: "open",
  rerun: "atticus change feature add-transfer-limit",
};

const answered: QuestionView = {
  ...open,
  state: "answered",
  answer: {
    option: 2,
    by: "priya",
    at: "2026-11-10T13:00:00.000Z",
    scope: { level: "repo", id: "add-transfer-limit" },
  },
};

describe("a question's card (beta.26)", () => {
  it("lists the options in one column, each radio with its label right beside it", () => {
    const out = html(<QuestionDetail question={open} onAnswered={() => undefined} />);
    // The question is the card's heading, in its own words.
    expect(out).toContain(`<h2 class="qs-q">${open.question}</h2>`);
    const opts = out.match(
      /<div class="qs-opt"><input[^>]*type="radio"[^>]*\/><label for="[^"]+"/g,
    );
    // Two options and Your own words, each a radio then its label.
    expect(opts).toHaveLength(3);
    for (const o of opts!) {
      const id = /id="([^"]+)"/.exec(o)![1];
      expect(o).toContain(`<label for="${id}"`);
    }
    // The form is not folded while the question is open; Save is at its foot.
    expect(out).not.toContain('class="qs-change"');
    expect(out).toMatch(/<div class="qs-actions">.*Save the answer<\/button><\/div><\/form>/);
  });

  it("keeps an answer given short: the form folds under Change the answer", () => {
    const out = html(<QuestionDetail question={answered} onAnswered={() => undefined} />);
    expect(out).toContain('class="qs-answered"');
    expect(out).toContain(`<details class="qs-change"><summary>${C.change}</summary><form`);
    // Inside the fold the options are "Your answer", the one given still picked.
    expect(out).toContain(`<legend>${C.options}</legend>`);
    expect(out).toMatch(
      /id="q-q-0123456789ab-o2"[^>]*checked=""|checked=""[^>]*id="q-q-0123456789ab-o2"/,
    );
  });
});

describe("opening a question keeps the page where it is (beta.26)", () => {
  it("focuses without scrolling, and its side of the page shows it from the top", () => {
    const pane = { scrollTop: 240 };
    const el = { focus: vi.fn(), closest: vi.fn(() => pane) };
    focusInPlace(el);
    expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(el.closest).toHaveBeenCalledWith(".qs-pane");
    expect(pane.scrollTop).toBe(0);
  });

  it("does nothing without an element, and needs no pane", () => {
    expect(() => focusInPlace(null)).not.toThrow();
    const el = { focus: vi.fn(), closest: () => null };
    focusInPlace(el);
    expect(el.focus).toHaveBeenCalledOnce();
  });
});

describe("each section's look (beta.26)", () => {
  it("wraps Knowledge's pages in .kn and Set up's in .st; the others keep their own", () => {
    expect(LOOKS.knowledge).toBe("kn");
    expect(LOOKS["wiki-search"]).toBe("kn");
    expect(LOOKS.explore).toBe("kn");
    expect(LOOKS.settings).toBe("st");
    expect(LOOKS.repos).toBe("st");
    expect(LOOKS.ai).toBe("st");
    expect(LOOKS.questions).toBeUndefined();
    expect(LOOKS.home).toBeUndefined();
    expect(SCREEN_COMPONENTS.questions).toBe(Questions);
    expect(SCREEN_COMPONENTS.knowledge).not.toBeUndefined();
  });

  it("puts the page inside its look's wrapper, the page unchanged", () => {
    const Page: Screen = ({ hash }) => <p>{hash}</p>;
    const W = withLook("kn", Page);
    expect(html(<W hash="#/knowledge" />)).toBe('<div class="kn"><p>#/knowledge</p></div>');
    expect(W.displayName).toBe("kn(Page)");
  });
});
