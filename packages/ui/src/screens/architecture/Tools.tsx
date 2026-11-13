import { useId, useState, type KeyboardEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi } from "../../api/client.js";
import { hostBridge } from "../../api/bridge.js";
import { COPY } from "../../copy.js";
import type { TypeDraws } from "./Canvas.js";
import { SplitCounts } from "../../app/decisions.js";
import { takesText } from "../../app/ui.js";
import { linkCounts, type CanvasGraph, type CanvasLink, type LinkBy } from "./model.js";
import { WORDS } from "./words.js";
import { DeletedLinks } from "./DeleteLink.js";
import {
  LAYERS,
  inbox,
  isOnlyAi,
  onlyAi,
  toDrawio,
  toMermaid,
  toSvg,
  trace,
  type Direction,
  type Layers,
  type Placed,
  type Snapshot,
} from "./canvas-tools.js";

/**
 * G6 (ADR 0175): the canvas's tools panel. Every tool works on the picture already loaded; the
 * only writes are a kept view (diagrams/views/<name>.yaml, for review) and files the person saves.
 */

const T = COPY.canvasTools;

export type Overlay = "none" | "gaps" | "questions";

export interface ToolsState {
  layers: Layers;
  mismatches: boolean;
  filter: string;
  overlay: Overlay;
  radius?: { dir: Direction; depth: number };
  compareWith?: Snapshot;
}

type SaveEnd = "saved" | "cancelled" | "failed" | undefined;

/**
 * Save text as a file. In the browser it downloads; a VS Code panel can't download (ADR 0097),
 * so there the extension asks where with its Save dialog and says how it went.
 */
async function download(name: string, text: string, type: string): Promise<SaveEnd> {
  const b = hostBridge();
  if (b) return b.saveFile(name, text, "utf8");
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return undefined;
}

/** The SVG drawn onto a canvas and saved as a PNG, at twice its size. */
function downloadPng(name: string, svg: string): Promise<SaveEnd> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve("failed");
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width * 2;
      c.height = img.height * 2;
      const g = c.getContext("2d");
      g?.scale(2, 2);
      g?.drawImage(img, 0, 0);
      const b = hostBridge();
      if (b) {
        // A canvas too big to draw gives an empty picture: that is a failure, not a save.
        const data = c.toDataURL("image/png").split(",")[1] ?? "";
        if (!data) return resolve("failed");
        void b.saveFile(name, data, "base64").then(resolve);
        return;
      }
      c.toBlob((blob) => {
        if (!blob) return resolve("failed");
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
        resolve(undefined);
      });
    };
    // A data address, which a VS Code panel's page may load (a blob one it may not).
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function printSvg(svg: string, title: string): SaveEnd {
  const w = window.open("", "_blank");
  // Blocked (a popup setting, an embedded browser): said, with the SVG as the way out.
  if (!w) return "failed";
  w.document.title = title;
  w.document.body.innerHTML = svg;
  w.focus();
  w.print();
  return undefined;
}

