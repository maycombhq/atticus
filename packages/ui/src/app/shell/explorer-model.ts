import { COPY } from "../../copy.js";
import { matchesWords } from "../match.js";
import { changeOf, screenOf, sectionLabel } from "../screens.js";

/**
 * The Explorer's model (the IDE shell's side panel, beta.26), apart from React so it is tested
 * alone: each section's items from the answers the app already reads, the filter, the rows a
 * person sees, and what each of a tree's keys does (WAI-ARIA's tree view pattern).
 */

const E = COPY.explorer;

export const SECTION_IDS = ["changes", "systems", "questions", "pinned"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface ExItem {
  /** Unique in the Explorer: the section, a slash, then the thing's own id. */
  id: string;
  label: string;
  /** The page it opens, as the shell's hash route. */
  hash: string;
  /** The full name when the label is a short one (a change's title). */
  title?: string;
  /** A change's stage. */
  detail?: string;
  /** A map box's kind mark: lib, gw or outside. */
  kind?: "lib" | "gw" | "outside";
  count?: number;
  /** Beta.27 review: what `count` counts, for a screen reader (else "items"). */
  countOf?: "repos" | "components";
  /** A change whose phase is the person's role's. */
  waits?: boolean;
  /** A pinned page: Delete unpins it. */
  pin?: string;
  /**
   * Beta.27 review: a repo the map has a box for that the manifest doesn't name (records left for
   * a repo taken out of it): flagged, and counted as no repo (repo-counts.ts).
   */
  offManifest?: boolean;
  children?: ExItem[];
}

export interface SectionModel {
  id: SectionId;
  open: boolean;
  state: "loading" | "error" | "ready";
  error?: string;
  items: ExItem[];
  /** What the header says after the name: a count, or how many repos. */
  count?: string;
}

/** A change in GET /api/changes. */
export interface ChangeRow {
  id: string;
  title: string;
  state: string;
  yourRoles?: readonly string[] | undefined;
}

/** The states of a change in flight (Home's own list: draft and archived aren't). */
const IN_FLIGHT = new Set([
  "define",
  "design",
  "plan",
  "build",
  "qa",
  "release-ready",
  "returned",
  "post-release-review",
]);

/**
 * Whether a change waits on the person: its phase belongs to a role the change's owners give
 * them (ADR 0191's phase owners: the product owner in Define, the architect in Design, the
 * business analyst, then the tech lead, in Plan, the tech lead from Build). The cockpit's
 * waitsOn says more (an open hand-off waits on its reviewers), but it is one request per change.
 */
export function waitsOnYou(state: string, roles: readonly string[] | undefined): boolean {
  if (!roles?.length) return false;
  const of: Record<string, readonly string[]> = {
    draft: ["product"],
    define: ["product"],
    returned: ["product"],
    design: ["architecture"],
    plan: ["analysis", "delivery"],
    build: ["delivery"],
    qa: ["delivery"],
    "release-ready": ["delivery"],
  };
  return (of[state] ?? []).some((r) => roles.includes(r));
}

export const changeHash = (id: string) => `#/changes/${encodeURIComponent(id)}`;
export const mapHash = (node: string) => `#/canvas?node=${encodeURIComponent(node)}`;

export function changeItems(changes: readonly ChangeRow[]): ExItem[] {
  return changes
    .filter((c) => IN_FLIGHT.has(c.state))
    .map((c) => ({
      id: `changes/${c.id}`,
      label: c.id,
      hash: changeHash(c.id),
      ...(c.title && c.title !== c.id ? { title: c.title } : {}),
      detail: E.stages[c.state] ?? c.state,
      ...(waitsOnYou(c.state, c.yourRoles) ? { waits: true } : {}),
    }));
}

/** A node of GET /api/graph/node/estate?lens=architecture&depth=3, as far as the tree reads it. */
export interface EstateNode {
  id: string;
  kind: string;
  label: string;
  parent?: string;
  childCount: number;
  properties: Record<string, string | number | boolean | string[]>;
}

const isOutside = (n: EstateNode) =>
  n.properties.boundary === "outside" || n.properties.boundary === "vendor";

const byLabel = (a: ExItem, b: ExItem) => a.label.localeCompare(b.label);

/**
 * System › repo (or a component no repo holds), from the map's own estate view: what the map
 * draws is what the tree lists, and each item opens the map on its box (#/canvas?node=, the
 * address VS Code's /diagram link opens). A repo is marked lib or gw when its components are
 * libraries or it holds a gateway; a system outside the estate is marked outside and listed last.
 * Nodes the catalog has no record of (unknown) are questions, not systems.
 *
 * Beta.27 review: a system's row counts its repos only (a component no repo holds is listed
 * under it, not counted as a repo); a system of the estate with none says "no repo". `notOnMap`,
 * the manifest's repos the map has no box for (repo-counts.ts), are listed last under "Not on
 * the map", each opening Map › Trust, so the tree's repos add up to the header's. Beta.27
 * re-review: a box for a repo the manifest doesn't name (`offManifest`) stays on its system's row,
 * said "not in the manifest", and is counted as no repo there or in the tree.
 */
export function systemItems(
  view: { children: readonly EstateNode[] },
  notOnMap: readonly string[] = [],
  offManifest: readonly string[] = [],
): ExItem[] {
  const unlisted = new Set(offManifest.map((r) => `repo:${r}`));
  const nodes = view.children;
  const kidsOf = (id: string) => nodes.filter((n) => n.parent === id);
  const markOf = (n: EstateNode): ExItem["kind"] => {
    if (n.kind === "system") return isOutside(n) ? "outside" : undefined;
    const types =
      n.kind === "component"
        ? [n.properties.type]
        : kidsOf(n.id)
            .filter((c) => c.kind === "component")
            .map((c) => c.properties.type);
    if (types.includes("gateway")) return "gw";
    if (types.length && types.every((t) => t === "library")) return "lib";
    return undefined;
  };
  const leaf = (n: EstateNode): ExItem => {
    const kind = markOf(n);
    const count = n.kind === "repo" ? kidsOf(n.id).filter((c) => c.kind === "component").length : 0;
    const off = n.kind === "repo" && unlisted.has(n.id);
    return {
      id: `systems/${n.id}`,
      label: n.label,
      hash: mapHash(n.id),
      ...(kind ? { kind } : {}),
      ...(count ? { count, countOf: "components" as const } : {}),
      ...(off ? { detail: E.notInManifest, offManifest: true } : {}),
    };
  };
  const parts = (id: string) =>
    kidsOf(id)
      .filter((k) => k.kind === "repo" || k.kind === "component")
      .map(leaf)
      .sort(byLabel);
  const systems = nodes
    .filter((n) => n.kind === "system" && (n.parent ?? "estate") === "estate")
    .map((n): ExItem & { outside: boolean } => {
      const children = parts(n.id);
      const kind = markOf(n);
      const repos = kidsOf(n.id).filter((k) => k.kind === "repo" && !unlisted.has(k.id)).length;
      const outside = isOutside(n);
      return {
        id: `systems/${n.id}`,
        label: n.label,
        hash: mapHash(n.id),
        ...(kind ? { kind } : {}),
        ...(repos ? { count: repos, countOf: "repos" as const } : {}),
        ...(!repos && !outside ? { detail: E.noRepo } : {}),
        ...(children.length ? { children } : {}),
        outside,
      };
    })
    .sort((a, b) => Number(a.outside) - Number(b.outside) || byLabel(a, b))
    .map(({ outside: _o, ...item }) => item);
  const unmapped: ExItem[] = notOnMap.length
    ? [
        {
          id: "systems/not-on-map",
          label: E.notOnMap,
          hash: "#/trust",
          count: notOnMap.length,
          countOf: "repos",
          // Map › Trust lists every repo; its route takes no repo to select.
          children: [...notOnMap]
            .sort((a, b) => a.localeCompare(b))
            .map((r) => ({ id: `systems/manifest:${r}`, label: r, hash: "#/trust" })),
        },
      ]
    : [];
  // A repo or component no system holds sits after the systems; the repos with no box last.
  return [...systems, ...parts("estate"), ...unmapped];
}

/**
 * Beta.27 review: the repos the tree lists (a repo's row, under a system or not on the map), the
 * manifest's only: a box for a repo it doesn't name isn't one.
 */
export function treeRepos(items: readonly ExItem[]): number {
  return items.reduce(
    (n, i) =>
      n +
      ((i.id.startsWith("systems/repo:") && !i.offManifest) || i.id.startsWith("systems/manifest:")
        ? 1
        : 0) +
      treeRepos(i.children ?? []),
    0,
  );
}

/**
 * The open questions per repo, most first (GET /api/questions?state=open), then the owner
 * questions (GET /api/owner-questions) as their own kind. Questions has no address for one
 * repo's questions yet (its repo filter is the page's own), so a repo opens Questions; the
 * owner questions open as Home's link does (#/questions?kind=owner).
 */
export function questionItems(
  list: { questions: readonly { repo: string }[] },
  owner?: { open: number },
): ExItem[] {
  const by = new Map<string, number>();
  for (const q of list.questions) by.set(q.repo, (by.get(q.repo) ?? 0) + 1);
  const repos = [...by.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([repo, n]) => ({
      id: `questions/repo:${repo}`,
      label: repo,
      hash: "#/questions",
      count: n,
    }));
  return [
    ...repos,
    ...(owner && owner.open > 0
      ? [
          {
            id: "questions/owner",
            label: E.ownerQuestions,
            hash: "#/questions?kind=owner",
            count: owner.open,
          },
        ]
      : []),
  ];
}

/** A page's name for the pinned list: its section, its page, and the change or box it is of. */
export function pageLabel(hash: string): string {
  const s = screenOf(hash);
  const section = sectionLabel(s.section);
  const change = changeOf(hash);
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const about = change ?? q.get("node") ?? undefined;
  const page = s.id === "changes" && change ? [] : [s.label];
  const parts = [section, ...page.filter((p) => p !== section), ...(about ? [about] : [])];
  return E.pageLabel(...parts);
}

export function pinnedItems(hashes: readonly string[]): ExItem[] {
  return hashes.map((h) => ({ id: `pinned/${h}`, label: pageLabel(h), hash: h, pin: h }));
}

/**
 * What the filter keeps: every item whose words match (its name, full name, stage or kind), with
 * all its children; a parent of something that matches, with only those; `open` the parents to
 * show opened while filtering.
 */
export function filterItems(
  items: readonly ExItem[],
  text: string,
): {
  items: ExItem[];
  open: Set<string>;
} {
  const open = new Set<string>();
  if (!text.trim()) return { items: [...items], open };
  const keep = (list: readonly ExItem[]): ExItem[] =>
    list.flatMap((i): ExItem[] => {
      if (matchesWords([i.label, i.title, i.detail, i.kind], text)) return [i];
      const kids = keep(i.children ?? []);
      if (!kids.length) return [];
      open.add(i.id);
      return [{ ...i, children: kids }];
    });
  return { items: keep(items), open };
}

export interface Row {
  item: ExItem;
  level: number;
  parent?: string;
  setSize: number;
  posInSet: number;
}

/** The rows a person sees, top to bottom: each opened item's children under it. */
export function visibleRows(
  _section: SectionId,
  items: readonly ExItem[],
  expanded: ReadonlySet<string>,
): Row[] {
  const out: Row[] = [];
  const walk = (list: readonly ExItem[], level: number, parent?: string) =>
    list.forEach((item, i) => {
      out.push({
        item,
        level,
        ...(parent ? { parent } : {}),
        setSize: list.length,
        posInSet: i + 1,
      });
      if (item.children?.length && expanded.has(item.id)) walk(item.children, level + 1, item.id);
    });
  walk(items, 1);
  return out;
}

export type TreeAction =
  | { focus: string }
  | { expand: string }
  | { collapse: string }
  | { open: string }
  | { unpin: string };

/**
 * What a key does on the focused row (the tree view pattern): Up and Down move, Home and End go
 * to the first and last row, Right opens a closed row or goes to its first child, Left closes an
 * open row or goes to its parent, Enter opens the row's page, a letter goes to the next row
 * starting with it, and Delete unpins a pinned page. Undefined: the key isn't the tree's.
 */
export function treeKey(
  rows: readonly Row[],
  focused: string | undefined,
  key: string,
  expanded: ReadonlySet<string>,
): TreeAction | undefined {
  if (!rows.length) return undefined;
  const at = Math.max(
    0,
    rows.findIndex((r) => r.item.id === focused),
  );
  const row = rows[at]!;
  const id = row.item.id;
  const parent = !!row.item.children?.length;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(rows.length - 1, at + 1)]!.item.id };
    case "ArrowUp":
      return { focus: rows[Math.max(0, at - 1)]!.item.id };
    case "Home":
      return { focus: rows[0]!.item.id };
    case "End":
      return { focus: rows[rows.length - 1]!.item.id };
    case "ArrowRight":
      if (!parent) return undefined;
      return expanded.has(id) ? { focus: rows[at + 1]!.item.id } : { expand: id };
    case "ArrowLeft":
      if (parent && expanded.has(id)) return { collapse: id };
      return row.parent ? { focus: row.parent } : undefined;
    case "Enter":
      return { open: row.item.hash };
    case "Delete":
      return row.item.pin ? { unpin: row.item.pin } : undefined;
  }
  if (key.length === 1 && /\S/.test(key)) {
    const k = key.toLowerCase();
    const order = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
    const hit = order.find((r) => r.item.label.toLowerCase().startsWith(k));
    return hit ? { focus: hit.item.id } : undefined;
  }
  return undefined;
}

/** The Pinned section's Pin button's element id. */
export const PIN_BUTTON_ID = "ex-pin-here";

/**
 * Where the focus goes after Delete unpins a pinned page (review, beta.26: it fell to the body):
 * the next pinned page's row, else the one before, else the section's Pin button. An element id.
 */
export function focusAfterUnpin(rows: readonly Row[], pin: string): string {
  const at = rows.findIndex((r) => r.item.pin === pin);
  const next = at < 0 ? undefined : (rows[at + 1] ?? rows[at - 1]);
  return next ? domId(next.item.id) : PIN_BUTTON_ID;
}

/** A row's element id: the item's id with anything an id can't hold spelled out. */
export const domId = (itemId: string) =>
  `ex-i-${itemId.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(36)}_`)}`;
