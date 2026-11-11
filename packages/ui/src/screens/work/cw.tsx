import { useId, useState, type ReactNode } from "react";
import { COPY } from "../../copy.js";
import "./cw.css";

/**
 * beta.26: the change and work screens in the IDE look (cw- classes, cw.css). A screen of a
 * change sits in a ChangeWork; its head says which change (title, its id under it, the stage as a
 * badge) with the page's few actions grouped at its end; a long explanation is cut to two lines
 * with More beside it, its words whole in the page for a screen reader.
 */

const W = COPY.changeWork;

/** The root of a change or work screen: the scope cw.css styles. */
export function ChangeWork({ children }: { children: ReactNode }) {
  return <div className="cw">{children}</div>;
}

/** A change page's head: its name, the id and words under it, badges, then the grouped actions. */
export function CwHead(p: {
  title: string;
  /** A muted monospace line under the title (the change's id, its type). */
  sub?: ReactNode;
  /** Chips beside the title: the stage, the risk. */
  badges?: ReactNode;
  /** The page's actions and links, grouped at the end (the change picker last). */
  actions?: ReactNode;
}) {
  return (
    <header className="cw-head">
      <div className="cw-head-name">
        <p className="cw-title" title={p.title}>
          {p.title}
        </p>
        {(p.sub || p.badges) && (
          <div className="cw-head-sub">
            {p.sub && <span className="cw-sub">{p.sub}</span>}
            {p.badges}
          </div>
        )}
      </div>
      {p.actions && <div className="cw-head-actions">{p.actions}</div>}
    </header>
  );
}

const C = COPY.changes;
const PHASE_WORD: Record<string, string> = {
  define: C.define,
  design: C.design,
  plan: C.plan,
  build: C.build,
  qa: C.qa,
  "release-ready": C.release,
};

/** The phase a change is in, as a badge; Blocked when a blocking finding is open. */
export function StageBadge({ state, blocked }: { state: string; blocked?: boolean }) {
  return (
    <span className={`chip ${blocked ? "blocking" : "warn"} cw-badge`}>
      {blocked ? C.blocked : (PHASE_WORD[state] ?? state)}
    </span>
  );
}

/** Words longer than this are cut to two lines until More is pressed. */
export const EXPLAIN_FOLD = 140;

/**
 * A panel's explanation: whole when short; else two lines and More (aria-expanded), the words all
 * in the page either way, so a screen reader reads them whole and Ctrl+F finds them.
 */
export function Explain({ children, text }: { children?: ReactNode; text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = text.length > EXPLAIN_FOLD;
  return (
    <div className={`cw-explain${long && !open ? " cut" : ""}`}>
      <p id={`${id}-x`} className="cw-explain-text">
        {children ?? text}
      </p>
      {long && (
        <button
          type="button"
          className="cw-more"
          aria-expanded={open}
          aria-controls={`${id}-x`}
          onClick={() => setOpen(!open)}
        >
          {open ? W.less : W.more}
        </button>
      )}
    </div>
  );
}
