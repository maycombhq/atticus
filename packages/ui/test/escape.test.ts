import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { escapeCloses } from "../src/app/ui.js";

/** A key press as React hands it to onKeyDown, with what the handler did to it. */
function press(key: string, o: { composing?: boolean; prevented?: boolean } = {}) {
  const seen = { prevented: !!o.prevented, stopped: false };
  const e = {
    key,
    nativeEvent: { isComposing: !!o.composing },
    get defaultPrevented() {
      return seen.prevented;
    },
    preventDefault: () => (seen.prevented = true),
    stopPropagation: () => (seen.stopped = true),
  } as unknown as KeyboardEvent<HTMLElement>;
  return { e, seen };
}

describe("Escape on an inline form", () => {
  it("closes the form as Cancel does, and goes no further", () => {
    let closed = 0;
    const { e, seen } = press("Escape");
    escapeCloses(() => closed++)(e);
    expect(closed).toBe(1);
    // Nothing behind the form (the tour, the palette) closes on the same key.
    expect(seen).toEqual({ prevented: true, stopped: true });
  });

  it("leaves every other key to the form", () => {
    let closed = 0;
    for (const key of ["Enter", "Tab", "a", " ", "Esc!"]) {
      const { e, seen } = press(key);
      escapeCloses(() => closed++)(e);
      expect(seen).toEqual({ prevented: false, stopped: false });
    }
    expect(closed).toBe(0);
  });

  it("doesn't close while an input method is composing text, or once a box inside handled it", () => {
    let closed = 0;
    escapeCloses(() => closed++)(press("Escape", { composing: true }).e);
    escapeCloses(() => closed++)(press("Escape", { prevented: true }).e);
    expect(closed).toBe(0);
  });
});
