/**
 * ADR 0194: what a tab keeps while another is shown. Only the tab shown is mounted (a page left
 * mounted behind another would keep polling, and two pages' ids would clash), so when the person
 * leaves a tab the shell keeps what they typed into its fields (text boxes, text areas and
 * pickers they changed) and how far it was scrolled; going back puts them back as the page comes
 * in, opening again what they had opened (a disclosure: a button with aria-expanded and
 * aria-controls, such as an editor's Edit or the map's tools), so the fields inside it come back
 * too. The page's own address (its filters and picks in the query) comes back with the tab. Kept
 * in memory only, for this page load: what someone types is never written to storage.
 */

/** The parts of a field the shell reads and writes. */
export interface FieldLike {
  tagName: string;
  id?: string;
  name?: string;
  type?: string;
  value: string;
}

export interface Draft {
  fields: Record<string, string>;
  scroll: number;
  /** The disclosures that were open, by what they control. */
  open?: string[];
}

/** The parts of a disclosure button the shell reads and presses. */
export interface ToggleLike {
  getAttribute(name: string): string | null;
  click(): void;
}

/**
 * React's own ids (useId: «r1», :r1:, _r_1_) are counted afresh on each mount, so a page that
 * comes back names the same part differently: they are left out of a disclosure's name.
 */
const REACT_ID = /«[^»]*»|:r[0-9a-z]*:|_r_[0-9a-z]+_/g;
const HAS_REACT_ID = /«[^»]*»|:r[0-9a-z]*:|_r_[0-9a-z]+_/;

/**
 * Each disclosure's name within its page: what it controls (its words change as it opens),
 * without React's ids, then its place among those of the same name.
 */
