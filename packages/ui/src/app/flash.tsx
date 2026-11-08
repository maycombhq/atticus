import { useEffect, useState } from "react";
import { COPY } from "../copy.js";

/**
 * Fourth UX walk: a word that outlives the panel that said it. Apply on a correction re-reads
 * the facts, so the panel with its result goes; what it did, and where to propose it, stays here
 * until the person moves on or closes it.
 */
type Flash = { text: string; href?: string; link?: string };
let current: Flash | undefined;
const listeners = new Set<() => void>();

export function flash(f: Flash | undefined): void {
  current = f;
  for (const l of listeners) l();
}

export function FlashLine() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (!current) return null;
  const f = current;
  return (
    <div role="status" className="row" style={{ gap: 8, alignItems: "center", margin: "0 0 8px" }}>
      <span>{f.text}</span>
      {f.href && f.link && (
        <a href={f.href} onClick={() => flash(undefined)}>
          {f.link}
        </a>
      )}
      <button type="button" className="btn" onClick={() => flash(undefined)}>
        {COPY.app.dismiss}
      </button>
    </div>
  );
}
