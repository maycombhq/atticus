import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi } from "../../api/client.js";
import { hostBridge } from "../../api/bridge.js";
import { COPY } from "../../copy.js";
import type { CanvasGraph } from "./model.js";
import { WORDS } from "./words.js";
import {
  LAYERS,
  inbox,
  toDrawio,
  toMermaid,
  toSvg,
  trace,
  type Direction,
  type Layers,
  type Placed,
  type Snapshot,
} from "./tools.js";

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

function printSvg(svg: string, title: string) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.title = title;
  w.document.body.innerHTML = svg;
  w.focus();
  w.print();
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
  labelOf(id: string): string;
  placed(id: string): Placed | undefined;
  /** What a kept view stands for. */
  lens: string;
  node: string;
  /** The links counted from the snapshot. */
  compared?: { added: number; removed: Snapshot["links"] };
  snapshot?: Snapshot;
  onSnapshot(): void;
  name: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
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
        `/api/graph/views/${encodeURIComponent(viewName)}`,
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
    } finally {
      setKeeping(false);
    }
  };
  return (
    <section className="canvas-tools" aria-labelledby={`${id}-t`}>
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
                  onClick={() => printSvg(toSvg(p.graph, p.placed), p.name)}
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
