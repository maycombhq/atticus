import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, SERVER_EVENT, useApi } from "../api/client.js";
import { hostBridge } from "../api/bridge.js";
import { COPY } from "../copy.js";
import { SCREEN_COMPONENTS } from "../screens/registry.js";
import { NotBuilt } from "../screens/NotBuilt.js";
import { ScreenBoundary } from "./boundary.js";
import { MeProvider, useMe } from "./me.js";
import { CommandPalette } from "./palette.js";
import { replayTour, Tour } from "./tour.js";
import { Nav } from "./nav.js";
import { screenOf } from "./screens.js";
import { SectionTabs } from "./tabs.js";
import { inEditor, THEME_CHOICES, useTheme, type ThemeChoice } from "./theme.js";

const T = COPY.shell;

interface Health {
  version: string;
  root: string;
  user: string;
  /** `atticus ui --full`: every page in the menu, not only the six entries. */
  full?: boolean;
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
    <span className="chip warn" title={me.ai === "off" ? T.aiIsOffIn : T.imageReadingIsOff}>
      {me.ai === "off" ? T.aiOff : T.textOnlyAi}
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
          {T.setYourGitUser}
        </span>
      )}
      <span
        className="chip dim"
        title={T.recordedAs(health.root, me?.email ? ` · ${me.email}` : "", health.user)}
      >
        {who} · v{health.version}
      </span>
    </>
  );
}

/** System, light or dark, remembered in this browser. A VS Code panel follows the editor. */
function ThemeSwitch() {
  const [choice, setChoice] = useTheme();
  return (
    <span className="row" style={{ gap: 6 }}>
      <label htmlFor="theme" className="hud" style={{ fontSize: 9.5 }}>
        {COPY.theme.label}
      </label>
      <select
        id="theme"
        className="field"
        style={{ height: 28, fontSize: 12 }}
        title={COPY.theme.hint}
        value={choice}
        onChange={(e) => setChoice(e.target.value as ThemeChoice)}
      >
        {THEME_CHOICES.map((c) => (
          <option key={c} value={c}>
            {COPY.theme.choices[c]}
          </option>
        ))}
      </select>
    </span>
  );
}

/** One row of GET /api/search. */
interface SearchPage {
  rows: { id: string }[];
}

/**
 * The Ask box's example, from the person's own catalog: a real table, else a real entry point;
 * neutral while it loads, when it fails, and when the catalog has neither (a real metarepo,
 * 2026-10-25: every user was shown a Forge example).
 */
export function askExample(tables?: SearchPage, entries?: SearchPage): string {
  const id = tables?.rows[0]?.id ?? entries?.rows[0]?.id;
  return id ? T.askWhatBreaksIf(id) : T.askNeutral;
}

function useAskExample(): string {
  const tables = useApi<SearchPage>("/api/search?q=kind:table&limit=1");
  const none = tables.state === "error" || (tables.state === "ready" && !tables.data.rows.length);
  const entries = useApi<SearchPage>(none ? "/api/search?q=kind:endpoint&limit=1" : undefined);
  return askExample(
    tables.state === "ready" ? tables.data : undefined,
    entries.state === "ready" ? entries.data : undefined,
  );
}

