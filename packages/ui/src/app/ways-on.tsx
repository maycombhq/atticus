import { useEffect, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError } from "../api/client.js";
import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";
import { UndoConfirm } from "./confirm-dialog.js";
import { followJob, type UndoWay } from "./job.js";
import { hashParam, movedHash } from "./screens.js";
import { panelId } from "./ui.js";

const W = COPY.waysOn;

/** Where a refused build is reviewed and confirmed, full width. */
export const CATALOG_BUILDS_HREF = "#/catalog-builds";

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
  // v30 slice 8: the page's old address opens at its new one (Activity's tab), which counts too.
  const here =
    typeof location !== "undefined" &&
    (location.hash === href || location.hash === movedHash(href));
  const at = here && panelAsked(href);
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

/** POST /api/support/bundle's answer (API 3.19.0). */
export type SupportBundleSaved = Api.SupportBundleViewT;

/** Where saving a support bundle stands, in the panel that asked. */
export type BundleState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; bundle: SupportBundleSaved }
  /** The server has no such route (an older command line serves this app). */
  | { state: "older" }
  | { state: "failed"; why: string };

/** Whether this page can hand the person a file to save (a browser; not every editor panel). */
export const canSaveCopy = (): boolean =>
  typeof document !== "undefined" &&
  typeof Blob !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

