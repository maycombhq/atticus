import { COPY } from "../../copy.js";

const T = COPY.ide;

/** The metarepo's folder name, from its path (either slash). */
export const folderOf = (root: string): string =>
  root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || root;

export interface StatusFacts {
  /** The metarepo's path, from /api/health. */
  root?: string;
  version?: string;
  apiVersion?: string;
  /** Who Atticus records the person as, and the role they picked, when they did. */
  user?: string;
  role?: string;
  /** Counts the app has loaded already (never asked for by the bar): undefined until then. */
  repos?: number;
  questions?: number;
  /** The first thing running (the Console's), how far it is, and how many more run. */
  running?: { id: string; title: string; done?: number; total?: number; more: number };
}

/**
 * The status bar (ADR 0194), at the foot: the metarepo, how many repos and open questions, what
 * runs (a click opens it in the Console), the local API's version, who you are, the version.
 * Counts show once a page has loaded them; the bar asks the server for nothing.
 */
export function StatusBar({
  facts,
  onShowRunning,
}: {
  facts: StatusFacts;
  onShowRunning?: (id: string) => void;
}) {
  const r = facts.running;
  return (
    <footer className="sh-status" aria-label={T.status}>
      {facts.root && (
        <span className="sh-status-item sh-mono" title={facts.root}>
          {folderOf(facts.root)}
        </span>
      )}
      {facts.repos !== undefined && (
        <a className="sh-status-item" href="#/trust">
          {T.repos(facts.repos)}
        </a>
      )}
      {facts.questions !== undefined && (
        <a className="sh-status-item" href="#/questions">
          {T.questions(facts.questions)}
        </a>
      )}
      {r && (
        <button type="button" className="sh-status-item" onClick={() => onShowRunning?.(r.id)}>
          <span className="sh-spin" aria-hidden="true" />
          {T.running(r.title)}
          {r.total ? ` ${T.step(r.done ?? 0, r.total)}` : ""}
          {r.more > 0 ? ` ${T.alsoRunning(r.more)}` : ""}
        </button>
      )}
      <span className="sh-grow" aria-hidden="true" />
      {facts.apiVersion && <span className="sh-status-item sh-low">{T.api(facts.apiVersion)}</span>}
      {facts.user && <span className="sh-status-item">{T.who(facts.user, facts.role)}</span>}
      {facts.version && (
        <span className="sh-status-item sh-mono sh-low">{T.version(facts.version)}</span>
      )}
    </footer>
  );
}