export function CanvasTools(p: {
  graph: CanvasGraph;
  /** All boxes before the filter, for "n of N shown". */
  allBoxes: number;
  state: ToolsState;
  onChange(s: ToolsState): void;
  /** A kept view's lens and box, opened as a link to them would open them. */
  onOpenView?(lens: string, node: string): void;
  /** The overlay's state while it isn't there yet (loading, or why it failed). */
  overlayNote?: string;
  selected?: string;
  onSelect(id: string): void;
  /** ADR 0181: pick a link (an AI link from the Detected by AI list). */
  onPickLink?(id: string): void;
  labelOf(id: string): string;
  placed(id: string): Placed | undefined;
  /** What a kept view stands for. */
  lens: string;
  node: string;
  /** ADR 0180: the organisation's component types, for the legend and the type filter. */
  types?: TypeDraws;
  /** The links counted from the snapshot. */
  compared?: { added: number; removed: Snapshot["links"] };
  snapshot?: Snapshot;
  onSnapshot(): void;
  name: string;
  /**
   * Beta.26: a drawer over the canvas, opened from the map's bar (whose button controls
   * `bodyId`): nothing while closed, its own close button (and Esc) while open.
   */
  drawer?: { open: boolean; bodyId: string; onClose(): void };
  /** Beta.28: a deleted link brought back (the picture is read again). */
  onLinkBack?(): void;
}) {
  const id = useId();
  const [ownOpen, setOpen] = useState(false);
  const open = p.drawer ? p.drawer.open : ownOpen;
  const [viewName, setViewName] = useState("");
  const [saved, setSaved] = useState<string | undefined>();
  const [exported, setExported] = useState<string | undefined>();
  // How a save in a VS Code panel went (the browser's download says so itself).
  const said = async (p0: Promise<SaveEnd>) => {
    const end = await p0;
    setExported(end ? T.exportEnd[end] : undefined);
  };
  const [error, setError] = useState<string | undefined>();
  const views = useApi<Api.SavedCanvasViewsT>(open ? "/api/graph/views" : undefined);
  const s = p.state;
  const set = (x: Partial<ToolsState>) => p.onChange({ ...s, ...x });
  const out = p.selected ? trace(p.graph.links, p.selected) : [];
  const open0 = inbox(p.graph);
  const [keeping, setKeeping] = useState(false);
  const keep = async () => {
    if (keeping) return;
    setKeeping(true);
    setError(undefined);
    try {
      const v = await api<Api.SavedCanvasViewT>(
        // A name kept already is replaced: the button said Replace.
        `/api/graph/views/${encodeURIComponent(viewName)}${views.state === "ready" && views.data.views.some((v) => v.name === viewName) ? "?replace=1" : ""}`,
        {
          method: "PUT",
          body: {
            lens: p.lens,
            node: p.node,
            filter: s.filter,
            layers: s.layers,
            overlay: s.overlay,
            mismatches: s.mismatches,
          },
        },
      );
      setSaved(`diagrams/views/${v.name}.yaml`);
      views.reload();
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.message) : String(e));
      // Kept meanwhile (a teammate's): the list again, so the button says Replace.
      if (e instanceof ApiError && e.problem.status === 409) views.reload();
    } finally {
      setKeeping(false);
    }
  };
  const drawer = p.drawer;
  if (drawer && !open) return null;
  return (
    <section
      {...(drawer ? { id: drawer.bodyId } : {})}
      className={drawer ? "canvas-tools arch-tools-drawer" : "canvas-tools"}
      aria-labelledby={`${id}-t`}
      {...(drawer
        ? {
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
              // Esc closes the drawer, unless a text field takes it (a search box clears itself);
              // from a checkbox, a radio or a select it closes the drawer (beta.26 review).
              if (e.key !== "Escape" || takesText(e.target as HTMLElement)) return;
              e.preventDefault();
              drawer.onClose();
            },
          }
        : {})}
    >
      {drawer ? (
        <div className="row arch-tools-head">
          <h3 id={`${id}-t`} className="hud" style={{ margin: 0 }}>
            {T.title}
          </h3>
          <span className="work-say">{T.filtered(p.graph.boxes.length, p.allBoxes)}</span>
          <button
            type="button"
            className="btn viewer-btn arch-tools-close"
            aria-label={T.hide}
            title={T.hide}
            onClick={drawer.onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path
                d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <h3 id={`${id}-t`} className="hud" style={{ margin: 0 }}>
            {T.title}
          </h3>
          <button
            type="button"
            className="btn"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? T.hide : T.show}
          </button>
          <span className="work-say">{T.filtered(p.graph.boxes.length, p.allBoxes)}</span>
        </div>
      )}
      {open && (
        <div id={`${id}-body`} className="canvas-tools-body">
          <fieldset>
            <legend className="hud">{T.layers}</legend>
            {LAYERS.map((l) => (
              <label key={l} className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={s.layers[l]}
                  onChange={(e) => set({ layers: { ...s.layers, [l]: e.target.checked } })}
                />
                {T.layer[l]}
              </label>
            ))}
            <label className="row" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={s.mismatches}
                onChange={(e) => set({ mismatches: e.target.checked })}
              />
              {T.mismatches}
            </label>
          </fieldset>

          <AiLayer
            graph={p.graph}
            layers={s.layers}
            onLayers={(layers) => set({ layers })}
            onPick={(l) => p.onPickLink?.(l)}
            labelOf={p.labelOf}
          />

          <div className="stack">
            <label htmlFor={`${id}-f`} className="hud">
              {T.filter}
            </label>
            <input
              id={`${id}-f`}
              className="field"
              type="search"
              value={s.filter}
              placeholder={T.filterHint}
              aria-describedby={`${id}-fh`}
              onChange={(e) => set({ filter: e.target.value })}
            />
            <span id={`${id}-fh`} className="hud">
              {T.filterHint}
            </span>
            <label htmlFor={`${id}-o`} className="hud">
              {T.overlay}
            </label>
            <select
              id={`${id}-o`}
              className="field"
              value={s.overlay}
              onChange={(e) => set({ overlay: e.target.value as Overlay })}
            >
              {(["none", "gaps", "questions"] as const).map((o) => (
                <option key={o} value={o}>
                  {T.overlays[o]}
                </option>
              ))}
            </select>
          </div>
          {p.overlayNote && (
            <p role="status" className="work-say">
              {p.overlayNote}
            </p>
          )}

          <fieldset>
            <legend className="hud">{T.radius}</legend>
            {!p.selected ? (
              <p className="work-say">{T.radiusPick}</p>
            ) : (
              <>
                {(["up", "down", "both"] as const).map((d) => (
                  <label key={d} className="row" style={{ gap: 4 }}>
                    <input
                      type="radio"
                      name={`${id}-dir`}
                      checked={(s.radius?.dir ?? "both") === d}
                      onChange={() => set({ radius: { dir: d, depth: s.radius?.depth ?? 2 } })}
                    />
                    {T.radiusDir[d]}
                  </label>
                ))}
                <label className="row" style={{ gap: 6 }}>
                  {T.depth(s.radius?.depth ?? 2)}
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={s.radius?.depth ?? 2}
                    onChange={(e) =>
                      set({
                        radius: { dir: s.radius?.dir ?? "both", depth: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    set(s.radius ? { radius: undefined } : { radius: { dir: "both", depth: 2 } })
                  }
                >
                  {s.radius ? T.radiusOff : T.radiusOn}
                </button>
              </>
            )}
          </fieldset>

          <div className="stack">
            <h4 className="hud">{T.trace}</h4>
            {!p.selected ? (
              <p className="work-say">{T.radiusPick}</p>
            ) : out.length ? (
              <ol className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                {out.map((h, i) => (
                  <li key={`${h.link.id}-${i}`}>
                    <span className="hud">{T.hop(h.depth)}</span>{" "}
                    <button type="button" className="link" onClick={() => p.onSelect(h.link.to)}>
                      {p.labelOf(h.link.from)} → {p.labelOf(h.link.to)}
                    </button>{" "}
                    <span className="work-say">{h.link.label}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="work-say">{T.traceNone}</p>
            )}
          </div>

          <div className="stack">
            <h4 className="hud">{T.inbox}</h4>
            {open0.length ? (
              <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                {open0.slice(0, 50).map((x, i) => (
                  <li key={`${x.what}-${x.id}-${i}`}>
                    <button type="button" className="link" onClick={() => p.onSelect(x.id)}>
                      {x.label}
                    </button>{" "}
                    <span className="work-say">
                      {x.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}
                    </span>
                  </li>
                ))}
                {open0.length > 50 && (
                  <li className="work-say">{COPY.app.andMore(open0.length - 50)}</li>
                )}
              </ul>
            ) : (
              <p className="work-say">{T.inboxNone}</p>
            )}
          </div>

          <div className="stack">
            <h4 className="hud">{T.compare}</h4>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={p.onSnapshot}>
                {T.snapshot}
              </button>
              {p.snapshot ? (
                <label className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!s.compareWith}
                    onChange={(e) =>
                      set(
                        e.target.checked ? { compareWith: p.snapshot } : { compareWith: undefined },
                      )
                    }
                  />
                  {T.compareOn} {T.snapshotAt(p.snapshot.at)}
                </label>
              ) : (
                <span className="work-say">{T.noSnapshot}</span>
              )}
            </div>
            {s.compareWith && p.compared && (
              <div role="status">
                <p className="work-say">{T.added(p.compared.added)}</p>
                {p.compared.removed.length > 0 && (
                  <>
                    <p className="work-say">{T.removed(p.compared.removed.length)}</p>
                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                      {p.compared.removed.map((l) => (
                        <li key={l.id}>
                          {p.labelOf(l.from)} → {p.labelOf(l.to)} ({l.label})
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          {p.types && Object.keys(p.types).length > 0 && (
            <TypeLegend
              types={p.types}
              graph={p.graph}
              filter={p.state.filter}
              onFilter={(f) => p.onChange({ ...p.state, filter: f })}
            />
          )}

          <div className="stack">
            <h4 className="hud">{T.views}</h4>
            {views.state === "ready" && views.data.views.length ? (
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {views.data.views.map((v) => (
                  <li key={v.name}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        p.onChange({
                          ...s,
                          filter: v.filter,
                          layers: { ...s.layers, ...v.layers },
                          overlay: v.overlay,
                          mismatches: v.mismatches,
                        });
                        if (v.lens !== p.lens || v.node !== p.node) p.onOpenView?.(v.lens, v.node);
                      }}
                    >
                      {T.open} {v.name}
                    </button>
                    {v.filter && <span className="work-say"> · {v.filter}</span>}
                  </li>
                ))}
              </ul>
            ) : views.state === "ready" ? (
              <p className="work-say">{T.noViews}</p>
            ) : views.state === "error" ? (
              <p role="alert" className="state error">
                {T.viewsFailed(views.error)}
              </p>
            ) : (
              views.state === "loading" && (
                <p role="status" aria-busy="true" className="work-say">
                  {T.viewsLoading}
                </p>
              )
            )}
            <label htmlFor={`${id}-n`} className="hud">
              {T.viewName}
            </label>
            <div className="row" style={{ gap: 6 }}>
              <input
                id={`${id}-n`}
                className="field"
                value={viewName}
                onChange={(e) => {
                  setViewName(e.target.value);
                  setSaved(undefined);
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={keeping || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(viewName)}
                aria-busy={keeping}
                onClick={() => void keep()}
              >
                {keeping && T.saving}
                {/* A name kept already is replaced, and the button says so. */}
                {keeping
                  ? null
                  : views.state === "ready" && views.data.views.some((v) => v.name === viewName)
                    ? T.replace(viewName)
                    : T.save}
              </button>
            </div>
            {saved && (
              <p role="status" className="work-say">
                {T.saved(saved)}
              </p>
            )}
            {error && (
              <p role="alert" className="state error">
                {error}
              </p>
            )}
          </div>

          {/* Beta.28: the links deleted on the canvas, each with Bring back. */}
          <DeletedLinks {...(p.onLinkBack ? { onBack: p.onLinkBack } : {})} />

          <div className="stack">
            <h4 className="hud">{T.export}</h4>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void said(download(`${p.name}.mmd`, toMermaid(p.graph), "text/plain"))
                }
              >
                {T.exports.mermaid}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void said(
                    download(`${p.name}.drawio`, toDrawio(p.graph, p.placed), "application/xml"),
                  )
                }
              >
                {T.exports.drawio}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void said(download(`${p.name}.svg`, toSvg(p.graph, p.placed), "image/svg+xml"))
                }
              >
                {T.exports.svg}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void said(downloadPng(`${p.name}.png`, toSvg(p.graph, p.placed)))}
              >
                {T.exports.png}
              </button>
              {/* A panel opens no print window: there, the SVG is saved and printed from a browser. */}
              {!hostBridge() && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void said(Promise.resolve(printSvg(toSvg(p.graph, p.placed), p.name)))
                  }
                >
                  {T.exports.pdf}
                </button>
              )}
            </div>
            {exported && (
              <p role="status" className="work-say">
                {exported}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** A sample of how a kind of link is drawn: a short line, its pattern and, for the AI's, ◆. */
function LineSample({ by }: { by: LinkBy }) {
  return (
    <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true" focusable="false">
      <line
        x1="1"
        y1="5"
        x2={by === "ai" ? 19 : 27}
        y2="5"
        stroke="currentColor"
        strokeWidth="2"
        {...(by === "person" ? { strokeDasharray: "6 4" } : {})}
        {...(by === "ai" ? { strokeDasharray: "1 4", strokeLinecap: "round" as const } : {})}
      />
      {by === "ai" && <path d="M24 1 L28 5 L24 9 L20 5 Z" fill="currentColor" />}
    </svg>
  );
}

/**
 * ADR 0181: the picture's links counted from code, by a person and by AI, with how each kind is
 * drawn (a legend in shapes and words). Nothing for a picture with no links.
 */
export function LinkKinds({ links }: { links: readonly CanvasLink[] }) {
  if (!links.length) return null;
  const A = COPY.canvasAi;
  // ADR 0192: a build dependency is no call, so it is said apart, never counted with them.
  const deps = links.filter((l) => l.dependency).length;
  const calls = links.filter((l) => !l.dependency);
  return (
    <div className="stack" style={{ gap: 2, margin: "4px 0" }}>
      {calls.length > 0 && (
        <SplitCounts counts={linkCounts(calls)} what={COPY.decisions.counts.links} />
      )}
      <ul
        className="row link-legend"
        aria-label={A.legend}
        style={{ gap: 12, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}
      >
        {(
          [
            ["code", A.legendCode],
            ["person", A.legendPerson],
            ["ai", A.legendAi],
          ] as const
        ).map(([by, words]) => (
          <li
            key={by}
            className={`row work-say${by === "ai" ? " ai-sample" : ""}`}
            style={{ gap: 4 }}
          >
            <LineSample by={by} />
            {words}
          </li>
        ))}
        {deps > 0 && (
          <li className="row work-say" style={{ gap: 4 }}>
            <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true" focusable="false">
              <line
                x1="1"
                y1="5"
                x2="27"
                y2="5"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="8 3 2 3"
              />
            </svg>
            {A.legendDependency(deps)}
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * ADR 0181: the Detected by AI layer's own part of the tools: its legend entry, a filter to show
 * only the AI's links (or every link again), and each AI link as a button that picks it, so a
 * keyboard reaches every AI link without the picture.
 */
export function AiLayer(p: {
  graph: CanvasGraph;
  layers: Layers;
  onLayers(l: Layers): void;
  onPick(link: string): void;
  labelOf(id: string): string;
}) {
  const A = COPY.canvasAi;
  const id = useId();
  const only = isOnlyAi(p.layers);
  const ai = p.graph.links.filter((l) => l.ai);
  return (
    <section className="stack" aria-labelledby={`${id}-ai`} style={{ gap: 4 }}>
      <h4 id={`${id}-ai`} className="hud" style={{ margin: 0 }}>
        <span aria-hidden="true">◆ </span>
        {A.title}
      </h4>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {A.hint}
      </p>
      <p className="row work-say ai-sample" style={{ gap: 4, margin: 0 }}>
        <LineSample by="ai" />
        {A.legendAi}
      </p>
      <div>
        <button
          type="button"
          className={`btn${only ? " primary" : ""}`}
          aria-pressed={only}
          onClick={() => p.onLayers(onlyAi(p.layers))}
        >
          {A.only}
        </button>
      </div>
      {ai.length ? (
        <>
          <p className="work-say" style={{ margin: 0 }}>
            {A.listed(ai.length)}
          </p>
          <ul className="stack" style={{ paddingLeft: 18, margin: 0, gap: 2 }}>
            {ai.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className="link"
                  aria-label={A.pick(p.labelOf(l.from), p.labelOf(l.to))}
                  onClick={() => p.onPick(l.id)}
                >
                  {p.labelOf(l.from)} → {p.labelOf(l.to)}
                </button>{" "}
                <span className="work-say">{l.label}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="work-say" role="status" style={{ margin: 0 }}>
          {only ? A.noneOnly : A.none}
        </p>
      )}
    </section>
  );
}

/** ADR 0180: the component types the picture has, each a badge and a filter on its type. */
export function TypeLegend(p: {
  types: TypeDraws;
  graph: CanvasGraph;
  filter: string;
  onFilter(filter: string): void;
}) {
  const shown = Object.entries(p.types).filter(([id]) =>
    p.graph.boxes.some((b) => b.typeId === id),
  );
  if (!shown.length) return null;
  return (
    <div className="stack">
      <h4 className="hud">{T.types}</h4>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {T.typesHint}
      </p>
      <ul className="type-legend" style={{ paddingLeft: 0, margin: 0, listStyle: "none" }}>
        {shown.map(([id, t]) => {
          // The type token is toggled inside the filter as typed: a team:x stays.
          const words = p.filter.trim().split(/\s+/).filter(Boolean);
          const on = words.includes(`type:${id}`);
          const toggled = on
            ? words.filter((w) => w !== `type:${id}`)
            : [...words.filter((w) => !w.startsWith("type:")), `type:${id}`];
          return (
            <li key={id} className="row" style={{ gap: 6, alignItems: "center" }}>
              <button
                type="button"
                className={`link${on ? " on" : ""}`}
                aria-pressed={on}
                title={t.description}
                onClick={() => p.onFilter(toggled.join(" "))}
              >
                <span
                  className="hud arch-type"
                  style={
                    t.colour ? { borderLeft: `3px solid ${t.colour}`, paddingLeft: 4 } : undefined
                  }
                >
                  {t.badge ?? id}
                </span>{" "}
                {t.name}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
