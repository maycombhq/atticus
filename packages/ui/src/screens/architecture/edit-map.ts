import type { Api } from "@maycombhq/core";
import { COPY } from "../../copy.js";
import type { CanvasGraph, CanvasLink } from "./model.js";

/**
 * Beta.28, Edit the map (the owner's ask of 2026-11-12: "delete arrows and add arrows in one go
 * and click a button"): the changes a person stages on the canvas, before anything is saved. A
 * delete is Delete this link's (every Interface behind the arrow), an add is Declare a link…'s
 * (a topic or a gateway route an outside system uses), a redirect is the two as one row. Apply my
 * changes sends them all to POST /api/map/edits (C4 3.13.0), which saves them and builds once.
 */

const E = COPY.editMap;

/** The arrow a delete or a redirect takes away: its two ends as the canvas names them. */
export interface StagedDelete {
  /** The canvas link's id (the view's edge id). */
  link: string;
  /** The two boxes, by id, and their labels. */
  fromBox: string;
  toBox: string;
  from: string;
  to: string;
  /** Every Interface behind the arrow (read in full when the view lists fewer). */
  interfaces: readonly string[];
}

/** Where an add is drawn until the map is built: its two boxes, when the person said them. */
export interface StagedEnds {
  fromBox?: string;
  toBox?: string;
}

export type Staged =
  | { key: string; kind: "delete"; delete: StagedDelete }
  | ({ key: string; kind: "add"; add: Api.MapEditAddT } & StagedEnds)
  | ({ key: string; kind: "redirect"; delete: StagedDelete; add: Api.MapEditAddT } & StagedEnds);

/** A change as it is staged, before the list gives it its key. */
export type Unkeyed = Staged extends infer T ? (T extends Staged ? Omit<T, "key"> : never) : never;

const addKey = (a: Api.MapEditAddT) =>
  `${a.system}\u0000${a.kind}\u0000${a.kind === "call" ? a.route.trim() : `${a.side}:${a.topic.trim()}`}`;

/** A staged change's key: one per arrow taken away, one per declaration added. */
export function keyOf(s: Unkeyed): string {
  if (s.kind === "delete") return `link:${s.delete.link}`;
  if (s.kind === "redirect") return `link:${s.delete.link}`;
  return `add:${addKey(s.add)}`;
}

/** An add in words: what Declare a link… would say it declares. */
export function addWords(a: Api.MapEditAddT): string {
  if (a.kind === "call") return E.what.call(a.system, a.route.trim());
  return a.side === "publishes"
    ? E.what.publishes(a.system, a.topic.trim())
    : E.what.listens(a.system, a.topic.trim());
}

/** A staged change in words, as the list and the confirm say it. */
export function rowWords(s: Staged): string {
  if (s.kind === "delete")
    return E.row.delete(s.delete.from, s.delete.to, s.delete.interfaces.length);
  if (s.kind === "add") return E.row.add(addWords(s.add));
  return E.row.redirect(s.delete.from, s.delete.to, addWords(s.add));
}

/**
 * The list with `s` staged: a second change of the same arrow (a delete, then a redirect of it)
 * takes the first one's place; the same add twice is one.
 */
export function stage(list: readonly Staged[], s: Unkeyed): Staged[] {
  const key = keyOf(s);
  const next = { ...s, key } as Staged;
  const at = list.findIndex((x) => x.key === key);
  // A redirect's add is also an add: the same declaration staged alone is folded into it.
  const rest = list.filter(
    (x, i) =>
      i !== at &&
      !(next.kind !== "delete" && x.kind === "add" && addKey(x.add) === addKey(next.add)),
  );
  if (at < 0) return [...rest, next];
  const out = [...rest];
  out.splice(Math.min(at, out.length), 0, next);
  return out;
}

export const unstage = (list: readonly Staged[], key: string): Staged[] =>
  list.filter((x) => x.key !== key);

/** How many of each, for the list's head ("3 deleted, 2 added, 1 redirected"). */
export function stagedCounts(list: readonly Staged[]): {
  deleted: number;
  added: number;
  redirected: number;
} {
  return {
    deleted: list.filter((x) => x.kind === "delete").length,
    added: list.filter((x) => x.kind === "add").length,
    redirected: list.filter((x) => x.kind === "redirect").length,
  };
}

export function countsWords(list: readonly Staged[]): string {
  const c = stagedCounts(list);
  return E.counts(c.deleted, c.added, c.redirected);
}

/** The staged change of an arrow of the canvas, if any. */
export const stagedOf = (list: readonly Staged[], link: string): Staged | undefined =>
  list.find((x) => x.kind !== "add" && x.delete.link === link);

/** POST /api/map/edits's body, in the list's order (a problem's `edit` is its place). */
export function requestOf(list: readonly Staged[]): Api.MapEditsRequestT {
  const del = (d: StagedDelete) => ({ interfaces: [...d.interfaces], from: d.from, to: d.to });
  return {
    edits: list.map((s) =>
      s.kind === "delete"
        ? { kind: "delete" as const, delete: del(s.delete) }
        : s.kind === "add"
          ? { kind: "add" as const, add: s.add }
          : { kind: "redirect" as const, delete: del(s.delete), add: s.add },
    ),
  };
}

/** The id a staged add is drawn under: never a view's edge id, so it is never picked as one. */
export const STAGED_LINK = "staged:";

/**
 * The picture with the staged changes drawn on it: an arrow to delete (or redirect) dimmed and
 * struck, an add dashed as a person's word between its two boxes when both are on the picture;
 * each says so in its label too (`staged`, WCAG 1.4.1). A staged delete keeps its arrow's id and
 * label, so the picture isn't laid out again for it.
 */
export function withStaged(g: CanvasGraph, list: readonly Staged[]): CanvasGraph {
  if (!list.length) return g;
  const gone = new Set(list.flatMap((s) => (s.kind === "add" ? [] : [s.delete.link])));
  const boxes = new Set(g.boxes.map((b) => b.id));
  const links: CanvasLink[] = g.links.map((l) =>
    gone.has(l.id) ? { ...l, staged: "delete" as const } : l,
  );
  for (const s of list) {
    if (s.kind === "delete") continue;
    const from = s.fromBox;
    const to = s.toBox;
    if (!from || !to || from === to || !boxes.has(from) || !boxes.has(to)) continue;
    links.push({
      id: `${STAGED_LINK}${s.key}`,
      from,
      to,
      type: "calls",
      count: 1,
      label: s.add.kind === "call" ? s.add.route.trim() : s.add.topic.trim(),
      async: s.add.kind === "topic",
      gaps: [],
      declared: true,
      staged: "add",
    });
  }
  return { ...g, links };
}
