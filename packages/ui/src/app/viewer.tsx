import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { COPY } from "../copy.js";

/**
 * The diagram viewer every picture shares (F10): the picture takes the page's whole width and
 * the height left below it, opens fitted, zooms by wheel, pinch, buttons and keys, pans by drag
 * and arrows, finds a box by name, dims all but a box and its neighbours, and goes full screen
 * (a button, F, Esc to leave). Full screen is the frame filling the window, not the browser's
 * Fullscreen API, so it works the same in the VS Code and IntelliJ panels the app is embedded in
 * and follows the panel's size. The maths is here as pure functions, so tests need no DOM.
 */

const T = COPY.viewer;

/**
 * Beta.28 (the owner: "the panel is too cramped"): the details beside the picture can be made
 * wider, by a handle between them and the picture (dragged, or stepped with the arrow keys) or at
 * once by a button. Widths in px; the picture always keeps `keep` of the stage.
 */
export const ASIDE_WIDTH = { min: 280, step: 40, wide: 0.6, keep: 240 } as const;
const ASIDE_KEY = "atticus.detailsWidth";

/** The width a key gives the details (they are at the right: Left widens), or undefined. */
export function nextAsideWidth(w: number, key: string, max: number): number | undefined {
  const clamp = (x: number) =>
    Math.min(Math.max(x, ASIDE_WIDTH.min), Math.max(max, ASIDE_WIDTH.min));
  switch (key) {
    case "ArrowLeft":
      return clamp(w + ASIDE_WIDTH.step);
    case "ArrowRight":
      return clamp(w - ASIDE_WIDTH.step);
    case "Home":
      return clamp(ASIDE_WIDTH.min);
    case "End":
      return clamp(max);
    default:
      return undefined;
  }
}

