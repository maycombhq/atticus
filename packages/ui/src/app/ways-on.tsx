import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";
import { hashParam } from "./screens.js";
import { panelId } from "./ui.js";

const W = COPY.waysOn;

/** Set up › Catalog builds, opened at its Undo (the files it puts back are listed first). */
export const UNDO_HREF = "#/catalog-builds?at=undo";
/** The same page at its upgrade to source slots. */
export const UPGRADE_HREF = "#/catalog-builds?at=upgrade";

/** The panel of Catalog builds an address names (`?at=undo`, `?at=upgrade`), by its heading. */
export const panelAsked = (hash: string): string | undefined => {
  const at = hashParam(hash, "at");
  return at === "undo"
    ? panelId(COPY.catalogBuild.undoTitle)
    : at === "upgrade"
      ? panelId(COPY.catalogBuild.upgradeTitle)
      : undefined;
};

/**
 * Bring a panel of this page into view and give its heading the keyboard (WCAG 2.4.3: what
 * follows the link is where Tab goes on from); false when the panel isn't on the page.
 */
export function showOnPage(id: string): boolean {
  const head = typeof document === "undefined" ? null : document.getElementById(id);
  if (!head) return false;
  head.setAttribute("tabindex", "-1");
  (head.closest("section") ?? head).scrollIntoView({ block: "start" });
  head.focus({ preventScroll: true });
  return true;
}

/**
 * A panel link's click. When the address names that panel already (a second click: Undo, back
 * up the page, Undo again) nothing changes and the page hears nothing, so the link shows the
 * panel itself. From any other address the page shows it as it arrives (useShowPanel).
 */
export const showIfHere = (href: string) => (): void => {
  const at = typeof location !== "undefined" && location.hash === href && panelAsked(href);
  if (at) showOnPage(at);
};

/**
 * Beta.30: a refusal's one primary way on, the first of these its reasons have, wherever it is
 * shown (Catalog builds, an Apply, a correction's preview).
 */
export function refusalWay(reasons: readonly string[]) {
  const has = (x: string) => reasons.includes(x);
  return has("newer-atticus")
    ? "newer"
    : has("not-upgraded")
      ? "upgrade"
      : has("unexplained-removals")
        ? "again"
        : has("hand-edits")
          ? "edits"
          : has("large-removals")
            ? "removals"
            : has("empty") || has("nothing-read")
              ? "read"
              : undefined;
}

/** Copy the install command, the one way on from a catalog a newer Atticus built. */
export function InstallCopy() {
  return (
    <div className="work-cmd">
      <code className="mono">{W.installCommand}</code>
      <CopyButton
        primary
        text={W.installCommand}
        say={W.copyInstall}
        label={W.copyInstallLabel(W.installCommand)}
      />
    </div>
  );
}

/**
 * A support bundle is saved from a terminal today (`atticus support bundle`; no route of the
 * local API runs it), so the app offers its command to copy. `short`: without the sentence.
 */
export function SupportBundle({ short }: { short?: boolean | undefined }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      {!short && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.supportWhy}
        </p>
      )}
      <div className="work-cmd">
        <code className="mono">{W.supportCommand}</code>
        <CopyButton
          text={W.supportCommand}
          say={W.copySupport}
          label={W.copySupportLabel(W.supportCommand)}
        />
      </div>
    </div>
  );
}

/**
 * Beta.30, slice 2: what an error state offers, each something that exists today. Undo the last
 * build is Catalog builds' undo. Build again is the caller's own step (`onAgain`) or the page
 * that builds (`againHref`), only where a build is what failed. `short`: inside a panel, the
 * buttons without the sentences.
 */
export function ErrorWaysOn(p: {
  onAgain?: (() => void) | undefined;
  againHref?: string | undefined;
  short?: boolean;
  /** A link here was followed (the app's boundary lets go of its error). */
  onGo?: (() => void) | undefined;
}) {
  return (
    <div
      className="stack"
      role="group"
      aria-label={W.label}
      style={{ gap: 6, marginTop: 8, textAlign: "start" }}
    >
      {!p.short && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.undoWhy}
        </p>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {p.onAgain && (
          <button type="button" className="btn" onClick={p.onAgain}>
            {W.buildAgain}
          </button>
        )}
        {!p.onAgain && p.againHref && (
          <a className="btn" href={p.againHref} onClick={p.onGo}>
            {W.buildAgainOn}
          </a>
        )}
        <a
          className="btn"
          href={UNDO_HREF}
          onClick={() => {
            showIfHere(UNDO_HREF)();
            p.onGo?.();
          }}
        >
          {W.undoLast}
        </a>
      </div>
      <SupportBundle short={p.short} />
    </div>
  );
}
