import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flash, FlashLine } from "./flash.js";
import { LoadingBar } from "./loading-bar.js";
import {
  api,
  onSession,
  SERVER_EVENT,
  sessionMoved,
  sessionStale,
  useApi,
  type Loaded,
} from "../api/client.js";
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
import { focusAfterLayoutSwitch, useLayout, type Layout } from "./shell/layout.js";
import { inEditorPanel } from "./shell/host.js";
import { showPanelTab } from "./shell/BottomPanel.js";
import { Shell, takeTabSwitch } from "./shell/Shell.js";
import { startHash, tabKeyOf } from "./shell/tabs-model.js";

export { askExample } from "./chrome.js";

const T = COPY.shell;

/**
 * The address shown. `ide`: opened with no address, the IDE layout starts on the tab that was
 * shown, chosen before the first render so Home never mounts first (review, beta.26).
 */
function useHash(ide: boolean): string {
  const [h, set] = useState(() => {
    const given = location.hash;
    const start = ide ? startHash(given) : given;
    if (start !== given) history.replaceState(history.state, "", start);
    return start;
  });
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

/** Whether the page's session token is one the server refused and no new one could be read. */
function useSessionStale(): boolean {
  const [stale, set] = useState(sessionStale);
  useEffect(() => onSession((s) => set(s === "stale")), []);
  return stale;
}

/**
 * Beta.27 review: the one note about the connection, above the page in either layout: the
 * server not answering (with Try again), or the app restarted with a session this page couldn't
 * take up (with Reload). Sections only say quietly that they aren't loaded.
 */
export function ConnectionNote({
  down,
  stale,
  inPanel,
  moved = false,
}: {
  down: boolean;
  stale: boolean;
  inPanel: boolean;
  /** Beta.27 re-review: the server at this address now serves another metarepo. */
  moved?: boolean;
}) {
  if (down) return <ServerDown inPanel={inPanel} />;
  if (!stale) return null;
  return (
    <div className="state error" role="alert" style={{ marginBottom: 12 }}>
      <p style={{ margin: 0 }}>{moved ? COPY.app.otherMetarepo : COPY.app.restarted}</p>
      <button
        type="button"
        className="btn"
        style={{ marginTop: 8 }}
        onClick={() => location.reload()}
      >
        {COPY.app.reload}
      </button>
    </div>
  );
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

/**
 * The metarepo the tour is for: the root health names once it answered, else undefined (the
 * tour waits). Never on a failed health: a server down or a session refused isn't a first run.
 */
export function tourMetarepo(health: Loaded<Health>): string | undefined {
  return health.state === "ready" ? health.data.root : undefined;
}

/**
 * Beta.27 review: Ctrl+K's Sync the repos ("sync" found nothing): it starts the sync as Set up's
 * button does, and the Console shows it as it runs (the IDE layout's panel opens on it).
 */
export function syncCommand(layout: Layout): PaletteCommand {
  const S = COPY.palette.sync;
  return {
    label: S.label,
    detail: S.detail,
    also: S.also,
    run: () => {
      void api("/api/workspace/sync", { method: "POST", body: {} }).then(
        () => {
          flash({ text: S.started });
          if (layout === "ide") showPanelTab("console");
        },
        (e: unknown) => flash({ text: S.failed(e instanceof Error ? e.message : String(e)) }),
      );
    },
  };
}

/**
 * Ctrl+K's own commands: the other layout, the IDE layout's panel tabs, and Sync the repos.
 * Beta.27 re-review: Sync the repos only at a metarepo (`metarepo`, as health says): a bare
 * folder has no repos to sync, and its Ctrl+K offered a sync that could only fail.
 */
export function appCommands(
  layout: Layout,
  setLayout: (l: Layout) => void,
  metarepo: boolean,
): PaletteCommand[] {
  return [
    ...layoutCommands(layout, setLayout),
    ...(layout === "ide" ? panelCommands() : []),
    ...(metarepo ? [syncCommand(layout)] : []),
  ];
}

/** ADR 0194: Ctrl+K's way to the other layout, in either one. */
export function layoutCommands(layout: Layout, set: (l: Layout) => void): PaletteCommand[] {
  const L = COPY.ide.layout;
  return layout === "ide"
    ? [{ label: L.toClassic, detail: L.commandDetail, run: () => set("classic"), also: [L.title] }]
    : [{ label: L.toIde, detail: L.commandDetail, run: () => set("ide"), also: [L.title] }];
}

/**
 * Review (beta.26): the IDE layout's Ctrl+K commands for its bottom panel: the Console, the open
 * questions, the problems and the recent runs, each only showing that tab (nothing is written;
 * every page, Scans among them, is in Ctrl+K by its name already).
 */
export function panelCommands(): PaletteCommand[] {
  const C = COPY.ide.panelCommands;
  return (["console", "questions", "problems", "runs"] as const).map((t) => ({
    label: C[t],
    detail: C.detail,
    run: () => showPanelTab(t),
    also: C.also[t],
  }));
}

/** The IDE layout's palette shows the person's own example as its placeholder. */
function IdePalette({ commands }: { commands: PaletteCommand[] }) {
  const example = useAskExample();
  return <CommandPalette commands={commands} placeholder={example} />;
}

export function App() {
  // ADR 0194: the IDE layout by default; the classic one stays, per browser, for this release.
  const [layout, setLayout] = useLayout();
  const hash = useHash(layout === "ide");
  const current = screenOf(hash);
  const health = useApi<Health>("/api/health");
  // The server says whether it was started with --full (every page a tab, More pages open).
  const full = health.state === "ready" && health.data.full === true;
  const server = useServer();
  const stale = useSessionStale();
  const connection = (
    <ConnectionNote
      down={server.down}
      stale={stale}
      moved={stale && sessionMoved()}
      inPanel={!!hostBridge()}
    />
  );
  // ADR 0190: a folder that isn't a metarepo yet shows Create the metarepo here, nothing else.
  const bare = health.state === "ready" && health.data.metarepo === false;
  const atMetarepo = health.state === "ready" && health.data.metarepo !== false;
  const commands = useMemo(
    () => appCommands(layout, setLayout, atMetarepo),
    [layout, setLayout, atMetarepo],
  );
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
  // Review (beta.26): the other layout draws the page anew, so the focus (Settings' radio, or
  // Ctrl+K's box) would drop to the body: it goes to the layout picked, else the page.
  const shownLayout = useRef(layout);
  useEffect(() => {
    if (shownLayout.current === layout) return;
    shownLayout.current = layout;
    focusAfterLayoutSwitch(document);
  }, [layout]);
  // Beta.27 review (blocker): the tour waits for the metarepo the server serves. A health that
  // failed (the server down, a session refused after a restart) is no first run: the tour
  // opened over the page then, as if the metarepo were new.
  const tour = !bare && <Tour metarepo={tourMetarepo(health)} />;
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
                  {connection}
                  <FlashLine />
                  <TopBar health={health.state === "ready" ? health.data : undefined} />
                  <ActivityStrip />
                  <h1 className="sr">{bare ? COPY.setup.title : current.label}</h1>
                  {!bare && <SectionTabs current={current} hash={hash} full={full} />}
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
                  embedded={inEditorPanel()}
                  heading={bare ? COPY.setup.title : current.label}
                  top={
                    <>
                      {/* Beta.27 review: the connection's one note, first above the page. */}
                      {connection}
                      <FlashLine />
                      {/* What runs (a Copilot run's own strip, ADR 0173), above the page. */}
                      <ActivityStrip />
                      {!bare && <SectionTabs current={current} hash={hash} full={full} />}
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
