import { useState, type ReactNode } from "react";
import { isOffline, type Loaded } from "../api/client.js";
import { COPY } from "../copy.js";

/** Shared pieces: panels, the loading/empty/error states every screen needs, and HUD charts. */

export function Panel(p: {
  title?: string;
  meta?: ReactNode;
  kind?: "dark" | "hero";
  span?: string;
  rows?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  const id =
    p.labelledBy ??
    (p.title ? `p-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined);
  return (
    <section
      className={`panel ${p.kind ?? ""}`}
      aria-labelledby={p.title ? id : undefined}
      style={{ gridColumn: p.span, gridRow: p.rows }}
    >
      {p.title && (
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2 id={id} className="h">
            {p.title}
          </h2>
          {p.meta && <span className="hud">{p.meta}</span>}
        </div>
      )}
      {p.children}
    </section>
  );
}

/** Loading, error and empty states, so no screen ever shows a blank or a crash. */
export function View<T>(p: {
  of: Loaded<T> & { reload?: () => void };
  empty?: (d: T) => boolean;
  emptyText?: string;
  /** An empty state with more than words: a link or the command to run. */
  emptyContent?: ReactNode;
  children: (d: T) => ReactNode;
}) {
  if (p.of.state === "loading")
    return (
      <div className="stack" aria-busy="true" aria-live="polite">
        <span className="sr">{COPY.app.loading}</span>
        <div className="skeleton" style={{ width: "80%" }} />
        <div className="skeleton" style={{ width: "60%" }} />
        <div className="skeleton" style={{ width: "70%" }} />
      </div>
    );
  // "Scan first" and the like: an empty state that names the step, not an error.
  if (p.of.state === "error" && p.of.notYet) return <div className="state">{p.of.error}</div>;
  if (p.of.state === "error") return <LoadError error={p.of.error} retry={p.of.reload} />;
  if (p.empty?.(p.of.data))
    return p.emptyContent !== undefined ? (
      <>{p.emptyContent}</>
    ) : (
      <div className="state">{p.emptyText ?? "Nothing here yet."}</div>
    );
  return <>{p.children(p.of.data)}</>;
}

/** Why a load failed, in words, with Try again when the call can be run again. */
export function LoadError({ error, retry }: { error: string; retry?: (() => void) | undefined }) {
  return (
    <div className="state error" role="alert">
      <p style={{ margin: 0 }}>
        {COPY.app.cantLoad(isOffline(error) ? COPY.app.offlineShort : error)}
      </p>
      {retry && (
        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={retry}>
          {COPY.app.tryAgain}
        </button>
      )}
    </div>
  );
}

/**
 * A link that leaves the app (a PR, a wiki page, a service-desk ticket): in a browser it opens a
 * new tab so the app stays where it was; in a VS Code panel the editor opens it, with its own
 * prompt. The words say so, never the icon alone.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="sr"> {COPY.app.newTab}</span>
    </a>
  );
}

/**
 * A button that loads a view again, and says it did: "Checking…" while the call runs, then the
 * time it answered. Without it a reload that finds nothing new looks like a dead click.
 */
export function CheckAgain(p: {
  of: { reload: () => void; refreshing: boolean; at?: number };
  label: string;
  /** What the button runs, when it is more than loading the same call again. */
  run?: () => void;
}) {
  const [asked, setAsked] = useState(false);
  return (
    <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn"
        disabled={p.of.refreshing}
        onClick={() => {
          setAsked(true);
          (p.run ?? p.of.reload)();
        }}
      >
        {p.of.refreshing ? COPY.app.checking : p.label}
      </button>
      <span role="status" className="muted" style={{ fontSize: 12 }}>
        {asked && !p.of.refreshing && p.of.at
          ? COPY.app.checkedAt(new Date(p.of.at).toTimeString().slice(0, 8))
          : ""}
      </span>
    </span>
  );
}

/** A ring gauge with a label inside: value of max. */
export function Ring(p: {
  value: number;
  max: number;
  size?: number;
  color?: string;
  label: string;
  text?: string;
}) {
  const size = p.size ?? 56;
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const frac = p.max > 0 ? Math.min(p.value / p.max, 1) : 0;
  return (
    <svg role="img" aria-label={p.label} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={p.color ?? "var(--accent)"}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: `drop-shadow(0 0 var(--glow-size) ${p.color ?? "var(--accent)"})` }}
      />
      <text
        x={size / 2}
        y={size / 2 + 5}
        textAnchor="middle"
        fill="var(--text)"
        fontFamily="Rajdhani, sans-serif"
        fontWeight={700}
        fontSize={size / 4}
      >
        {p.text ?? `${p.value}/${p.max}`}
      </text>
    </svg>
  );
}

/** A donut of parts, with a legend that carries the words (colour is never the only signal). */
export function Donut(p: {
  parts: { label: string; value: number; color: string }[];
  title: string;
}) {
  const total = p.parts.reduce((a, b) => a + b.value, 0);
  const r = 26;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="row" style={{ gap: 12 }}>
      <svg
        role="img"
        aria-label={`${p.title}: ${p.parts.map((x) => `${x.label} ${x.value}`).join(", ")}`}
        width={70}
        height={70}
        viewBox="0 0 70 70"
      >
        <circle cx={35} cy={35} r={r} fill="none" stroke="var(--track)" strokeWidth={10} />
        {p.parts.map((x) => {
          const len = total ? (x.value / total) * c : 0;
          const el = (
            <circle
              key={x.label}
              cx={35}
              cy={35}
              r={r}
              fill="none"
              stroke={x.color}
              strokeWidth={10}
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 35 35)"
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 5,
          fontSize: 11.5,
        }}
      >
        {p.parts.map((x) => (
          <li key={x.label} className="row" style={{ gap: 6 }}>
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: 2, background: x.color }}
            />
            {x.label} {x.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Bar(p: { value: number; max: number; color?: string; label: string }) {
  const pct = p.max > 0 ? Math.round((p.value / p.max) * 100) : 0;
  return (
    <div role="img" aria-label={`${p.label}: ${p.value} of ${p.max}`} className="track">
      <span
        style={{
          width: `${pct}%`,
          background: p.color,
          boxShadow: p.color ? `0 0 10px ${p.color}` : undefined,
        }}
      />
    </div>
  );
}