export function toggleKeys(toggles: readonly ToggleLike[]): (string | undefined)[] {
  const seen = new Map<string, number>();
  return toggles.map((b) => {
    // beta.26: a disclosure whose panel isn't drawn while closed points at it only when open
    // (aria-controls must name an element there); data-controls names it always, for the draft.
    const c = b.getAttribute("aria-controls") ?? b.getAttribute("data-controls");
    if (!c) return undefined;
    const k = c.replace(REACT_ID, "~");
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${n}`;
  });
}

/** The disclosures open in a page, by name. */
export function openToggles(toggles: readonly ToggleLike[]): string[] {
  const keys = toggleKeys(toggles);
  return toggles
    .map((b, i) => (b.getAttribute("aria-expanded") === "true" ? keys[i] : undefined))
    .filter((k): k is string => !!k);
}

/** Open again the disclosures a draft had open, among those on the page now; the ones left. */
export function reopen(open: ReadonlySet<string>, toggles: readonly ToggleLike[]): Set<string> {
  const left = new Set(open);
  const keys = toggleKeys(toggles);
  toggles.forEach((b, i) => {
    const k = keys[i];
    if (!k || !left.has(k)) return;
    if (b.getAttribute("aria-expanded") === "false") b.click();
    left.delete(k);
  });
  return left;
}

/** The disclosure buttons in a page's element. */
export const togglesIn = (root: ParentNode): ToggleLike[] => [
  ...root.querySelectorAll<HTMLButtonElement>(
    "button[aria-expanded][aria-controls], button[aria-expanded][data-controls]",
  ),
];

const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "number", "tel"]);

/** A field the shell keeps: a text box, a text area or a picker (never a password or a file). */
export function keptField(el: FieldLike): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  return tag === "input" && TEXT_TYPES.has((el.type ?? "").toLowerCase());
}

/** A field's name within its page: its id, else its name, else its place among the fields. */
export function fieldKey(el: FieldLike, all: readonly FieldLike[]): string {
  if (el.id && HAS_REACT_ID.test(el.id)) {
    // An id from useId is counted afresh on each mount: its shape, and its place among those.
    const shape = (f: FieldLike) => (f.id ?? "").replace(REACT_ID, "~");
    const k = shape(el);
    return `#${k}#${all.filter((f) => f.id && shape(f) === k).indexOf(el)}`;
  }
  if (el.id) return `#${el.id}`;
  if (el.name) return `@${el.name}`;
  const tag = el.tagName.toLowerCase();
  const same = all.filter((f) => f.tagName.toLowerCase() === tag && !f.id && !f.name);
  return `${tag}:${same.indexOf(el)}`;
}

/** What to keep of a page: the fields the person changed, by their key. */
export function draftOf(
  fields: readonly FieldLike[],
  changed: ReadonlySet<string>,
  scroll: number,
  open: readonly string[] = [],
): Draft | undefined {
  const kept: Record<string, string> = {};
  for (const f of fields) {
    if (!keptField(f)) continue;
    const k = fieldKey(f, fields);
    if (changed.has(k)) kept[k] = f.value;
  }
  if (!Object.keys(kept).length && scroll < 1 && !open.length) return undefined;
  return { fields: kept, scroll, ...(open.length ? { open: [...open] } : {}) };
}

/**
 * Review (beta.26): a draft put back counts as typed. The fields put back raise no trusted event,
 * so without this a tab left a second time without typing kept nothing.
 */
export const typedOf = (d: Draft): Set<string> => new Set(Object.keys(d.fields));

/**
 * Put a draft's fields back into those on the page now, as typing would (so the page's own
 * state follows). Returns the keys not found yet: the page may still be loading.
 */
export function putBack(
  draft: Draft,
  fields: readonly FieldLike[],
  set: (el: FieldLike, value: string) => void,
  pending: ReadonlySet<string> = new Set(Object.keys(draft.fields)),
): Set<string> {
  const left = new Set(pending);
  for (const f of fields) {
    if (!keptField(f)) continue;
    const k = fieldKey(f, fields);
    if (!left.has(k)) continue;
    const v = draft.fields[k]!;
    if (f.value !== v) set(f, v);
    left.delete(k);
  }
  return left;
}

/** Set a field as typing does: React hears the change and its state follows. */
export function setAsTyped(el: FieldLike, value: string): void {
  const node = el as unknown as HTMLInputElement;
  const proto = Object.getPrototypeOf(node) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(node, value);
  else node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The kept fields in a page's element, in document order. */
export const fieldsIn = (root: ParentNode): FieldLike[] =>
  [...root.querySelectorAll("input, textarea, select")] as unknown as FieldLike[];

/**
 * Follow a page while it comes in, putting a draft back as its fields appear, then its scroll.
 * Stops when everything is back, when the person types, or after `ms`. Returns a stop function.
 */
export function restoreDraft(root: HTMLElement, scroller: HTMLElement, draft: Draft, ms = 8000) {
  let pending = new Set(Object.keys(draft.fields));
  let opening = new Set(draft.open ?? []);
  let scrolled = draft.scroll < 1;
  const step = () => {
    if (opening.size) opening = reopen(opening, togglesIn(root));
    if (pending.size) pending = putBack(draft, fieldsIn(root), setAsTyped, pending);
    if (!scrolled && scroller.scrollHeight - scroller.clientHeight >= draft.scroll - 1) {
      scroller.scrollTop = draft.scroll;
      scrolled = true;
    }
    if (!pending.size && !opening.size && scrolled) stop();
  };
  const obs = new MutationObserver(step);
  const timer = setTimeout(() => stop(), ms);
  const typed = (e: Event) => e.isTrusted && stop();
  function stop() {
    obs.disconnect();
    clearTimeout(timer);
    root.removeEventListener("input", typed, true);
  }
  obs.observe(root, { childList: true, subtree: true });
  root.addEventListener("input", typed, true);
  step();
  return stop;
}

/** The tab a draft's place is in: the place is `<tab key>|<page>`. */
const tabOfPlace = (place: string): string => place.slice(0, place.lastIndexOf("|"));

/**
 * The drafts of the pages left, by place (`<tab key>|<page>`), for this page load. A closed tab
 * takes its drafts with it (review, beta.26: a tab opened again came back with what was typed
 * before it was closed); closing the tab shown leaves its page too, and that draft isn't kept.
 */
export class DraftShelf {
  private kept = new Map<string, Draft>();
  private closing: string | undefined;

  /** The page at `place` was left: keep its draft (none: forget any), unless its tab closes. */
  leave(place: string, d: Draft | undefined): void {
    const closed = this.closing !== undefined && tabOfPlace(place) === this.closing;
    this.closing = undefined;
    if (d && !closed) this.kept.set(place, d);
    else this.kept.delete(place);
  }

  /** The draft to put back at `place`, given once. */
  take(place: string): Draft | undefined {
    const d = this.kept.get(place);
    this.kept.delete(place);
    return d;
  }

  /** A tab closes: its pages' drafts go; `shown`: it is the tab shown, whose page is left next. */
  close(tabKey: string, shown: boolean): void {
    for (const place of [...this.kept.keys()])
      if (tabOfPlace(place) === tabKey) this.kept.delete(place);
    this.closing = shown ? tabKey : undefined;
  }

  /** A page is shown: a close that left no page behind is over. */
  shown(): void {
    this.closing = undefined;
  }
}
