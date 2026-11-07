import { useEffect, useState } from "react";
import { BUSY_EVENT, requestsInFlight } from "../api/client.js";
import { COPY } from "../copy.js";

/**
 * beta.21: a thin bar across the top of the app whenever any request is in flight, however
 * short, so nothing a person clicks ever looks like it did nothing. Said once to screen readers
 * as loading; it moves only when the person allows motion.
 */
export function LoadingBar() {
  const [n, setN] = useState(requestsInFlight());
  useEffect(() => {
    const on = (e: Event) => setN((e as CustomEvent<number>).detail);
    addEventListener(BUSY_EVENT, on);
    return () => removeEventListener(BUSY_EVENT, on);
  }, []);
  return (
    <div className={`loading-bar${n > 0 ? " on" : ""}`} aria-hidden={n === 0}>
      {n > 0 && (
        <div
          role="progressbar"
          aria-label={COPY.app.loading}
          aria-busy="true"
          className="loading-bar-run"
        />
      )}
    </div>
  );
}

/** A bar inside a panel that is still waiting for its answer. */
export function PanelBar() {
  return (
    <div className="loading-bar inline on" aria-hidden="true">
      <div className="loading-bar-run" />
    </div>
  );
}
