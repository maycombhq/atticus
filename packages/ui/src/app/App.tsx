import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../api/client.js";
import { SCREEN_COMPONENTS } from "../screens/registry.js";
import { NotBuilt } from "../screens/NotBuilt.js";
import { ScreenBoundary } from "./boundary.js";
import { MeProvider, useMe } from "./me.js";
import { CommandPalette } from "./palette.js";
import { replayTour, Tour } from "./tour.js";
import { Nav } from "./nav.js";
import { screenOf } from "./screens.js";

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

/** Who Atticus records you as: your Git user, with a warning when the OS user stood in. */
function Person({ health }: { health: Health }) {
  const { me } = useMe();
  const who = me?.name ? `${me.name} (${health.user})` : health.user;
  return (
    <>
      {me?.warning && (
        <span className="chip warn" title={me.warning} role="note" aria-label={me.warning}>
          SET YOUR GIT USER
        </span>
      )}
      <span
        className="chip dim"
        title={`${health.root}${me?.email ? ` · ${me.email}` : ""} · recorded as ${health.user}`}
      >
        {who} · v{health.version}
      </span>
    </>
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
      <button type="button" className="btn" onClick={replayTour} title="Replay the tour">
        Help
      </button>
      <span className="hud" style={{ fontSize: 9.5, whiteSpace: "nowrap" }} aria-hidden="true">
        Ctrl K
      </span>
      {health && <Person health={health} />}
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