/** The width this viewer last chose (a per-viewer convenience: none, or a bad one, is none). */
function savedAsideWidth(): number | undefined {
  try {
    const n = Number(globalThis.localStorage?.getItem(ASIDE_KEY));
    return Number.isFinite(n) && n >= ASIDE_WIDTH.min ? n : undefined;
  } catch {
    return undefined;
  }
}
function saveAsideWidth(n: number | undefined): void {
  try {
    if (n === undefined) globalThis.localStorage?.removeItem(ASIDE_KEY);
    else globalThis.localStorage?.setItem(ASIDE_KEY, String(Math.round(n)));
  } catch {
    // Storage blocked: the width lasts as long as the page.
  }
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far a picture zooms: out to a tenth, in to three times; each step is a quarter. */
export const ZOOM = { min: 0.1, max: 3, step: 1.25 } as const;
/** A fit never zooms in past actual size: a small picture stays at its own size. */
export const FIT_MAX = 1;
/** Pixels an arrow key pans. */
export const PAN_STEP = 80;
/** Past this many boxes a minimap is drawn. */
export const MINIMAP_FROM = 12;
/** Below this zoom the link labels are hidden: they are what overlaps when a picture shrinks. */
export const LABELS_FROM = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampZoom = (k: number) => clamp(k, ZOOM.min, ZOOM.max);

/** The box around some boxes. */
export function boundsOf(rects: readonly Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** The viewport that shows `content` whole and centred in `view`, with `pad` pixels round it. */
export function fitRect(
  content: Rect,
  view: Size,
  o: { pad?: number; min?: number; max?: number } = {},
): Viewport {
  const pad = o.pad ?? 24;
  const w = Math.max(1, view.width - pad * 2);
  const h = Math.max(1, view.height - pad * 2);
  const k = clamp(
    Math.min(w / Math.max(1, content.w), h / Math.max(1, content.h)),
    o.min ?? ZOOM.min,
    o.max ?? FIT_MAX,
  );
  return {
    k,
    x: (view.width - content.w * k) / 2 - content.x * k,
    y: (view.height - content.h * k) / 2 - content.y * k,
  };
}

/**
 * Beta.27: a fit that keeps the words legible. The picture is fitted, but never below `min` (the
 * smallest zoom whose words can be read); a picture too big for the view at that zoom starts at
 * its top-left corner (each axis that doesn't fit), to be panned, rather than centred with its
 * first boxes cut off above and to the left.
 */
export function fitLegibly(
  content: Rect,
  view: Size,
  o: { pad?: number; min: number; max?: number },
): Viewport {
  const pad = o.pad ?? 24;
  const v = fitRect(content, view, {
    pad,
    min: o.min,
    ...(o.max !== undefined ? { max: o.max } : {}),
  });
  const wide = content.w * v.k > view.width - pad * 2;
  const tall = content.h * v.k > view.height - pad * 2;
  return {
    k: v.k,
    x: wide ? pad - content.x * v.k : v.x,
    y: tall ? pad - content.y * v.k : v.y,
  };
}

/** Zoom by `factor` keeping the screen point `at` still (the cursor, a pinch's middle). */
export function zoomAt(v: Viewport, factor: number, at: { x: number; y: number }): Viewport {
  const k = clampZoom(v.k * factor);
  const f = k / v.k;
  return { k, x: at.x - (at.x - v.x) * f, y: at.y - (at.y - v.y) * f };
}

/** The viewport with `r` in the middle of `view`, at zoom `k` (the current one by default). */
export function centreOn(v: Viewport, r: Rect, view: Size, k = v.k): Viewport {
  return { k, x: view.width / 2 - (r.x + r.w / 2) * k, y: view.height / 2 - (r.y + r.h / 2) * k };
}

/** A wheel's zoom factor: smooth, by how far it turned (a pinch is a wheel with Ctrl held). */
export const wheelFactor = (deltaY: number, deltaMode = 0) =>
  Math.exp((-deltaY * (deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1)) / 500);

export type ViewerAction =
  | "zoom-in"
  | "zoom-out"
  | "reset"
  | "fit"
  | "fit-selection"
  | "focus"
  | "full-screen"
  | "leave"
  | "search"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down";

/** What a key does on a picture; nothing when a modifier is held or the key is typed in a field. */
export function keyAction(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): ViewerAction | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  switch (e.key) {
    case "+":
    case "=":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "fit";
    case "1":
      return "reset";
    case "s":
    case "S":
      return "fit-selection";
    case "m":
    case "M":
      return "focus";
    case "f":
    case "F":
      return "full-screen";
    case "Escape":
      return "leave";
    case "/":
      return "search";
    case "ArrowLeft":
      return "pan-left";
    case "ArrowRight":
      return "pan-right";
    case "ArrowUp":
      return "pan-up";
    case "ArrowDown":
      return "pan-down";
    default:
      return undefined;
  }
}

/** The viewport after a pan key: the picture moves the other way to the view. */
export function panBy(v: Viewport, a: ViewerAction): Viewport {
  const d = PAN_STEP;
  if (a === "pan-left") return { ...v, x: v.x + d };
  if (a === "pan-right") return { ...v, x: v.x - d };
  if (a === "pan-up") return { ...v, y: v.y + d };
  if (a === "pan-down") return { ...v, y: v.y - d };
  return v;
}

export interface Findable {
  id: string;
  label: string;
  kind?: string;
}

/** Boxes whose label (or id) has the words typed: an exact label first, then the start, then any. */
export function searchNodes<T extends Findable>(nodes: readonly T[], q: string, max = 8): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const score = (n: T) => {
    const l = n.label.toLowerCase();
    if (l === s) return 0;
    if (l.startsWith(s)) return 1;
    if (l.includes(s)) return 2;
    if (n.id.toLowerCase().includes(s)) return 3;
    return 9;
  };
  return nodes
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.n.label.length - b.n.label.length || (a.n.id < b.n.id ? -1 : 1))
    .slice(0, max)
    .map((x) => x.n);
}

/** A box and every box one link away: what focus mode leaves lit. */
export function neighbourhood(
  links: readonly { from: string; to: string }[],
  id: string,
): Set<string> {
  const out = new Set([id]);
  for (const l of links) {
    if (l.from === id) out.add(l.to);
    if (l.to === id) out.add(l.from);
  }
  return out;
}