/** Hand the zip to the browser's own Save: nothing leaves the machine. */
export function saveCopy(b: SupportBundleSaved): void {
  if (!b.zip || !canSaveCopy()) return;
  const bytes = Uint8Array.from(atob(b.zip), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = b.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save one: the server writes the zip under .atticus/logs/ and gives it back. */
export async function saveBundle(): Promise<BundleState> {
  try {
    const bundle = await api<SupportBundleSaved>("/api/support/bundle", {
      method: "POST",
      quiet: true,
      // It writes the zip under .atticus/logs/ only: no page's data changed.
      readOnly: true,
    });
    return { state: "saved", bundle };
  } catch (e) {
    const status = e instanceof ApiError ? e.problem.status : 0;
    // No such route (404), or one that takes no POST (405): the server is older than the app.
    if (status === 404 || status === 405) return { state: "older" };
    return { state: "failed", why: e instanceof Error ? e.message : String(e) };
  }
}

/** The command for a terminal, with Copy: what the app offered before it could save one. */
function BundleCommand() {
  return (
    <div className="work-cmd">
      <code className="mono">{W.supportCommand}</code>
      <CopyButton
        text={W.supportCommand}
        say={W.copySupport}
        label={W.copySupportLabel(W.supportCommand)}
      />
    </div>
  );
}

/** Save a support bundle, in each of its states (tests render each). */
export function SupportBundleView(p: {
  at: BundleState;
  onSave: () => void;
  short?: boolean | undefined;
  /** Whether Save a copy… can be offered (the browser's own Save). */
  canCopy?: boolean | undefined;
  onCopy?: ((b: SupportBundleSaved) => void) | undefined;
}) {
  const a = p.at;
  const said = useRef<HTMLParagraphElement | null>(null);
  // The button that was pressed is disabled or gone: what it did takes the keyboard.
  useEffect(() => {
    if (a.state === "saved" || a.state === "failed" || a.state === "older") said.current?.focus();
  }, [a.state]);
  return (
    <div className="stack" style={{ gap: 4 }}>
      {!p.short && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.supportWhy}
        </p>
      )}
      {a.state !== "older" && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={p.onSave}
            disabled={a.state === "saving"}
            aria-busy={a.state === "saving" || undefined}
          >
            {a.state === "saving" ? W.savingBundle : W.saveBundle}
          </button>
        </div>
      )}
      {a.state === "saved" && (
        <>
          <p role="status" className="work-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
            {W.bundleSaved(a.bundle.file, a.bundle.files.length)}
          </p>
          {a.bundle.files.length > 0 && (
            <ul className="ev-list mono" aria-label={W.bundleFiles} style={{ margin: 0 }}>
              {a.bundle.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {p.canCopy && a.bundle.zip && (
              <button
                type="button"
                className="btn"
                aria-label={W.saveCopyLabel(a.bundle.name)}
                onClick={() => p.onCopy?.(a.bundle)}
              >
                {W.saveCopy}
              </button>
            )}
            <CopyButton
              text={a.bundle.file}
              say={W.copyPath}
              label={W.copyPathLabel(a.bundle.file)}
            />
          </div>
        </>
      )}
      {a.state === "failed" && (
        <p role="alert" className="state error" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {W.bundleFailed(a.why)}
        </p>
      )}
      {a.state === "older" && (
        <p role="status" className="work-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {W.bundleOlder}
        </p>
      )}
      {(a.state === "idle" || a.state === "saving" || a.state === "saved") && (
        <p className="work-say" style={{ margin: 0 }}>
          {W.bundleTerminal}
        </p>
      )}
      <BundleCommand />
    </div>
  );
}

/**
 * ADR 0202 point 1: Save a support bundle, on every error state. The app saves it itself
 * (POST /api/support/bundle: the zip `atticus support bundle` writes, under .atticus/logs/;
 * nothing is sent anywhere), says where it is and to read every file first, and offers a copy to
 * save and the path to copy. The command stays below it for a terminal, and is all that is
 * offered when the server is older than the app. `short`: without the sentence.
 */
export function SupportBundle({ short }: { short?: boolean | undefined }) {
  const [at, setAt] = useState<BundleState>({ state: "idle" });
  return (
    <SupportBundleView
      at={at}
      short={short}
      canCopy={canSaveCopy()}
      onCopy={saveCopy}
      onSave={() => {
        setAt({ state: "saving" });
        void saveBundle().then(setAt);
      }}
    />
  );
}

/** A time as the Undo panel says it: 2026-11-18 10:00:00 UTC. */
const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");

/** The button's words: this build's undo, or the last build's with its command and time. */
export const undoWords = (u: UndoWay): string =>
  u.ofThis ? W.undoThis : W.undoLastOf(u.command, when(u.at));

type UndoPlan = NonNullable<Api.CatalogUndoViewT["plan"]>;

/** Where an error's Undo stands. */
export type UndoState =
  | { state: "idle" }
  | { state: "listing" }
  | { state: "asking"; plan: UndoPlan }
  | { state: "undone" }
  | { state: "failed"; why: string };

/** Undo from an error, in each of its states (tests render each). */
export function UndoHereView(p: {
  undo: UndoWay;
  at: UndoState;
  onOpen: () => void;
  onUndo: () => Promise<void>;
  onBack: () => void;
}) {
  const a = p.at;
  const said = useRef<HTMLParagraphElement | null>(null);
  // What the Undo did takes the keyboard once it has ended (its dialog is gone). Go back gives
  // it to the button that opened the dialog, which the dialog itself does as it closes.
  useEffect(() => {
    if (a.state === "undone" || a.state === "failed") said.current?.focus();
  }, [a.state]);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {a.state !== "undone" && (
        <div>
          <button
            type="button"
            className="btn"
            onClick={p.onOpen}
            aria-disabled={a.state === "listing" || undefined}
            aria-busy={a.state === "listing" || undefined}
          >
            {a.state === "listing" ? W.undoListing : undoWords(p.undo)}
          </button>
        </div>
      )}
      {a.state === "asking" && (
        // The confirm undo has on Catalog builds: the builds it takes back by number and
        // command, a rename's note, every file; titled with which build this error names.
        <UndoConfirm
          plan={a.plan}
          title={undoWords(p.undo)}
          ask={W.undoAsk}
          confirm={W.undoYes}
          onConfirm={p.onUndo}
          onClose={p.onBack}
        />
      )}
      {a.state === "undone" && (
        <p role="status" className="work-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {W.undone}
        </p>
      )}
      {a.state === "failed" && (
        <p role="alert" className="state error" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {W.undoFailed(a.why)}
        </p>
      )}
    </div>
  );
}

/**
 * ADR 0202 point 3: Undo the last build in one click from an error. The click opens the confirm
 * undo has, here (GET /api/build/undo?n=: the builds it takes back and the files it puts back),
 * asks "Take back this build?", and Undo sends the error's own three values
 * (POST /api/build/undo: n, files, plan), so a list that changed meanwhile is refused, as on
 * Catalog builds, and said in the dialog. Nothing is undone without the confirm.
 */
export function UndoHere(p: { undo: UndoWay; onDone?: (() => void) | undefined }) {
  const [at, setAt] = useState<UndoState>({ state: "idle" });
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return (
    <UndoHereView
      undo={p.undo}
      at={at}
      onBack={() => setAt({ state: "idle" })}
      onOpen={() => {
        if (at.state === "listing") return;
        setAt({ state: "listing" });
        api<Api.CatalogUndoViewT>(`/api/build/undo?n=${p.undo.n}`, { quiet: true }).then(
          (v) =>
            setAt(
              v.plan
                ? { state: "asking", plan: v.plan }
                : { state: "failed", why: v.problem ?? COPY.catalogBuild.undoNone },
            ),
          (e: unknown) => setAt({ state: "failed", why: why(e) }),
        );
      }}
      onUndo={async () => {
        const { n, files, plan } = p.undo;
        await followJob("/api/build/undo", { n, files, plan });
        setAt({ state: "undone" });
        p.onDone?.();
      }}
    />
  );
}

/**
 * Beta.30, slice 2: what an error state offers. Build again is the caller's own step (`onAgain`)
 * or the page that builds (`againHref`), only where a build is what failed. ADR 0202: Undo is one
 * click here when the error says which build it would take back (`undo`); when the server says
 * there is none (`undoKnown` and no `undo`) no Undo is offered; an error that can't say (a
 * screen that couldn't be shown, an older server) keeps the link to Catalog builds' Undo. Save a
 * support bundle is on every one. `short`: inside a panel, the buttons without the sentences.
 */
export function ErrorWaysOn(p: {
  onAgain?: (() => void) | undefined;
  againHref?: string | undefined;
  short?: boolean;
  /** A link here was followed (the app's boundary lets go of its error). */
  onGo?: (() => void) | undefined;
  /** The build an Undo would take back, as the failed job or the 409 says it. */
  undo?: UndoWay | undefined;
  /** The server said whether a build can be taken back: with no `undo`, none can. */
  undoKnown?: boolean | undefined;
  /** An Undo here ended well (the page reads again). */
  onUndone?: (() => void) | undefined;
}) {
  const link = !p.undo && !p.undoKnown;
  return (
    <div
      className="stack"
      role="group"
      aria-label={W.label}
      style={{ gap: 6, marginTop: 8, textAlign: "start" }}
    >
      {!p.short && (p.undo || link) && (
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
        {link && (
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
        )}
      </div>
      {p.undo && <UndoHere undo={p.undo} onDone={p.onUndone} />}
      <SupportBundle short={p.short} />
    </div>
  );
}