function TopBar({ health }: { health?: Health }) {
  const example = useAskExample();
  const [q, setQ] = useState("");
  const [blank, setBlank] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // An empty Ask says what it needs instead of doing nothing.
    if (!q.trim()) {
      setBlank(true);
      document.getElementById("ask")?.focus();
      return;
    }
    location.hash = `#/explore?ask=${encodeURIComponent(q.trim())}`;
  };
  return (
    <header className="topbar">
      <form role="search" className="ask-form" onSubmit={submit}>
        <label htmlFor="ask" className="sr">
          {T.askAtticus}
        </label>
        <input
          id="ask"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setBlank(false);
          }}
          aria-describedby={blank ? "ask-blank" : undefined}
          placeholder={example}
        />
        <button type="submit" className="btn" aria-label={T.ask}>
          {T.ask}
        </button>
        <span id="ask-blank" role="status" className={blank ? "chip warn" : "sr"}>
          {blank ? COPY.app.askEmpty : ""}
        </span>
      </form>
      <AiChip />
      {!hostBridge() && !inEditor() && <ThemeSwitch />}
      <button type="button" className="btn" onClick={replayTour} title={T.replayTheTour}>
        {T.help}
      </button>
      <a className="btn" href="#/words" title={COPY.glossary.linkTitle}>
        {COPY.glossary.link}
      </a>
      <span className="hud" style={{ fontSize: 9.5, whiteSpace: "nowrap" }} aria-hidden="true">
        {T.ctrlK}
      </span>
      {health && <Person health={health} />}
    </header>
  );
}

/**
 * Whether the local server answers. While it doesn't, one note at the top says why and how to
 * start it again (each panel then only says it couldn't load); when it answers again, the
 * screen loads afresh. `epoch` counts the comebacks.
 */
function useServer(): { down: boolean; epoch: number } {
  const [s, set] = useState({ down: false, epoch: 0 });
  useEffect(() => {
    const on = (e: Event) => {
      const up = (e as CustomEvent<{ up: boolean }>).detail.up;
      set((o) => (up ? { down: false, epoch: o.epoch + 1 } : { ...o, down: true }));
    };
    addEventListener(SERVER_EVENT, on);
    return () => removeEventListener(SERVER_EVENT, on);
  }, []);
  return s;
}

export function ServerDown({ inPanel }: { inPanel: boolean }) {
  const [trying, setTrying] = useState(false);
  return (
    <div className="state error" role="alert" style={{ marginBottom: 12 }}>
      <p style={{ margin: 0 }}>{inPanel ? COPY.app.offlinePanel : COPY.app.offline}</p>
      <button
        type="button"
        className="btn"
        style={{ marginTop: 8 }}
        disabled={trying}
        onClick={() => {
          setTrying(true);
          // Any answer tells the app the server is back, and the screen loads again.
          void api("/api/health")
            .catch(() => undefined)
            .finally(() => setTrying(false));
        }}
      >
        {trying ? COPY.app.checking : COPY.app.tryAgain}
      </button>
    </div>
  );
}

export function App() {
  const hash = useHash();
  const current = screenOf(hash);
  const health = useApi<Health>("/api/health");
  // The server says whether it was started with --full; until it answers, the six.
  const full = health.state === "ready" && health.data.full === true;
  const server = useServer();
  const reloadHealth = health.reload;
  useEffect(() => {
    if (server.epoch) reloadHealth();
  }, [server.epoch, reloadHealth]);
  useEffect(() => {
    document.title = `${current.label} · Atticus`;
  }, [current]);
  // WP5.6: on moving to another screen, focus goes to its content (not on the first load), so a
  // keyboard or screen reader user starts there rather than back in the menu.
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (shown.current !== undefined && shown.current !== current.id)
      document.getElementById("main")?.focus({ preventScroll: true });
    shown.current = current.id;
  }, [current.id]);
  return (
    <MeProvider>
      <div className="shell">
        <a className="skip" href="#main">
          {T.skipToContent}
        </a>
        <Nav current={current} full={full} />
        <CommandPalette full={full} />
        <Tour
          metarepo={
            health.state === "ready"
              ? health.data.root
              : health.state === "error"
                ? null
                : undefined
          }
        />
        <main id="main" className="main" tabIndex={-1}>
          <TopBar health={health.state === "ready" ? health.data : undefined} />
          <h1 className="sr">{current.label}</h1>
          <SectionTabs current={current} hash={hash} full={full} />
          {server.down && <ServerDown inPanel={!!hostBridge()} />}
          {(() => {
            const S = SCREEN_COMPONENTS[current.id];
            return S ? (
              <ScreenBoundary key={`${current.id}:${server.epoch}`} name={current.label}>
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
