import type { ReactNode } from "react";
import type { Loaded } from "../api/client.js";

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
  of: Loaded<T>;
  empty?: (d: T) => boolean;
  emptyText?: string;
  children: (d: T) => ReactNode;
}) {
  if (p.of.state === "loading")
    return (
      <div className="stack" aria-busy="true" aria-live="polite">
        <span className="sr">Loading</span>
        <div className="skeleton" style={{ width: "80%" }} />
        <div className="skeleton" style={{ width: "60%" }} />
        <div className="skeleton" style={{ width: "70%" }} />
      </div>
    );
  if (p.of.state === "error")
    return (
      <div className="state error" role="alert">
        Couldn't load this: {p.of.error}
      </div>
    );
  if (p.empty?.(p.of.data))
    return <div className="state">{p.emptyText ?? "Nothing here yet."}</div>;
  return <>{p.children(p.of.data)}</>;
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
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1A2330" strokeWidth={4} />
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
        style={{ filter: `drop-shadow(0 0 4px ${p.color ?? "#2EE6F6"})` }}
      />
      <text
        x={size / 2}
        y={size / 2 + 5}
        textAnchor="middle"
        fill="#E9F6FA"
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
        <circle cx={35} cy={35} r={r} fill="none" stroke="#1A2330" strokeWidth={10} />
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
