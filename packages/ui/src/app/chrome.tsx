import { useApi } from "../api/client.js";
import { COPY } from "../copy.js";
import { useMe } from "./me.js";
import { THEME_CHOICES, useTheme, type ThemeChoice } from "./theme.js";

/**
 * The bits around every page, shared by both layouts (ADR 0194): the classic top bar and the IDE
 * layout's title bar show the same chips, theme switch and person.
 */

const T = COPY.shell;

export interface Health {
  version: string;
  /** The local API's version (C4). */
  apiVersion?: string;
  root: string;
  user: string;
  /** `atticus ui --full`: every page a tab of its section, and More pages open. */
  full?: boolean;
  /** ADR 0190: false in a folder that isn't a metarepo yet: the app offers to create one. */
  metarepo?: boolean;
}

/** Shows when AI is limited here, so nobody wonders why an AI button is missing. */
export function AiChip() {
  const { me } = useMe();
  if (!me || me.ai === "on") return null;
  return (
    <span className="chip warn" title={me.ai === "off" ? T.aiIsOffIn : T.imageReadingIsOff}>
      {me.ai === "off" ? T.aiOff : T.textOnlyAi}
    </span>
  );
}

/**
 * Who Atticus records you as: your Git user, with a warning when the OS user stood in. The
 * classic top bar adds the version; the IDE layout shows it in the status bar.
 */
export function Person({ health, version = true }: { health: Health; version?: boolean }) {
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
        {who}
        {version ? ` · v${health.version}` : ""}
      </span>
    </>
  );
}

/** System, light or dark, remembered in this browser. A VS Code panel follows the editor. */
export function ThemeSwitch() {
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

export function useAskExample(): string {
  const tables = useApi<SearchPage>("/api/search?q=kind:table&limit=1");
  const none = tables.state === "error" || (tables.state === "ready" && !tables.data.rows.length);
  const entries = useApi<SearchPage>(none ? "/api/search?q=kind:endpoint&limit=1" : undefined);
  return askExample(
    tables.state === "ready" ? tables.data : undefined,
    entries.state === "ready" ? entries.data : undefined,
  );
}
