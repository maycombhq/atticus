import { useEffect, useRef, useState, type KeyboardEvent as KeyEvent } from "react";
import { COPY } from "../copy.js";

const T = COPY.tour;

/**
 * First-run tour: a few steps through Home (one page), the six entries, asking, Change's tabs
 * (All changes first) and the hand-off PR. It points only at the menu's six (`link`), never at a
 * page behind --full. It is the same for everyone (there are no roles, ADR 0073), opens once per
 * browser, can be skipped, and replays from Help.
 */

interface Step {
  title: string;
  body: string;
  /** A CSS selector for what the step points at. */
  target?: string;
}

const link = (screen: string) => `.nav a[href="#/${screen}"]`;

export const TOUR: Step[] = [
  {
    ...T.steps.home,
    target: link("home"),
  },
  {
    ...T.steps.ask,
    target: ".ask-form",
  },
  {
    ...T.steps.change,
    target: link("changes"),
  },
  {
    ...T.steps.assistant,
  },
  {
    ...T.steps.approve,
    target: link("changes"),
  },
];

const KEY = "atticus.tour.done";
const seen = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Storage blocked: the tour simply shows again next time.
  }
};

/** Ask the tour to open again (the Help menu does this). */
export const replayTour = () => dispatchEvent(new Event("atticus:tour"));

export function Tour() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    // Not on its own inside an editor's tab (ADR 0091): Help still starts it there.
    if (!seen() && window.self === window.top) {
      setI(0);
      setOpen(true);
    }
  }, []);
  useEffect(() => {
    const on = () => {
      setI(0);
      setOpen(true);
    };
    addEventListener("atticus:tour", on);
    return () => removeEventListener("atticus:tour", on);
  }, []);

  const step = TOUR[i];
  useEffect(() => {
    if (!open || !step?.target) return;
    const el = document.querySelector(step.target);
    el?.classList.add("tour-target");
    return () => el?.classList.remove("tour-target");
  }, [open, step]);

  // Esc closes the tour from anywhere, as it closes the palette.
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      remember();
      setOpen(false);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [open]);

  // WP5.3: the tour takes focus when it opens, keeps Tab inside it, and gives focus back on close.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    return () => back?.focus?.();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>(".btn.primary")?.focus();
  }, [open, i]);
  const trap = (e: KeyEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const all = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = e.shiftKey
      ? at <= 0
        ? all.length - 1
        : at - 1
      : at === all.length - 1
        ? 0
        : at + 1;
    all[to]!.focus();
    e.preventDefault();
  };

  if (!open || !step) return null;
  const close = () => {
    remember();
    setOpen(false);
  };
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      className="tour panel hero"
      onKeyDown={trap}
    >
      <div className="hud" style={{ fontSize: 10 }}>
        {T.tourOf(i + 1, TOUR.length, COPY.app.tourEscape)}
      </div>
      <h2 id="tour-title" className="h" style={{ margin: "6px 0" }}>
        {step.title}
      </h2>
      <p style={{ margin: "0 0 12px", lineHeight: 1.55, fontSize: 13 }}>{step.body}</p>
      <div className="row between">
        <button type="button" className="btn" onClick={close}>
          {T.skipTheTour}
        </button>
        <div className="row" style={{ gap: 6 }}>
          {i > 0 && (
            <button type="button" className="btn" onClick={() => setI(i - 1)}>
              {T.back}
            </button>
          )}
          {i < TOUR.length - 1 ? (
            <button type="button" className="btn primary" onClick={() => setI(i + 1)}>
              {T.next}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={close}>
              {T.done}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
