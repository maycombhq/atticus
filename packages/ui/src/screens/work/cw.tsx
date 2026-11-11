import { useId, useState, type ReactNode } from "react";
import type { LifecycleState } from "@maycombhq/core";
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
        {/* beta.26 review: the whole name, wrapped, not cut with only a hover title to read it. */}
        <p className="cw-title">{p.title}</p>
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
/** A word for every lifecycle state; the type makes a state added in core without one fail. */
const STATE_WORD: Record<LifecycleState, string> = W.lifecycle;

/**
 * beta.26 review: the states that wait on someone (go/no-go, the lenses after an early release,
 * the product owner's) show in amber; a change moving through its phases, or done, stays quiet.
 */
export const NEEDS_ATTENTION: ReadonlySet<string> = new Set<LifecycleState>([
  "release-ready",
  "post-release-review",
  "returned",
]);

/** The state a change is in, as a badge, in words; Blocked when a blocking finding is open. */
export function StageBadge({ state, blocked }: { state: string; blocked?: boolean }) {
  const tone = blocked ? "blocking" : NEEDS_ATTENTION.has(state) ? "warn" : "dim";
  return (
    <span className={`chip ${tone} cw-badge`}>
      {blocked ? C.blocked : (STATE_WORD[state as LifecycleState] ?? state)}
    </span>
  );
}

/** Words longer than this are cut to two lines until More is pressed. */
export const EXPLAIN_FOLD = 140;

/** An explanation's first words, to name its More when no panel name is given. */
function leadOf(text: string): string {
  const words = text.trim().split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : words.join(" ");
}

/**
 * A panel's explanation: whole when short; else two lines and More (aria-expanded), the words all
 * in the page either way, so a screen reader reads them whole and Ctrl+F finds them. More's name
 * says what it opens (`about`, else the first words), so two on one page are told apart.
 */
export function Explain({
  children,
  text,
  about,
}: {
  children?: ReactNode;
  text: string;
  /** What the explanation is about (its panel's name), for More's accessible name. */
  about?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = text.length > EXPLAIN_FOLD;
  const what = about ?? leadOf(text);
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
          aria-label={open ? W.lessAbout(what) : W.moreAbout(what)}
          onClick={() => setOpen(!open)}
        >
          {open ? W.less : W.more}
        </button>
      )}
    </div>
  );
}
