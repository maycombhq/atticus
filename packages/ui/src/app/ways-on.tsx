import { useState } from "react";
import { COPY } from "../copy.js";

const W = COPY.waysOn;
const TX = COPY.runShared;

/** Set up › Catalog builds, opened at its Undo (the files it puts back are listed first). */
export const UNDO_HREF = "#/catalog-builds?at=undo";

/**
 * Beta.30, slice 2: what an error state offers, each something that exists today. Undo the last
 * build is Catalog builds' undo. Build again is the caller's own step (`onAgain`) or the page
 * that builds (`againHref`), only where a build is what failed. A support bundle is saved from a
 * terminal (`atticus support bundle`; no route of the local API runs it), so its command is
 * offered to copy. `short`: inside a panel, the buttons without the sentences. Nothing here
 * imports a screen: the app's own error boundary shows it.
 */
export function ErrorWaysOn(p: {
  onAgain?: (() => void) | undefined;
  againHref?: string | undefined;
  short?: boolean;
  /** A link here was followed (the app's boundary lets go of its error). */
  onGo?: (() => void) | undefined;
}) {
  const [done, setDone] = useState<"copied" | "failed" | undefined>();
  return (
    <div
      className="stack"
      role="group"
      aria-label={W.label}
      style={{ gap: 6, marginTop: 8, textAlign: "start" }}
    >
      {!p.short && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.undoWhy}
        </p>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {p.onAgain && (
          <button type="button" className="btn" onClick={p.onAgain}>
            {W.buildAgain}
          </button>
        )}
        {!p.onAgain && p.againHref && (
          <a className="btn" href={p.againHref} onClick={p.onGo}>
            {W.buildAgainOn}
          </a>
        )}
        <a className="btn" href={UNDO_HREF} onClick={p.onGo}>
          {W.undoLast}
        </a>
      </div>
      {!p.short && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.supportWhy}
        </p>
      )}
      <div className="work-cmd">
        <code className="mono">{W.supportCommand}</code>
        <button
          type="button"
          className="btn run-copy"
          aria-label={W.copySupportLabel(W.supportCommand)}
          onClick={() => {
            const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
            if (!clip) setDone("failed");
            else
              clip.writeText(W.supportCommand).then(
                () => setDone("copied"),
                () => setDone("failed"),
              );
            setTimeout(() => setDone(undefined), 2000);
          }}
        >
          {done === "copied" ? TX.copied : done === "failed" ? TX.selectAndCopy : W.copySupport}
        </button>
      </div>
    </div>
  );
}
