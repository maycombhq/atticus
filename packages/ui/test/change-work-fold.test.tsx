import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * beta.26 review: an explanation's More, pressed, opens its words whole and says so
 * (aria-expanded), and Less folds them again. Rendered with the tiny hooks runtime, no DOM.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { COPY } = await import("../src/copy.js");
const { Explain } = await import("../src/screens/work/cw.js");
const W = COPY.changeWork;

const long = "Everything about this stage in one place, in order. ".repeat(4);
const els = (t: unknown) => all(t);
const button = (t: unknown) => els(t).find((e) => e.type === "button")!;
const box = (t: unknown) => els(t).find((e) => e.type === "div")!;

describe("an explanation's More", () => {
  it("flips aria-expanded and shows the full words when pressed, then folds them on Less", () => {
    const m = mount(Explain, { text: long, about: "This stage" });
    expect(box(m.tree).props.className).toBe("cw-explain cut");
    expect(button(m.tree).props["aria-expanded"]).toBe(false);
    expect(text(button(m.tree).props.children)).toBe(W.more);
    expect(button(m.tree).props["aria-label"]).toBe(W.moreAbout("This stage"));

    (button(m.tree).props.onClick as () => void)();
    m.render();
    expect(button(m.tree).props["aria-expanded"]).toBe(true);
    // Not cut any more: the words are shown whole.
    expect(box(m.tree).props.className).toBe("cw-explain");
    expect(text(m.tree)).toContain(long);
    expect(text(button(m.tree).props.children)).toBe(W.less);
    expect(button(m.tree).props["aria-label"]).toBe(W.lessAbout("This stage"));

    (button(m.tree).props.onClick as () => void)();
    m.render();
    expect(button(m.tree).props["aria-expanded"]).toBe(false);
    expect(box(m.tree).props.className).toBe("cw-explain cut");
  });
});
