import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../api/client.js";
import { SCREEN_COMPONENTS } from "../screens/registry.js";
import { NotBuilt } from "../screens/NotBuilt.js";
import { ScreenBoundary } from "./boundary.js";
import { MeProvider, useMe, ViewPicker } from "./me.js";
import { CommandPalette } from "./palette.js";
import { replayTour, Tour } from "./tour.js";
import { screensFor } from "./roles.js";
import { GROUPS, SCREENS, screenOf, type ScreenDef } from "./screens.js";

interface Health {
  version: string;
  root: string;
  user: string;
}

function useHash(): string {
  const [h, set] = useState(location.hash);
  useEffect(() => {
    const on = () => set(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

function Logo() {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26">
      <polygon
        points="13,2 24,8 24,18 13,24 2,18 2,8"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        style={{ filter: "drop-shadow(0 0 4px #2EE6F6)" }}
      />
      <path
        d="M8 18 L13 7 L18 18 M10 14 H16"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function Nav({ current }: { current: ScreenDef }) {
  const { me } = useMe();
  const mine = screensFor(me?.view ?? null, me?.roles ?? []);
  const inMine = mine.includes(current.id);
  return (
    <nav aria-label="Main" className="nav">
      <div className="brand">
        <Logo />
        ATTICUS
      </div>
      <div style={{ padding: "4px 12px 8px" }}>
        <ViewPicker id="view-picker" compact />
      </div>
      <div role="group" aria-label="Your screens">
        <div className="group">My work</div>
        {mine.map((id) => {
          const s = SCREENS.find((x) => x.id === id)!;
          return (
            <a key={id} href={`#/${id}`} aria-current={id === current.id ? "page" : undefined}>
              {s.label}
            </a>
          );
        })}
      </div>
      <details className="all-screens" open={!inMine || undefined}>
        <summary className="group">All screens · {SCREENS.length}</summary>
        {GROUPS.map((g) => (
          <div key={g} role="group" aria-label={g}>
            <div className="group sub">{g}</div>
            {SCREENS.filter((s) => s.group === g).map((s) => (
              <a
                key={s.id}
                href={`#/${s.id}`}
                aria-current={s.id === current.id && !inMine ? "page" : undefined}
              >
                {s.label}
              </a>
            ))}
          </div>
        ))}
      </details>
      <a className="ask" href="#/explore">
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 8px var(--accent)",
          }}
        />
        Ask Atticus
      </a>
    </nav>
  );
}

/** Shows when AI is limited here, so nobody wonders why an AI button is missing. */
function AiChip() {
  const { me } = useMe();
  if (!me || me.ai === "on") return null;
  return (
    <span
      className="chip warn"
      title={
        me.ai === "off"
          ? "AI is off in this organisation: no AI step runs; people write and the rule checks review."
          : "Image reading is off: pictures go to a person in Intake."
      }
    >
      {me.ai === "off" ? "AI OFF" : "TEXT-ONLY AI"}
    </span>
  );
}

function TopBar({ health }: { health?: Health }) {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) location.hash = `#/explore?ask=${encodeURIComponent(q.trim())}`;
  };
  return (
    <header className="topbar">
      <form role="search" className="ask-form" onSubmit={submit}>
        <label htmlFor="ask" className="sr">
          Ask Atticus
        </label>
        <input
          id="ask"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask: what breaks if ledger-db.account changes?"
        />
        <button type="submit" className="btn" aria-label="Ask">
          Ask
        </button>
      </form>
      <AiChip />
      <button
        type="button"
        className="btn"
        onClick={replayTour}
        title="Replay the tour of your view"
      >
        Help
      </button>
      <span className="hud" style={{ fontSize: 9.5, whiteSpace: "nowrap" }} aria-hidden="true">
        Ctrl K
      </span>
      {health && (
        <span className="chip dim" title={health.root}>
          {health.user} · v{health.version}
        </span>
      )}
    </header>
  );
}

export function App() {
  const hash = useHash();
  const current = screenOf(hash);
  const health = useApi<Health>("/api/health");
  useEffect(() => {
    document.title = `${current.label} · Atticus`;
  }, [current]);
  return (
    <MeProvider>
      <div className="shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Nav current={current} />
        <CommandPalette />
        <Tour />
        <main id="main" className="main" tabIndex={-1}>
          <TopBar health={health.state === "ready" ? health.data : undefined} />
          <h1 className="sr">{current.label}</h1>
          {(() => {
            const S = SCREEN_COMPONENTS[current.id];
            return S ? (
              <ScreenBoundary key={current.id} name={current.label}>
                <S hash={hash} />
              </ScreenBoundary>
            ) : (
              <NotBuilt screen={current} />
            );
          })()}
        </main>
      </div>
    </MeProvider>
  );
}
