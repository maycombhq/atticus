import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../api/client.js";
import { SCREEN_COMPONENTS } from "../screens/registry.js";
import { NotBuilt } from "../screens/NotBuilt.js";
import { ScreenBoundary } from "./boundary.js";
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
  return (
    <nav aria-label="Main" className="nav">
      <div className="brand">
        <Logo />
        ATTICUS
      </div>
      {GROUPS.map((g) => (
        <div key={g} role="group" aria-label={g}>
          <div className="group">{g}</div>
          {SCREENS.filter((s) => s.group === g).map((s) => (
            <a
              key={s.id}
              href={`#/${s.id}`}
              aria-current={s.id === current.id ? "page" : undefined}
            >
              {s.label}
            </a>
          ))}
        </div>
      ))}
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

function TopBar({ health }: { health?: Health }) {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    location.hash = `#/explore?q=${encodeURIComponent(q)}`;
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
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav current={current} />
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
  );
}