/**
 * Where Tab or Shift+Tab goes in full screen, so focus cycles inside the frame (WCAG 2.1.2,
 * 2.4.3): past the last control back to the first, before the first to the last, and from the
 * frame itself or anywhere outside it into it. Undefined where the browser's own order holds.
 */
export function trapTab<T>(list: readonly T[], active: T | null, shift: boolean, frame: T) {
  if (!list.length) return frame;
  const i = active === null ? -1 : list.indexOf(active);
  if (shift) return i <= 0 ? list[list.length - 1] : undefined;
  return i === -1 || i === list.length - 1 ? list[0] : undefined;
}

/** Whether an Escape leaves full screen: not the one that clears Find a box, or one handled. */
export function leavesFullScreen(e: {
  key: string;
  defaultPrevented?: boolean;
  target: { closest?: (q: string) => unknown } | null;
}): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  return !e.target?.closest?.('[role="search"]');
}

/** On leaving full screen, focus goes back to the button that toggles it. */
export function returnFocus(
  frame: { querySelector: (q: string) => { focus: () => void } | null } | null,
) {
  frame?.querySelector('[data-viewer-action="full-screen"]')?.focus();
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Full screen on and off: Esc leaves; the page behind does not scroll while it is on. */
export function useFullScreen(initial = false): [boolean, (on?: boolean) => void] {
  const [full, setFull] = useState(initial);
  const toggle = useCallback((on?: boolean) => setFull((f) => (on === undefined ? !f : on)), []);
  useEffect(() => {
    if (!full || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (leavesFullScreen({ key: e.key, defaultPrevented: e.defaultPrevented, target }))
        setFull(false);
    };
    window.addEventListener("keydown", onKey);
    const body = document.body;
    const was = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      body.style.overflow = was;
    };
  }, [full]);
  return [full, toggle];
}

/**
 * The height a picture gets: the window's (or the IDE panel's) height less where the picture
 * starts, the start counted no lower than `MAX_TOP` so a picture far down a page still gets most
 * of a screen; never under `min`.
 */
export const MAX_TOP = 160;
/** Beta.27: the keys line's one line, which availableHeight leaves room for under the picture. */
export const KEYS_LINE = 16;
/** The margin under the keys line. */
const UNDER_KEYS = 8;
export function availableHeight(
  windowHeight: number,
  top: number,
  min = 420,
  maxTop = MAX_TOP,
): number {
  return Math.max(min, Math.floor(windowHeight - clamp(top, 0, maxTop) - KEYS_LINE - UNDER_KEYS));
}
/**
 * Beta.27 review: how far down the map's canvas may start and still be counted, so a notice
 * above it (">~60 boxes") takes its room from the picture instead of pushing the picture's foot,
 * its legend and minimap, under the bottom panel.
 */
export const CANVAS_MAX_TOP = 400;
/**
 * The picture's height with the keys line under it: what the line takes past its one line
 * (KEYS_LINE, a narrow frame wrapping it) is the picture's.
 */
export const stageHeight = (height: number, keys: number) =>
  Math.max(160, height - Math.max(0, keys - KEYS_LINE));

/**
 * The height a picture gets inside the area that scrolls it (beta.26: the IDE layout's page,
 * between its tabs and its bottom panel; the classic layout's is the window): the area's height
 * less where the picture starts in it, that start counted no lower than `MAX_TOP`; never under
 * `min`.
 */
export function availableHeightIn(
  view: { top: number; bottom: number },
  top: number,
  min = 420,
  maxTop = MAX_TOP,
): number {
  return availableHeight(view.bottom - view.top, top - view.top, min, maxTop);
}

/** The nearest ancestor that scrolls its content, if any; else the window does. */
function scrollerOf(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return undefined;
}

/**
 * `availableHeightIn` the area that scrolls the picture (the window, or the IDE layout's page),
 * kept as the window or the IDE panel the app is embedded in is resized, and as the IDE layout's
 * bottom panel opens or closes. `fixed` (a test, or a caller that knows) skips the measuring. In
 * full screen the stage fills the frame by CSS, so this is not used.
 */
