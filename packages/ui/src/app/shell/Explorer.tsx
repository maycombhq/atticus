import { COPY } from "../../copy.js";
import { landingOf, screenOf, sectionLabel, SECTIONS } from "../screens.js";

/**
 * The side panel's content (ADR 0194). A first cut: a link to each section's first page, the
 * section shown marked. The estate's tree (changes in flight, systems, pinned pages) replaces it.
 * `current` is the address shown; `onOpen` opens an address (and closes the panel when it lies
 * over the page on a narrow window).
 */
export function Explorer(props: { current: string; onOpen: (hash: string) => void }) {
  const shown = screenOf(props.current).section;
  return (
    <div className="sh-explorer">
      <ul className="sh-explorer-list" aria-label={COPY.nav.main}>
        {SECTIONS.map((s) => {
          const href = `#/${landingOf(s).id}`;
          return (
            <li key={s}>
              <a
                href={href}
                aria-current={shown === s ? "true" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  props.onOpen(href);
                }}
              >
                {sectionLabel(s)}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
