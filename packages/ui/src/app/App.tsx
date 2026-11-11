import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FlashLine } from "./flash.js";
import { LoadingBar } from "./loading-bar.js";
import { api, SERVER_EVENT, useApi } from "../api/client.js";
import { hostBridge } from "../api/bridge.js";
import { COPY } from "../copy.js";
import { SCREEN_COMPONENTS } from "../screens/registry.js";
import { NotBuilt } from "../screens/NotBuilt.js";
import { CreateMetarepo } from "../screens/setup/CreateMetarepo.js";
import { ScreenBoundary } from "./boundary.js";
import { MeProvider } from "./me.js";
import { CopilotRunsProvider } from "./copilot-runs.js";
import { ActivityConsole, ActivityProvider, ActivityStrip } from "./activity.js";
import { DecisionsProvider } from "./decisions.js";
import { AiChip, Person, ThemeSwitch, useAskExample, type Health } from "./chrome.js";
import { CommandPalette, type PaletteCommand } from "./palette.js";
import { replayTour, Tour } from "./tour.js";
import { Nav } from "./nav.js";
import { screenOf, type ScreenDef } from "./screens.js";
import { SectionTabs } from "./tabs.js";
import { inEditor } from "./theme.js";
import { useLayout, type Layout } from "./shell/layout.js";
import { Shell, takeTabSwitch } from "./shell/Shell.js";
import { tabKeyOf } from "./shell/tabs-model.js";

export { askExample } from "./chrome.js";

const T = COPY.shell;

function useHash(): string {
  const [h, set] = useState(location.hash);
  useEffect(() => {
    const on = () => set(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
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

/** The page an address opens, in its boundary; `tab`: the IDE layout's tab, so each is its own. */
export function ScreenOf({
  current,
  hash,
  epoch,
  tab = "",
}: {
  current: ScreenDef;
  hash: string;
  epoch: number;
  tab?: string;
}) {
  const S = SCREEN_COMPONENTS[current.id];
  return S ? (
    <ScreenBoundary key={`${tab}:${current.id}:${epoch}`} name={current.label}>
      <S hash={hash} />
    </ScreenBoundary>
  ) : (
    <NotBuilt screen={current} />
  );
}

/** ADR 0194: Ctrl+K's way to the other layout, in either one. */
export function layoutCommands(layout: Layout, set: (l: Layout) => void): PaletteCommand[] {
  const L = COPY.ide.layout;
  return layout === "ide"
    ? [{ label: L.toClassic, detail: L.commandDetail, run: () => set("classic"), also: [L.title] }]
    : [{ label: L.toIde, detail: L.commandDetail, run: () => set("ide"), also: [L.title] }];
}

/** The IDE layout's palette shows the person's own example as its placeholder. */
function IdePalette({ commands }: { commands: PaletteCommand[] }) {
  const example = useAskExample();
  return <CommandPalette commands={commands} placeholder={example} />;
}

export function App() {
  const hash = useHash();
  const current = screenOf(hash);
  const health = useApi<Health>("/api/health");
  // The server says whether it was started with --full (every page a tab, More pages open).
  const full = health.state === "ready" && health.data.full === true;
  const server = useServer();
  // ADR 0190: a folder that isn't a metarepo yet shows Create the metarepo here, nothing else.
  const bare = health.state === "ready" && health.data.metarepo === false;
  // ADR 0194: the IDE layout by default; the classic one stays, per browser, for this release.
  const [layout, setLayout] = useLayout();
  const commands = useMemo(() => layoutCommands(layout, setLayout), [layout, setLayout]);
  const reloadHealth = health.reload;
  useEffect(() => {
    if (server.epoch) reloadHealth();
  }, [server.epoch, reloadHealth]);
  useEffect(() => {
    document.title = `${current.label} · Atticus`;
  }, [current]);
  // WP5.6: on moving to another screen, focus goes to its content (not on the first load), so a
  // keyboard or screen reader user starts there rather than back in the menu. A tab picked in
  // the IDE layout's tab strip keeps the focus on the tab, as a tab list does.
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const fromTabs = takeTabSwitch();
    if (shown.current !== undefined && shown.current !== current.id && !fromTabs)
      document.getElementById("main")?.focus({ preventScroll: true });
    shown.current = current.id;
    // Review (beta.26): run on every address, so a tab switch within one screen (two changes'
    // tabs on At a glance) uses up its flag and the next link in the page still moves focus.
  }, [current.id, hash]);
  const tour = !bare && (
    <Tour
      metarepo={
        health.state === "ready" ? health.data.root : health.state === "error" ? null : undefined
      }
    />
  );
  const skip = (
    <a
      className="skip"
      href="#main"
      onClick={(e) => {
        // The address is the screen (#/...): the skip link moves focus, never the address.
        e.preventDefault();
        document.getElementById("main")?.focus();
      }}
    >
      {T.skipToContent}
    </a>
  );
  const page: ReactNode = bare ? (
    <CreateMetarepo
      onCreated={() => {
        // Home continues with Onboarding.
        location.hash = "#/home";
        reloadHealth();
      }}
    />
  ) : (
    <ScreenOf
      current={current}
      hash={hash}
      epoch={server.epoch}
      {...(layout === "ide" ? { tab: tabKeyOf(hash) } : {})}
    />
  );
  return (
    <MeProvider>
      <CopilotRunsProvider>
        {/* ADR 0187: the Console: everything running or run lately, wherever it started. */}
        <ActivityProvider>
          {/* ADR 0181: the AI's decisions, read once when a chip or page first needs them. */}
          <DecisionsProvider>
            {layout === "classic" ? (
              <div className="shell">
                <LoadingBar />
                {skip}
                <Nav current={current} hash={hash} full={full} />
                <CommandPalette commands={commands} />
                {tour}
                <main id="main" className="main" tabIndex={-1}>
                  <FlashLine />
                  <TopBar health={health.state === "ready" ? health.data : undefined} />
                  <ActivityStrip />
                  <h1 className="sr">{bare ? COPY.setup.title : current.label}</h1>
                  {!bare && <SectionTabs current={current} hash={hash} full={full} />}
                  {server.down && <ServerDown inPanel={!!hostBridge()} />}
                  {page}
                </main>
                <ActivityConsole />
              </div>
            ) : (
              <>
                <LoadingBar />
                {skip}
                <IdePalette commands={commands} />
                {tour}
                <Shell
                  hash={hash}
                  current={current}
                  {...(health.state === "ready" ? { health: health.data } : {})}
                  embedded={!!hostBridge() || inEditor()}
                  heading={bare ? COPY.setup.title : current.label}
                  top={
                    <>
                      <FlashLine />
                      {/* What runs (a Copilot run's own strip, ADR 0173), above the page. */}
                      <ActivityStrip />
                      {!bare && <SectionTabs current={current} hash={hash} full={full} />}
                      {server.down && <ServerDown inPanel={!!hostBridge()} />}
                    </>
                  }
                >
                  {page}
                </Shell>
              </>
            )}
          </DecisionsProvider>
        </ActivityProvider>
      </CopilotRunsProvider>
    </MeProvider>
  );
}