export function useAvailableHeight(
  ref: RefObject<HTMLElement | null>,
  o: { min?: number; fixed?: number; maxTop?: number } = {},
): number {
  const min = o.min ?? 420;
  const maxTop = o.maxTop ?? MAX_TOP;
  const [h, setH] = useState(o.fixed ?? Math.max(min, 560));
  useEffect(() => {
    if (o.fixed !== undefined || typeof window === "undefined") return;
    const scroller = ref.current ? scrollerOf(ref.current) : undefined;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const area = scroller?.getBoundingClientRect();
      const view = {
        top: Math.max(0, area?.top ?? 0),
        bottom: Math.min(window.innerHeight, area?.bottom ?? window.innerHeight),
      };
      setH(availableHeightIn(view, el.getBoundingClientRect().top, min, maxTop));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    // Beta.26 review: what is above the picture changing (the map's bar wrapping, a note shown
    // above its panel) moves the picture's top without resizing the scroller: every box round
    // it, up to the scroller, is watched too, so the height follows.
    if (ro)
      for (let a = ref.current?.parentElement; a && a !== scroller && a !== document.body;) {
        ro.observe(a);
        a = a.parentElement;
      }
    if (ro && scroller) ro.observe(scroller);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [ref, min, maxTop, o.fixed]);
  return o.fixed ?? h;
}

/**
 * Beta.26 review: fit the picture again once its frame has its measured height (the first fit
 * ran on the height guessed before measuring, so a tall estate opened at 100 % with its lower
 * boxes cut off), and whenever that height changes or full screen is left, until the person
 * moves the view themselves (`moved`, set from a move they started).
 */
export function useFitOnResize(
  rf: RefObject<{ fitView(o?: { padding?: number; minZoom?: number }): unknown } | undefined>,
  o: { height: number; ready: boolean; full: boolean; moved: RefObject<boolean>; minZoom?: number },
) {
  const { height, ready, full, moved } = o;
  const minZoom = o.minZoom ?? 0.6;
  useEffect(() => {
    if (!ready || moved.current || typeof requestAnimationFrame === "undefined") return;
    // After the frame takes the height (the next paint), so the fit uses it.
    const f = requestAnimationFrame(() => void rf.current?.fitView({ padding: 0.08, minZoom }));
    return () => cancelAnimationFrame(f);
  }, [height, ready, full, rf, moved, minZoom]);
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const ICON = {
  in: "M3 7 H11 M7 3 V11",
  out: "M3 7 H11",
  reset: "M2 4 V10 M5 4 V10 M9 4 H12 V10 H9 Z",
  fit: "M2 5 V2 H5 M9 2 H12 V5 M12 9 V12 H9 M5 12 H2 V9",
  sel: "M4 4 H10 V10 H4 Z M1 7 H3 M11 7 H13 M7 1 V3 M7 11 V13",
  focus: "M7 4 A3 3 0 1 1 6.99 4 M1 7 H2.5 M11.5 7 H13",
  full: "M2 5 V2 H5 M9 2 H12 V5 M12 9 V12 H9 M5 12 H2 V9 M5 5 L9 9 M9 5 L5 9",
  leave: "M5 2 V5 H2 M9 2 V5 H12 M12 9 H9 V12 M2 9 H5 V12",
  close: "M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5",
};

/**
 * The controls over a picture: zoom, fit, the picked box, focus, full screen and find. Each is a
 * labelled button (WCAG 2.1 AA: name, visible focus, keyboard), and the keys say the same.
 */
export function ViewerToolbar(p: {
  zoom: number;
  full: boolean;
  focus: boolean;
  /** A box is picked: zoom to it and focus on it can be used. */
  picked: boolean;
  nodes: readonly Findable[];
  onAction: (a: ViewerAction) => void;
  onFind: (id: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
}) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [said, setSaid] = useState("");
  const find = (text: string) => {
    const hit = searchNodes(p.nodes, text, 1)[0];
    if (hit) {
      p.onFind(hit.id);
      setSaid(T.found(hit.label));
    } else if (text.trim()) setSaid(T.notFound(text.trim()));
  };
  const btn = (
    a: ViewerAction,
    label: string,
    icon: string,
    o: { on?: boolean; off?: boolean } = {},
  ) => (
    <button
      type="button"
      className={`btn viewer-btn ${o.on ? "primary" : ""}`}
      aria-label={label}
      title={label}
      data-viewer-action={a}
      disabled={o.off}
      {...(o.on !== undefined ? { "aria-pressed": o.on } : {})}
      onClick={() => p.onAction(a)}
    >
      <Icon d={icon} />
    </button>
  );
  return (
    <div className="viewer-bar" role="toolbar" aria-label={T.toolbar}>
      <div className="viewer-group">
        {btn("zoom-out", T.zoomOut, ICON.out)}
        <span className="hud viewer-zoom" aria-live="polite">
          {T.zoomLevel(Math.round(p.zoom * 100))}
        </span>
        {btn("zoom-in", T.zoomIn, ICON.in)}
        {btn("reset", T.reset, ICON.reset)}
        {btn("fit", T.fit, ICON.fit)}
        {btn("fit-selection", T.fitSelection, ICON.sel, { off: !p.picked })}
        {btn("focus", p.focus ? T.focusOff : T.focus, ICON.focus, {
          on: p.focus,
          off: !p.picked && !p.focus,
        })}
        {btn(
          "full-screen",
          p.full ? T.leaveFullScreen : T.fullScreen,
          p.full ? ICON.leave : ICON.full,
          {
            on: p.full,
          },
        )}
      </div>
      <form
        className="viewer-group viewer-find"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          find(q);
        }}
      >
        <input
          ref={p.searchRef}
          className="field"
          type="search"
          aria-label={T.search}
          placeholder={T.searchPlaceholder}
          list={listId}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // Picking a suggestion from the list finds it at once.
            if (p.nodes.some((n) => n.label === e.target.value)) find(e.target.value);
          }}
          onKeyDown={(e) => {
            // Escape here clears the search only, never leaves full screen (review 17).
            if (e.key === "Escape") {
              e.stopPropagation();
              e.preventDefault();
              setQ("");
            }
          }}
        />
        <datalist id={listId}>
          {searchNodes(p.nodes, q, 8).map((n) => (
            <option key={n.id} value={n.label}>
              {n.kind ?? ""}
            </option>
          ))}
        </datalist>
        <span className="sr" aria-live="polite">
          {said}
        </span>
      </form>
    </div>
  );
}

