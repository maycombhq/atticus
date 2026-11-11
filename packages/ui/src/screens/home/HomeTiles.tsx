import { isOffline } from "../../api/client.js";
import { COPY } from "../../copy.js";
import "./home.css";

/**
 * beta.26: Home's tiles. Each is a number, a short label and one place to go: the whole tile is
 * its link, named by its label and number ("Questions to answer 36", the number shown above the
 * label, as a dashboard reads); a line under it (what the
 * number is made of, or why it didn't load) is its description. A count not loaded shows a dash,
 * never a 0 that reads as "none"; one loading shows a skeleton; a count of nothing is quiet.
 */

const H = COPY.commandCenter.home;

export type TileTone = "quiet" | "warn" | "bad" | "ok" | "plain";

export interface Tile {
  id: string;
  label: string;
  href: string;
  /** The number (or a word: "Done"); undefined while it isn't known. */
  value?: number | string | undefined;
  state: "loading" | "error" | "ready";
  /** Why it didn't load, as the server said. */
  error?: string | undefined;
  /** A short line under it: what the number is made of. */
  sub?: string | undefined;
  tone?: TileTone | undefined;
}

/** Quiet at nothing, amber when something waits, magenta when it blocks. */
export const toneOf = (n: number | undefined, when: "waits" | "blocks"): TileTone =>
  !n ? "quiet" : when === "blocks" ? "bad" : "warn";

const why = (e: string | undefined) => (!e || isOffline(e) ? COPY.app.offlineShort : e);

export function HomeTile({ t }: { t: Tile }) {
  const known = t.state === "ready" && t.value !== undefined;
  const sub = t.state === "error" ? H.tileError(why(t.error)) : t.sub;
  const subId = `hm-tile-${t.id}-sub`;
  const tone =
    t.state === "error" ? "error" : t.state === "loading" ? "quiet" : (t.tone ?? "plain");
  return (
    <li className={`hm-tile ${tone}`}>
      <a
        className="hm-tile-link"
        href={t.href}
        aria-busy={t.state === "loading" || undefined}
        {...(sub ? { "aria-describedby": subId } : {})}
      >
        <span className="hm-tile-label">{t.label}</span>{" "}
        <span className="hm-tile-n">
          {known ? (
            typeof t.value === "number" ? (
              t.value.toLocaleString()
            ) : (
              t.value
            )
          ) : t.state === "loading" ? (
            <>
              <span className="skeleton" aria-hidden="true" />
              <span className="sr">{H.tileLoading}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">–</span>
              <span className="sr">{COPY.app.notLoaded}</span>
            </>
          )}
        </span>
      </a>
      {sub && (
        <span id={subId} className="hm-tile-sub">
          {sub}
        </span>
      )}
    </li>
  );
}

/**
 * A strip of tiles under a heading, so the page's outline names it; `quiet`: the heading is for
 * a screen reader only (Home's one strip needs no label on the screen).
 */
export function TileGroup(p: { id: string; title: string; tiles: Tile[]; quiet?: boolean }) {
  const { id, title, tiles } = p;
  return (
    <section className="hm-group" aria-labelledby={id}>
      <h2 id={id} className={p.quiet ? "sr" : "hm-label"}>
        {title}
      </h2>
      <ul className="hm-tiles">
        {tiles.map((t) => (
          <HomeTile key={t.id} t={t} />
        ))}
      </ul>
    </section>
  );
}
