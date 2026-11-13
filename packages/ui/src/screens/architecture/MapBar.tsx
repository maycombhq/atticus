import { useId, useState, type ReactNode, type Ref } from "react";
import { COPY } from "../../copy.js";
import type { CanvasLink } from "./model.js";
import { LinkKinds } from "./Tools.js";
import { WORDS } from "./words.js";
import "./map-bar.css";

/**
 * Beta.26: the map gives its canvas most of the space. Its controls are one slim bar above the
 * canvas: the lens as a segmented control, where you are, the tools as icon buttons named in
 * words (each with a tooltip of the same words), and at its right the picture's own controls
 * (zoom, fit, focus, full screen, find), which the canvas puts there. The legend lies over a
 * corner of the canvas, folded until it is opened, remembered in this browser.
 */

const V = COPY.viewer;
const T = COPY.canvasTools;

const PATHS = {
  add: "M2 2 H12 V12 H2 Z M7 4.5 V9.5 M4.5 7 H9.5",
  tools: "M2 4 H12 M2 10 H12 M5 2.5 V5.5 M9 8.5 V11.5",
  keep: "M5 1.5 H9 L8.5 5.5 L10.5 7.5 H3.5 L5.5 5.5 Z M7 7.5 V12.5",
  tidy: "M2 2 H6 V6 H2 Z M8 2 H12 V6 H8 Z M2 8 H6 V12 H2 Z M8 8 H12 V12 H8 Z",
  reset: "M3.2 5 A4.2 4.2 0 1 1 3 8.5 M3 2 V5 H6",
  legend: "M2 3.5 H3.5 M6 3.5 H12 M2 7 H3.5 M6 7 H12 M2 10.5 H3.5 M6 10.5 H12",
} as const;

/** An icon drawn, never read: the button it is on carries the words. */
export function MapIcon({ d }: { d: keyof typeof PATHS }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d={PATHS[d]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A button that shows an icon and is named in words, its tooltip the same words. */
export function IconButton(p: {
  label: string;
  icon: keyof typeof PATHS;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn viewer-btn${p.primary ? " primary" : ""}`}
      aria-label={p.label}
      title={p.label}
      disabled={p.disabled}
      {...(p.busy ? { "aria-busy": true } : {})}
      onClick={p.onClick}
    >
      <MapIcon d={p.icon} />
    </button>
  );
}

export function MapBar(p: {
  lenses: readonly { id: string; label: string }[];
  lens: string;
  onLens: (id: string) => void;
  /** Where you are: the breadcrumbs. */
  crumbs: ReactNode;
  onAdd: () => void;
  /** The tools' drawer, the boxes it leaves shown and all of them. */
  tools: {
    open: boolean;
    bodyId: string;
    onToggle: () => void;
    shown: number;
    all: number;
    buttonRef?: Ref<HTMLButtonElement>;
  };
  /** Keep, Tidy up and Reset. */
  arrangement?: ReactNode;
  /** What runs or just happened (checking the contracts, an arrangement kept). */
  status?: ReactNode;
  /** The place at the bar's right where the canvas puts its own controls. */
  viewSlot?: Ref<HTMLDivElement>;
  /** Beta.28: Edit the map's toggle, before the tools. */
  edit?: ReactNode;
}) {
  const t = p.tools;
  return (
    <div className="arch-bar" role="group" aria-label={V.mapControls}>
      <div role="tablist" aria-label={WORDS.lens} className="arch-seg">
        {p.lenses.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={l.id === p.lens}
            className={`arch-seg-btn${l.id === p.lens ? " on" : ""}`}
            onClick={() => p.onLens(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      {p.crumbs}
      <div className="arch-bar-tools">
        <IconButton label={COPY.addBox.open} icon="add" onClick={p.onAdd} />
        {p.edit}
        <button
          ref={t.buttonRef}
          type="button"
          className={`btn viewer-btn arch-tools-toggle${t.open ? " primary" : ""}`}
          aria-expanded={t.open}
          // Beta.26 review: the drawer isn't there while closed, so nothing is pointed at then;
          // data-controls names it always, so a tab left and come back to opens it again.
          {...(t.open ? { "aria-controls": t.bodyId } : {})}
          aria-label={t.open ? T.hide : T.show}
          title={t.open ? T.hide : T.show}
          data-controls={t.bodyId}
          onClick={t.onToggle}
        >
          <MapIcon d="tools" />
        </button>
        {t.shown < t.all && (
          <span className="hud arch-bar-count">{T.filtered(t.shown, t.all)}</span>
        )}
        {p.arrangement}
      </div>
      {p.status && <div className="arch-bar-status">{p.status}</div>}
      <div className="arch-bar-view" ref={p.viewSlot} />
    </div>
  );
}

/** Where the legend's folded or open state is kept, in this browser only. */
export const LEGEND_KEY = "atticus.map.legend";

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function storage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Folded unless it was opened in this browser (beta.26 review: open, it covered a box of the
 * estate at 1440 by 900); folded where storage refuses.
 */
export function readLegendOpen(s: Pick<Store, "getItem"> | undefined = storage()): boolean {
  try {
    return s?.getItem(LEGEND_KEY) === "open";
  } catch {
    return false;
  }
}

export function saveLegendOpen(open: boolean, s: Pick<Store, "setItem"> | undefined = storage()) {
  try {
    s?.setItem(LEGEND_KEY, open ? "open" : "closed");
  } catch {
    // No storage: it opens again next time.
  }
}

/**
 * The legend over the canvas's lower left corner: how many links the picture draws and how
 * each kind is drawn (ADR 0181), folding to its button.
 */
export function CanvasLegend(p: {
  meta: string;
  links: readonly CanvasLink[];
  /** Tests; otherwise what this browser kept. */
  initialOpen?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(() => p.initialOpen ?? readLegendOpen());
  return (
    <div className="arch-legend viewer-own">
      <button
        type="button"
        className="btn arch-legend-btn"
        aria-expanded={open}
        {...(open ? { "aria-controls": `${id}-legend` } : {})}
        data-controls={`${id}-legend`}
        onClick={() => {
          setOpen(!open);
          saveLegendOpen(!open);
        }}
      >
        <MapIcon d="legend" />
        {V.legend}
      </button>
      {open && (
        <div id={`${id}-legend`} className="arch-legend-body">
          <p className="hud">{p.meta}</p>
          <LinkKinds links={p.links} />
        </div>
      )}
    </div>
  );
}
