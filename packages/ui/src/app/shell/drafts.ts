/**
 * ADR 0194: what a tab keeps while another is shown. Only the tab shown is mounted (a page left
 * mounted behind another would keep polling, and two pages' ids would clash), so when the person
 * leaves a tab the shell keeps what they typed into its fields (text boxes, text areas and
 * pickers they changed) and how far it was scrolled; going back puts them back as the page comes
 * in. The page's own address (its filters and picks in the query) comes back with the tab. Kept
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
}

const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "number", "tel"]);

/** A field the shell keeps: a text box, a text area or a picker (never a password or a file). */
export function keptField(el: FieldLike): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  return tag === "input" && TEXT_TYPES.has((el.type ?? "").toLowerCase());
}

/** A field's name within its page: its id, else its name, else its place among the fields. */
export function fieldKey(el: FieldLike, all: readonly FieldLike[]): string {
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
): Draft | undefined {
  const kept: Record<string, string> = {};
  for (const f of fields) {
    if (!keptField(f)) continue;
    const k = fieldKey(f, fields);
    if (changed.has(k)) kept[k] = f.value;
  }
  if (!Object.keys(kept).length && scroll < 1) return undefined;
  return { fields: kept, scroll };
}

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
  let scrolled = draft.scroll < 1;
  const step = () => {
    if (pending.size) pending = putBack(draft, fieldsIn(root), setAsTyped, pending);
    if (!scrolled && scroller.scrollHeight - scroller.clientHeight >= draft.scroll - 1) {
      scroller.scrollTop = draft.scroll;
      scrolled = true;
    }
    if (!pending.size && scrolled) stop();
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
