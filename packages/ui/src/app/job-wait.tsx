import { COPY } from "../copy.js";

const W = COPY.app.jobWait;

/**
 * Beta.28.1 (the owner's field reports 2 and 3): a wait that can take minutes says what it is
 * doing (the job's last line) and offers Stop, so nothing slow runs silently. `what` is the
 * wait's own words ("Reading the calls and APIs…"); the line follows, as the job prints it.
 */
export function JobWait(p: {
  what: string;
  line?: string | undefined;
  onStop?: (() => void) | undefined;
  stopping?: boolean | undefined;
}) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p role="status" aria-busy="true" className="ev-say" style={{ margin: 0 }}>
        {p.what}
      </p>
      {p.line && (
        <p className="ev-say mono" aria-live="polite" style={{ margin: 0 }}>
          {W.now(p.line)}
        </p>
      )}
      {p.onStop && (
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn"
            onClick={p.onStop}
            disabled={!!p.stopping}
            aria-busy={!!p.stopping}
            aria-label={W.stopLabel(p.what)}
          >
            {p.stopping ? W.stopping : W.stop}
          </button>
        </div>
      )}
    </div>
  );
}

/** A wait the person stopped: said so, with Start it again (beta.28.1). */
export function JobStoppedNote(p: { onAgain?: (() => void) | undefined }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p role="status" className="ev-say" style={{ margin: 0 }}>
        {W.stopped}
      </p>
      {p.onAgain && (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn" onClick={p.onAgain}>
            {W.again}
          </button>
        </div>
      )}
    </div>
  );
}
