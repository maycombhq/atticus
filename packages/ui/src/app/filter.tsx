import { COPY } from "../copy.js";

/**
 * One filter wherever a list grows (ADR 0105 addendum): the same box, label, placeholder and
 * matching on every screen, and in the VS Code extension. An item matches when every word of
 * the filter is in one of its fields (its title, id, change or repo), case aside.
 */

const F = COPY.filter;

export { filterWords, matchesWords } from "./match.js";

/** What a filter filtered, in words: “ledger” in forge-notes. */
export function filteredWhat(o: {
  text?: string;
  repo?: string;
  change?: string;
  kind?: string;
}): string {
  return [
    o.text?.trim() ? F.words(o.text.trim()) : "",
    o.kind ? F.among(o.kind) : "",
    o.repo ? F.inRepo(o.repo) : "",
    o.change ? F.inChange(o.change) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The filter box: a labelled field with the shared placeholder. */
export function FilterBox(p: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  grow?: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 4, ...(p.grow ? { flex: "1 1 200px" } : {}) }}>
      <label htmlFor={p.id} className="hud" style={{ fontSize: 10 }}>
        {F.label}
      </label>
      <input
        id={p.id}
        className="field"
        value={p.value}
        placeholder={F.placeholder}
        autoComplete="off"
        onChange={(e) => p.onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * How many the filter shows, said politely to a screen reader. The live region is always on the
 * page, so the first count after typing is announced; it holds words only while filtering.
 */
export function FilterCount(p: { shown: number; total: number; active: boolean }) {
  return (
    <p className="hud" aria-live="polite" style={{ margin: 0, fontSize: 10, minHeight: "1em" }}>
      {p.active ? F.shown(p.shown, p.total) : ""}
    </p>
  );
}

/** Nothing matches: what was filtered, and a button that clears it and goes back to the box. */
export function FilterEmpty(p: { what: string; onClear: () => void; focus?: string }) {
  return (
    <div className="state stack" style={{ gap: 8, alignItems: "flex-start" }}>
      <span>{F.nothingMatches(p.what)}</span>
      <button
        type="button"
        className="btn"
        onClick={() => {
          p.onClear();
          if (p.focus) document.getElementById(p.focus)?.focus();
        }}
      >
        {F.clear}
      </button>
    </div>
  );
}
