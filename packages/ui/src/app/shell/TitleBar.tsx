import type { ReactNode } from "react";
import { COPY } from "../../copy.js";
import { Logo, paletteKeys, platformName } from "../nav.js";
import { OPEN_PALETTE } from "../palette.js";
import { SearchIcon } from "./icons.js";
import { folderOf } from "./StatusBar.js";

const T = COPY.ide;

/** Open Ctrl+K, as its keys do. */
export const openPalette = (): void => {
  dispatchEvent(new Event(OPEN_PALETTE));
};

/**
 * The title bar (ADR 0194): the logo and the metarepo, a box in the middle that opens Ctrl+K
 * (search the estate, go to a page, ask, or run a command), then `right`: the AI chip, the theme,
 * Help, the words and who you are.
 */
export function TitleBar({ root, right }: { root?: string; right?: ReactNode }) {
  const keys = paletteKeys(platformName());
  return (
    <header className="sh-title">
      <div className="sh-brand">
        <Logo size={20} />
        <span className="sh-brand-name">{COPY.menu.atticus}</span>
      </div>
      {root && (
        <span className="sh-metarepo sh-mono" title={root}>
          {T.metarepo(folderOf(root))}
        </span>
      )}
      <div className="sh-search-wrap">
        <button
          type="button"
          className="sh-search"
          aria-keyshortcuts={keys === COPY.menu.keysMac ? "Meta+K" : "Control+K"}
          onClick={openPalette}
        >
          <SearchIcon />
          <span className="sh-search-text">{T.search}</span>
          <kbd aria-hidden="true">{keys}</kbd>
        </button>
      </div>
      <div className="sh-title-right">{right}</div>
    </header>
  );
}
