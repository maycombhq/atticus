import type { Api } from "@maycombhq/core";
import { COPY } from "../../copy.js";
import type { CanvasGraph, CanvasLink } from "./model.js";

/**
 * Beta.28, Edit the map (the owner's ask of 2026-11-12: "delete arrows and add arrows in one go
 * and click a button"): the changes a person stages on the canvas, before anything is saved. A
 * delete is Delete this link's (every Interface behind the arrow), an add is Declare a link…'s
 * from a system's box (a topic, or a gateway route it calls) or Connect to…'s pairing from a
 * repo's box (its calls with the other box's APIs), a redirect is a delete and an add as one row. Apply my
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
  /** The repo its calls are made in, when the arrow starts in a repo's box (or a component's). */
  fromRepo?: string;
  /** Its calls' lines in that repo (`file:line`): none for a lineless arrow. */
  callerLines?: readonly string[];
  /** Its calls as the view lists them (method and path), to offer a lineless arrow's call. */
  shapes?: readonly { method?: string; path?: string }[];
  /** The other arrows the same calls draw (a topic's other side), taken away with it. */
  also?: readonly string[];
}

/**
 * A link added: Declare a link…'s, from a system's box (`declare`), or Connect to…'s pairing of
 * a repo's calls with the other box's APIs, from a repo's box (`pair`, ADR 0174).
 */
export type AddLink =
  | { by: "declare"; add: Api.MapEditAddT }
  | { by: "pair"; pair: Api.MapEditPairT; from: string; to: string };

/** Where an add is drawn until the map is built: its two boxes, when the person said them. */
export interface StagedEnds {
  fromBox?: string;
  toBox?: string;
}

export type Staged =
  | { key: string; kind: "delete"; delete: StagedDelete }
  | ({ key: string; kind: "add"; link: AddLink } & StagedEnds)
  | ({ key: string; kind: "redirect"; delete: StagedDelete; link: AddLink } & StagedEnds);

/** A change as it is staged, before the list gives it its key. */
export type Unkeyed = Staged extends infer T ? (T extends Staged ? Omit<T, "key"> : never) : never;

/** One key per declaration, or per call a pairing pairs. */
export const addKeys = (l: AddLink): string[] =>
  l.by === "declare"
    ? [
        `declare\u0000${l.add.system}\u0000${l.add.kind}\u0000${l.add.kind === "call" ? l.add.route.trim() : `${l.add.side}:${l.add.topic.trim()}`}`,
      ]
    : l.pair.pairs.map((p) => `pair\u0000${l.pair.from}\u0000${p.call}`);

/** A staged change's key: one per arrow taken away, one per link added. */
export function keyOf(s: Unkeyed): string {
  if (s.kind === "delete" || s.kind === "redirect") return `link:${s.delete.link}`;
  return `add:${addKeys(s.link).join("|")}`;
}

/** A link added, in words: what Declare a link… declares, or what Connect to… pairs. */
export function addWords(l: AddLink): string {
  if (l.by === "pair") return E.what.pair(l.from, l.to, l.pair.pairs.length);
  const a = l.add;
  if (a.kind === "call") return E.what.call(a.system, a.route.trim());
  return a.side === "publishes"
    ? E.what.publishes(a.system, a.topic.trim())
    : E.what.listens(a.system, a.topic.trim());
}

/** A staged change in words, as the list and the confirm say it. */
export function rowWords(s: Staged): string {
  const also =
    s.kind !== "add" && s.delete.also?.length ? E.row.also(s.delete.also.join(", ")) : "";
  if (s.kind === "delete")
    return E.row.delete(s.delete.from, s.delete.to, s.delete.interfaces.length) + also;
  if (s.kind === "add") return E.row.add(addWords(s.link));
  return E.row.redirect(s.delete.from, s.delete.to, addWords(s.link)) + also;
}

/**
 * The list with `s` staged: a second change of the same arrow (a delete, then a redirect of it)
 * takes the first one's place; the same add twice is one, and an add a redirect makes is the
 * redirect's.
 */
export function stage(list: readonly Staged[], s: Unkeyed): Staged[] {
  const key = keyOf(s);
  const next = { ...s, key } as Staged;
  const at = list.findIndex((x) => x.key === key);
  // A redirect's add is also an add: the same link staged alone is folded into it.
  const mine = new Set(next.kind === "delete" ? [] : addKeys(next.link));
  // An add a staged redirect makes already is that redirect's.
  if (
    next.kind === "add" &&
    list.some((x) => x.kind === "redirect" && addKeys(x.link).some((k) => mine.has(k)))
  )
    return [...list];
  const rest = list.filter(
    (x, i) => i !== at && !(x.kind === "add" && addKeys(x.link).some((k) => mine.has(k))),
  );
  if (at < 0) return [...rest, next];
  const out = [...rest];
  out.splice(Math.min(at, out.length), 0, next);
  return out;
}

export const unstage = (list: readonly Staged[], key: string): Staged[] =>
  list.filter((x) => x.key !== key);

/**
 * The list once an Apply saved `applied` (built, or its build waiting on Catalog builds): those
 * are off it, never staged again (a second Apply would refuse every add as on file already); a
 * change staged while it ran stays.
 */
export const keptAfterApply = (list: readonly Staged[], applied: ReadonlySet<string>): Staged[] =>
  list.filter((x) => !applied.has(x.key));

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
    edits: list.map((s): Api.MapEditT => {
      if (s.kind === "delete") return { kind: "delete", delete: del(s.delete) };
      const what = s.link.by === "pair" ? { pair: s.link.pair } : { add: s.link.add };
      return s.kind === "add"
        ? { kind: "add", ...what }
        : { kind: "redirect", delete: del(s.delete), ...what };
    }),
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
      label:
        s.link.by === "pair"
          ? E.what.pairShort(s.link.pair.pairs.length)
          : s.link.add.kind === "call"
            ? s.link.add.route.trim()
            : s.link.add.topic.trim(),
      async: s.link.by === "declare" && s.link.add.kind === "topic",
      gaps: [],
      declared: true,
      staged: "add",
    });
  }
  return { ...g, links };
}