/**
 * The frame round a picture: the toolbar, the picture filling the width and the height left on
 * the page, details laid over its right edge (collapsible, never squeezing the picture), and full
 * screen. Keys pressed while focus is inside the frame (not in a field) drive the viewer.
 */
export function DiagramFrame(p: {
  title: string;
  full: boolean;
  height: number;
  frameRef?: RefObject<HTMLDivElement | null>;
  toolbar: ReactNode;
  children: ReactNode;
  /** Details beside the picture: an overlay at its right edge. */
  aside?: ReactNode;
  /**
   * Beta.26: the details as a right-hand panel beside the picture (the picture narrower, none of
   * it hidden), closed by its own button and opened again by Show details. Under 1000 px wide it
   * lies over the picture, as the overlay does.
   */
  asideBeside?: boolean;
  /** Changed to something, the details open again: a panel was asked for in them. */
  reveal?: string;
  /**
   * Beta.27 review: nothing is picked, so the details hold only "Pick a box": in a narrow frame
   * (an editor's panel), where they lie over the picture, they start closed.
   */
  asideIdle?: boolean;
  /**
   * Beta.26: where the toolbar goes when not in full screen (the page's own bar, so the picture's
   * controls share one row with the page's); in full screen it is in the frame.
   */
  toolbarIn?: HTMLElement | null;
  onKeyAction: (a: ViewerAction) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(() => !(p.asideIdle && narrowWindow()));
  const asideId = useId();
  // Beta.28: the details' width beside the picture (undefined: the stylesheet's own).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const [asideW, setAsideW] = useState<number | undefined>(undefined);
  useEffect(() => setAsideW(savedAsideWidth()), []);
  const maxAside = () =>
    Math.max(
      ASIDE_WIDTH.min,
      (stageRef.current?.getBoundingClientRect().width ?? 0) - ASIDE_WIDTH.keep,
    );
  const currentAside = () =>
    asideW ?? asideRef.current?.getBoundingClientRect().width ?? ASIDE_WIDTH.min;
  const chooseAside = (n: number | undefined) => {
    setAsideW(n);
    saveAsideWidth(n);
  };
  const wideNow = asideW !== undefined && asideW >= maxAside() * ASIDE_WIDTH.wide - 1;
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = nextAsideWidth(currentAside(), e.key, maxAside());
    if (n === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    chooseAside(n);
  };
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const right = stage.getBoundingClientRect().right;
      const max = maxAside();
      chooseAside(Math.min(Math.max(right - ev.clientX, ASIDE_WIDTH.min), max));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const own = useRef<HTMLDivElement | null>(null);
  const ref = p.frameRef ?? own;
  // Beta.27: the keys line wraps in a narrow frame; the picture gives it the room it takes, so
  // the line under the picture is never cut off.
  const keys = useRef<HTMLParagraphElement | null>(null);
  const [keysH, setKeysH] = useState(KEYS_LINE);
  useEffect(() => {
    const el = keys.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setKeysH(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Beside the picture, closing the details gives the focus to Show details, and opening them to
  // their close button, so it is never left on a button that went away.
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  const toggled = useRef(false);
  const toggle = (o: boolean) => {
    toggled.current = true;
    setOpen(o);
  };
  useEffect(() => {
    if (!toggled.current || !p.asideBeside) return;
    toggled.current = false;
    (open ? closeRef : showRef).current?.focus();
  }, [open, p.asideBeside]);
  // A panel asked for inside the details (a new `reveal`) opens them again, in this very render
  // (beta.26 review): the panel's own effect (a link's heading taking the focus) then runs on
  // details already shown, not hidden ones opened an effect later.
  const [revealed, setRevealed] = useState(p.reveal);
  let shown = open;
  if (p.reveal !== revealed) {
    setRevealed(p.reveal);
    if (p.reveal && !open) {
      setOpen(true);
      shown = true;
    }
  }
  const toolbarOut = p.toolbarIn && !p.full ? p.toolbarIn : undefined;
  // Leaving full screen gives focus back to its button (review 17), wherever the toolbar is.
  const wasFull = useRef(p.full);
  useEffect(() => {
    if (wasFull.current && !p.full) returnFocus(p.toolbarIn ?? ref.current);
    wasFull.current = p.full;
    if (!p.full || typeof document === "undefined") return;
    // Focus that lands outside the frame (a click behind it) is brought back in.
    const frame = ref.current;
    if (frame && !frame.contains(document.activeElement)) frame.focus();
    const onFocus = (e: FocusEvent) => {
      if (frame && !frame.contains(e.target as Node)) frame.focus();
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [p.full, ref]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // In full screen the frame is a dialog: Tab and Shift+Tab cycle inside it.
    if (p.full && e.key === "Tab" && ref.current) {
      const frame = ref.current;
      const list = [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (x) => x !== frame && !x.closest("[hidden]") && x.getClientRects().length > 0,
      );
      const next = trapTab<HTMLElement>(
        list,
        document.activeElement as HTMLElement | null,
        e.shiftKey,
        frame,
      );
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    if (t.isContentEditable) return;
    // Keys inside the details panel, or a control laid over the picture, are their own.
    if (t.closest?.(".viewer-aside, .viewer-own")) return;
    const a = keyAction(e);
    if (!a) return;
    // Arrows on a box the canvas lets you move are the box's (React Flow moves it).
    if (a.startsWith("pan-") && t.closest?.(".react-flow__node")) return;
    if (a === "leave" && !p.full) return;
    e.preventDefault();
    p.onKeyAction(a);
  };
  return (
    <div
      ref={ref}
      className={`viewer ${p.full ? "viewer-full" : ""} ${p.className ?? ""}`}
      role="region"
      tabIndex={0}
      aria-label={T.region(p.title)}
      onKeyDown={onKeyDown}
      {...(p.full ? { "aria-modal": true } : {})}
    >
      {toolbarOut ? createPortal(p.toolbar, toolbarOut) : p.toolbar}
      {p.full && (
        <p className="sr" role="status">
          {T.fullScreenOn}
        </p>
      )}
      <div
        ref={stageRef}
        className={`viewer-stage${p.aside && p.asideBeside ? " beside" : ""}`}
        style={p.full ? undefined : { height: stageHeight(p.height, keysH) }}
      >
        {p.children}
        {p.aside && p.asideBeside && (
          <>
            {!shown && (
              <button
                ref={showRef}
                type="button"
                className="btn viewer-aside-toggle"
                aria-expanded={false}
                aria-controls={asideId}
                onClick={() => toggle(true)}
              >
                {T.showDetails}
              </button>
            )}
            {shown && (
              <div
                role="separator"
                tabIndex={0}
                className="viewer-aside-resize"
                aria-orientation="vertical"
                aria-controls={asideId}
                aria-label={T.resizeDetails}
                aria-valuemin={ASIDE_WIDTH.min}
                aria-valuenow={Math.round(asideW ?? ASIDE_WIDTH.min)}
                onKeyDown={onHandleKey}
                onPointerDown={onHandleDown}
                onDoubleClick={() => chooseAside(undefined)}
              />
            )}
            <aside
              id={asideId}
              ref={asideRef}
              className="viewer-aside"
              aria-label={T.details}
              hidden={!shown}
              style={asideW === undefined ? undefined : { flexBasis: `${asideW}px` }}
            >
              <button
                type="button"
                className="btn viewer-btn viewer-aside-widen"
                aria-pressed={wideNow}
                onClick={() =>
                  chooseAside(wideNow ? undefined : Math.round(maxAside() * ASIDE_WIDTH.wide))
                }
              >
                {wideNow ? T.narrowDetails : T.widenDetails}
              </button>
              <button
                ref={closeRef}
                type="button"
                className="btn viewer-btn viewer-aside-close"
                aria-expanded={true}
                aria-controls={asideId}
                aria-label={T.hideDetails}
                title={T.hideDetails}
                onClick={() => toggle(false)}
              >
                <Icon d={ICON.close} />
              </button>
              {p.aside}
            </aside>
          </>
        )}
        {p.aside && !p.asideBeside && (
          <>
            <button
              type="button"
              className="btn viewer-aside-toggle"
              aria-expanded={shown}
              aria-controls={asideId}
              onClick={() => setOpen((o) => !o)}
            >
              {shown ? T.hideDetails : T.showDetails}
            </button>
            <aside id={asideId} className="viewer-aside" aria-label={T.details} hidden={!shown}>
              {p.aside}
            </aside>
          </>
        )}
      </div>
      <p ref={keys} className="viewer-keys">
        {T.keys}
      </p>
    </div>
  );
}

/**
 * Beta.27 review: under this width the details lie over the picture rather than beside it
 * (viewer.css's media query), so empty ones start closed.
 */
export const NARROW_FRAME = 1000;
export const narrowWindow = (): boolean =>
  typeof window !== "undefined" &&
  (typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${NARROW_FRAME}px)`).matches
    : window.innerWidth <= NARROW_FRAME);

/** A viewport kept in state with the actions the toolbar and keys ask for, on a plain picture. */
export function useViewport(content: Rect, view: Size) {
  const [v, setV] = useState<Viewport>(() => fitRect(content, view));
  const latest = useRef({ content, view });
  latest.current = { content, view };
  const fit = useCallback(() => setV(fitRect(latest.current.content, latest.current.view)), []);
  return { v, setV, fit };
}
