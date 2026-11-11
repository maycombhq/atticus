import { useEffect, useRef } from "react";

/** What popupFocus needs of the popup's heading and of what had focus before (tests pass their own). */
export interface Focusable {
  focus(o?: FocusOptions): void;
  scrollIntoView?(o?: ScrollIntoViewOptions): void;
  isConnected?: boolean;
}

/**
 * A popup in the map's details panel (Connect to…, Owner and system, Declare a link…, Add to
 * the picture…) opens below what the panel shows already: it is brought into view and its
 * heading takes focus, so a line dropped on a box shows what it opened. The function it gives
 * back puts focus back where it was, if that is still on the page, when the popup closes.
 */
export function popupFocus(heading: Focusable | null, before: Focusable | null): () => void {
  heading?.scrollIntoView?.({ block: "nearest" });
  heading?.focus({ preventScroll: true });
  return () => {
    if (before && before.isConnected !== false) before.focus({ preventScroll: true });
  };
}

/** The heading's ref for popupFocus, with what had focus when the popup opened. */
export function usePopupFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    // Duck-typed, not instanceof HTMLElement: a test's stand-in document has no DOM classes.
    const a = typeof document === "undefined" ? null : (document.activeElement as Focusable | null);
    const before = a && typeof a.focus === "function" && a !== document.body ? a : null;
    return popupFocus(ref.current, before);
  }, []);
  return ref;
}
