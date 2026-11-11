import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Explorer, ExplorerView, type ExplorerViewProps } from "../src/app/shell/Explorer.js";
import {
  changeItems,
  filterItems,
  pageLabel,
  pinnedItems,
  questionItems,
  systemItems,
  treeKey,
  visibleRows,
  waitsOnYou,
  type ExItem,
  type SectionModel,
} from "../src/app/shell/explorer-model.js";
import { PINS_KEY, readPins, togglePin } from "../src/app/shell/pinned-pages.js";
import { COPY } from "../src/copy.js";

// The side panel's Explorer (the IDE shell, beta.26): changes in flight, the systems' tree,
// the open questions by repo and the pinned pages, each a section with a real tree. The data are
// the invented Forge estate's.

const CHANGES = [
  {
    id: "add-daily-transfer-limit",
    title: "Add a daily transfer limit",
    state: "define",
    yourRoles: ["product"],
  },
  { id: "card-freeze-v2", title: "Card freeze v2", state: "design", yourRoles: ["delivery"] },
  { id: "ledger-holds-api", title: "Ledger holds API", state: "build", yourRoles: ["delivery"] },
  { id: "old-statements", title: "Old statements", state: "archived" },
  { id: "draft-idea", title: "A draft", state: "draft" },
];

const node = (
  id: string,
  kind: string,
  label: string,
  parent: string,
  childCount = 0,
  properties: Record<string, string | number | boolean | string[]> = {},
) => ({ id, kind, label, parent, childCount, properties });

/** GET /api/graph/node/estate?lens=architecture&depth=3, cut down. */
const ESTATE = {
  children: [
    node("system:ledger", "system", "Ledger", "estate", 3, { boundary: "product" }),
    node("system:payments", "system", "Payments", "estate", 1, { boundary: "product" }),
    node("system:northwind-pay", "system", "Northwind Pay", "estate", 0, { boundary: "outside" }),
    node("unknown:rates-cache", "unknown", "rates-cache:8080", "estate"),
    node("repo:forge-ledger", "repo", "forge-ledger", "system:ledger", 2),
    node("repo:forge-payments-common", "repo", "forge-payments-common", "system:ledger", 1),
    node("repo:forge-proxy-ledger-v1", "repo", "forge-proxy-ledger-v1", "system:ledger", 1),
    node("repo:forge-teller", "repo", "forge-teller", "system:payments", 1),
    node("component:ledger-api", "component", "ledger-api", "repo:forge-ledger", 4, {
      type: "service",
    }),
    node("component:ledger-worker", "component", "ledger-worker", "repo:forge-ledger", 0, {
      type: "worker",
    }),
    node(
      "component:payments-common",
      "component",
      "payments-common",
      "repo:forge-payments-common",
      0,
      {
        type: "library",
      },
    ),
    node(
      "component:proxy-ledger-v1",
      "component",
      "proxy-ledger-v1",
      "repo:forge-proxy-ledger-v1",
      0,
      {
        type: "gateway",
      },
    ),
    node("component:teller", "component", "teller", "repo:forge-teller", 0, { type: "service" }),
    node("endpoint:ledger-get", "endpoint", "GET /ledger", "component:ledger-api"),
  ],
};

const QUESTIONS = {
  questions: [
    { id: "q-1", repo: "forge-teller" },
    { id: "q-2", repo: "forge-teller" },
    { id: "q-3", repo: "forge-cards" },
    { id: "q-4", repo: "forge-teller" },
  ],
};

const ready = (id: SectionModel["id"], items: ExItem[], extra: Partial<SectionModel> = {}) =>
  ({ id, open: true, state: "ready", items, ...extra }) as SectionModel;

const baseProps = (o: Partial<ExplorerViewProps> = {}): ExplorerViewProps => ({
  current: "#/home",
  filter: "",
  sections: [
    ready("changes", changeItems(CHANGES)),
    ready("systems", systemItems(ESTATE)),
    ready("questions", questionItems(QUESTIONS, { open: 2 })),
    ready("pinned", pinnedItems(["#/trust", "#/knowledge"])),
  ],
  expanded: new Set(["systems/system:ledger"]),
  focus: {},
  pinnedHere: false,
  onFilter: () => undefined,
  onToggleSection: () => undefined,
  onToggleItem: () => undefined,
  onOpen: () => undefined,
  onRetry: () => undefined,
  onPinHere: () => undefined,
  onTreeKey: () => undefined,
  onTreeFocus: () => undefined,
  ...o,
});

const html = (o: Partial<ExplorerViewProps> = {}) =>
  renderToStaticMarkup(<ExplorerView {...baseProps(o)} />);

/** Every element in a tree of hook-free components, each function component expanded. */
function elements(n: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(n)) return n.flatMap(elements);
  if (!isValidElement(n)) return [];
  const el = n as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function")
    return elements((el.type as (p: unknown) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}

const rowOf = (o: Partial<ExplorerViewProps>, itemId: string) =>
  elements(<ExplorerView {...baseProps(o)} />).find(
    (e) => e.props["data-row"] === itemId && typeof e.props.onClick === "function",
  )!;

describe("the Explorer's sections, from the data the app already reads", () => {
  it("lists the changes in flight with their stage, and marks what waits on you", () => {
    const items = changeItems(CHANGES);
    expect(items.map((i) => i.label)).toEqual([
      "add-daily-transfer-limit",
      "card-freeze-v2",
      "ledger-holds-api",
    ]);
    expect(items.map((i) => i.detail)).toEqual(["define", "design", "build"]);
    expect(items.map((i) => !!i.waits)).toEqual([true, false, true]);
    expect(items[0]!.hash).toBe("#/changes/add-daily-transfer-limit");
    expect(items[0]!.title).toBe("Add a daily transfer limit");
  });

  it("says whose phase it is from the person's roles on the change", () => {
    expect(waitsOnYou("define", ["product"])).toBe(true);
    expect(waitsOnYou("returned", ["product"])).toBe(true);
    expect(waitsOnYou("design", ["architecture"])).toBe(true);
    expect(waitsOnYou("design", ["product"])).toBe(false);
    expect(waitsOnYou("plan", ["analysis"])).toBe(true);
    expect(waitsOnYou("qa", ["delivery"])).toBe(true);
    expect(waitsOnYou("build", undefined)).toBe(false);
  });

  it("builds System › repo with kinds and counts, the outside systems last", () => {
    const items = systemItems(ESTATE);
    expect(items.map((i) => [i.label, i.kind, i.count])).toEqual([
      ["Ledger", undefined, 3],
      ["Payments", undefined, 1],
      ["Northwind Pay", "outside", undefined],
    ]);
    const ledger = items[0]!;
    expect(ledger.hash).toBe("#/canvas?node=system%3Aledger");
    expect(ledger.children!.map((c) => [c.label, c.kind, c.count, c.hash])).toEqual([
      ["forge-ledger", undefined, 2, "#/canvas?node=repo%3Aforge-ledger"],
      ["forge-payments-common", "lib", 1, "#/canvas?node=repo%3Aforge-payments-common"],
      ["forge-proxy-ledger-v1", "gw", 1, "#/canvas?node=repo%3Aforge-proxy-ledger-v1"],
    ]);
    // A node the catalog has no record of is a question, not a system.
    expect(JSON.stringify(items)).not.toContain("rates-cache");
  });

  it("counts the open questions per repo, most first, and the owner questions as a kind", () => {
    const items = questionItems(QUESTIONS, { open: 2 });
    expect(items.map((i) => [i.label, i.count, i.hash])).toEqual([
      ["forge-teller", 3, "#/questions"],
      ["forge-cards", 1, "#/questions"],
      ["Owner questions", 2, "#/questions?kind=owner"],
    ]);
    expect(questionItems(QUESTIONS, { open: 0 }).map((i) => i.label)).not.toContain(
      "Owner questions",
    );
  });

  it("names a pinned page by its page and what it is about", () => {
    expect(pageLabel("#/trust")).toBe("Map › Trust");
    expect(pageLabel("#/home")).toBe("Home");
    expect(pageLabel("#/changes/card-freeze-v2")).toBe("Change › card-freeze-v2");
    expect(pageLabel("#/stories?change=card-freeze-v2")).toBe("Change › Stories › card-freeze-v2");
    expect(pageLabel("#/canvas?node=system%3Aledger")).toBe("Map › Estate canvas › system:ledger");
    expect(pinnedItems(["#/trust"])[0]).toMatchObject({ label: "Map › Trust", hash: "#/trust" });
  });

  it("renders four labelled sections, each a tree of its items", () => {
    const h = html();
    for (const t of ["Changes in flight", "Systems", "Questions", "Pinned"])
      expect(h).toContain(`>${t}<`);
    expect(h.match(/role="tree"/g)).toHaveLength(4);
    expect(h).toMatch(/role="tree"[^>]*aria-labelledby="ex-head-changes"/);
    expect(h).toContain("add-daily-transfer-limit");
    expect(h).toContain("forge-proxy-ledger-v1");
    expect(h).toContain(">gw<");
    expect(h).toContain(">lib<");
    expect(h).toContain(">outside<");
    expect(h).toContain("waits on you");
    expect(h).toContain(">Map › Trust<");
  });

  it("keeps Pin beside the Pinned heading, not in it: the heading's name is the section's alone", () => {
    const h = html();
    // Each section heading holds its fold button only (WCAG 1.3.1, 2.4.6): a heading whose name
    // took in "Pin this page: …" read as one long, wrong heading.
    const heads = [...h.matchAll(/<h2 class="ex-head">([\s\S]*?)<\/h2>/g)].map((m) => m[1]!);
    expect(heads).toHaveLength(4);
    for (const head of heads) {
      expect(head).not.toContain("ex-pin");
      expect(head).not.toContain(`>${COPY.explorer.pin}<`);
      expect(head.match(/<button/g)).toHaveLength(1);
    }
    const pinnedHead = heads.find((x) => x.includes('id="ex-head-pinned"'))!;
    expect(pinnedHead).toContain(">Pinned<");
    // The Pin button sits right after the heading, in the same row, with its own name.
    const row = h.split('<div class="ex-headrow">').find((x) => x.includes('id="ex-head-pinned"'))!;
    const after = row.split("</h2>")[1]!;
    expect(after.startsWith('<button type="button" class="ex-pin"')).toBe(true);
    expect(after).toContain(`aria-label="${COPY.explorer.pinHere("Home")}"`);
  });

  it("has a tree's roles and states: levels, groups, expanded, and one tab stop per tree", () => {
    const h = html();
    expect(h).toMatch(
      /role="treeitem"[^>]*aria-level="1"[^>]*aria-setsize="3"[^>]*aria-posinset="1"[^>]*aria-expanded="true"/,
    );
    expect(h).toContain('role="group"');
    expect(h).toMatch(/aria-level="2"/);
    // Payments is closed; a change has no children, so no aria-expanded.
    expect(h).toMatch(
      /aria-label="Payments[^"]*"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="Payments/,
    );
    for (const tree of h.split('role="tree"').slice(1)) {
      const body = tree.split("</ul></div></section>")[0]!;
      expect(body.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    }
  });

  it("gives a long name in full in its title and accessible name, cut short only on screen", () => {
    const long = "forge-ledger-holds-reconciliation-and-settlement-api";
    const h = html({
      sections: [ready("changes", changeItems([{ id: long, title: long, state: "build" }]))],
    });
    expect(h).toContain(`title="${long}"`);
    expect(h).toContain(`aria-label="${long}, build"`);
    expect(h).toContain('class="ex-label"');
  });

  it("marks the page open now", () => {
    const h = html({ current: "#/changes/card-freeze-v2" });
    expect(h).toMatch(/aria-current="page"[^>]*>(?:(?!<\/li>).)*card-freeze-v2/);
  });
});

describe("the Explorer's states", () => {
  it("shows a skeleton while a section loads", () => {
    const h = html({ sections: [{ id: "changes", open: true, state: "loading", items: [] }] });
    expect(h).toContain('aria-busy="true"');
    expect(h).toContain("ex-skel");
    expect(h).toContain("Loading changes in flight");
  });

  it("says when a section has nothing, in its own words", () => {
    const h = html({
      sections: [
        ready("changes", []),
        ready("systems", []),
        ready("questions", []),
        ready("pinned", []),
      ],
    });
    expect(h).toContain("No changes in flight");
    expect(h).toContain("No systems read yet");
    expect(h).toContain("No open questions");
    expect(h).toContain("Nothing pinned yet");
  });

  it("says why a section couldn't load, with Retry for that section", () => {
    const onRetry = vi.fn();
    const props = baseProps({
      onRetry,
      sections: [
        { id: "systems", open: true, state: "error", error: "Server not answering", items: [] },
      ],
    });
    const h = renderToStaticMarkup(<ExplorerView {...props} />);
    expect(h).toContain('role="alert"');
    expect(h).toContain("Server not answering");
    const retry = elements(<ExplorerView {...props} />).find(
      (e) => e.type === "button" && e.props["data-retry"] === "systems",
    )!;
    (retry.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledWith("systems");
  });

  it("starts with every section loading before any answer, and renders without storage", () => {
    const h = renderToStaticMarkup(<Explorer current="#/home" onOpen={() => undefined} />);
    expect(h.match(/aria-busy="true"/g)?.length).toBe(3);
    expect(h).toContain("Nothing pinned yet");
    expect(h).toContain('aria-label="Filter the explorer"');
  });

  it("closes a section: its header says so and its tree is hidden", () => {
    const h = html({ sections: [{ ...ready("changes", changeItems(CHANGES)), open: false }] });
    expect(h).toMatch(/aria-expanded="false"[^>]*aria-controls="ex-body-changes"/);
    expect(h).toMatch(/id="ex-body-changes"[^>]*hidden=""/);
  });
});

describe("the Explorer's filter", () => {
  it("keeps what matches, and the parents of what matches, opened", () => {
    const { items, open } = filterItems(systemItems(ESTATE), "proxy");
    expect(items.map((i) => i.label)).toEqual(["Ledger"]);
    expect(items[0]!.children!.map((c) => c.label)).toEqual(["forge-proxy-ledger-v1"]);
    expect([...open]).toEqual(["systems/system:ledger"]);
  });

  it("keeps a parent that matches with all its children", () => {
    const { items } = filterItems(systemItems(ESTATE), "ledger");
    expect(items[0]!.children).toHaveLength(3);
  });

  it("matches a change's title and stage too, every word", () => {
    expect(filterItems(changeItems(CHANGES), "transfer define").items).toHaveLength(1);
    expect(filterItems(changeItems(CHANGES), "transfer build").items).toHaveLength(0);
  });

  it("says when a section has nothing that matches", () => {
    const h = html({
      filter: "zzz",
      sections: [ready("changes", filterItems(changeItems(CHANGES), "zzz").items)],
    });
    expect(h).toContain("Nothing matches “zzz”.");
  });

  it("hands every keystroke in the box to the shell's state", () => {
    const onFilter = vi.fn();
    const box = elements(<ExplorerView {...baseProps({ onFilter })} />).find(
      (e) => e.type === "input",
    )!;
    expect(box.props.type).toBe("search");
    (box.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "teller" },
    });
    expect(onFilter).toHaveBeenCalledWith("teller");
  });
});

describe("the Explorer's keyboard (a tree's keys)", () => {
  const items = systemItems(ESTATE);
  const open = new Set(["systems/system:ledger"]);
  const rows = visibleRows("systems", items, open);
  const ids = rows.map((r) => r.item.id);

  it("lists the rows a person sees, opened ones' children under them", () => {
    expect(ids).toEqual([
      "systems/system:ledger",
      "systems/repo:forge-ledger",
      "systems/repo:forge-payments-common",
      "systems/repo:forge-proxy-ledger-v1",
      "systems/system:payments",
      "systems/system:northwind-pay",
    ]);
    expect(rows[1]).toMatchObject({ level: 2, parent: "systems/system:ledger", posInSet: 1 });
  });

  it("moves with Up, Down, Home and End, and stops at the ends", () => {
    expect(treeKey(rows, ids[0], "ArrowDown", open)).toEqual({ focus: ids[1] });
    expect(treeKey(rows, ids[1], "ArrowUp", open)).toEqual({ focus: ids[0] });
    expect(treeKey(rows, ids[0], "ArrowUp", open)).toEqual({ focus: ids[0] });
    expect(treeKey(rows, ids[3], "End", open)).toEqual({ focus: ids[5] });
    expect(treeKey(rows, ids[5], "Home", open)).toEqual({ focus: ids[0] });
    expect(treeKey(rows, ids[5], "ArrowDown", open)).toEqual({ focus: ids[5] });
  });

  it("opens and closes with Right and Left, and goes to the parent or first child", () => {
    expect(treeKey(rows, "systems/system:payments", "ArrowRight", open)).toEqual({
      expand: "systems/system:payments",
    });
    expect(treeKey(rows, ids[0], "ArrowRight", open)).toEqual({ focus: ids[1] });
    expect(treeKey(rows, ids[0], "ArrowLeft", open)).toEqual({ collapse: ids[0] });
    expect(treeKey(rows, ids[2], "ArrowLeft", open)).toEqual({ focus: ids[0] });
    // A leaf at the top does nothing on Right or Left.
    expect(treeKey(rows, "systems/system:northwind-pay", "ArrowRight", open)).toBeUndefined();
  });

  it("opens the page with Enter: the map focused on a system or repo", () => {
    expect(treeKey(rows, ids[0], "Enter", open)).toEqual({
      open: "#/canvas?node=system%3Aledger",
    });
    expect(treeKey(rows, ids[3], "Enter", open)).toEqual({
      open: "#/canvas?node=repo%3Aforge-proxy-ledger-v1",
    });
  });

  it("jumps to the next row starting with a typed letter", () => {
    expect(treeKey(rows, ids[0], "p", open)).toEqual({ focus: "systems/system:payments" });
    expect(treeKey(rows, ids[0], "f", open)).toEqual({ focus: ids[1] });
    expect(treeKey(rows, ids[1], "f", open)).toEqual({ focus: ids[2] });
  });

  it("unpins a pinned page with Delete, and does nothing for others", () => {
    const pins = visibleRows("pinned", pinnedItems(["#/trust"]), new Set());
    expect(treeKey(pins, pins[0]!.item.id, "Delete", new Set())).toEqual({ unpin: "#/trust" });
    expect(treeKey(rows, ids[0], "Delete", open)).toBeUndefined();
  });

  it("puts the tab stop on the focused row, else the first", () => {
    const h = html({ focus: { systems: "systems/repo:forge-ledger" } });
    const tree = h
      .split('role="tree" aria-labelledby="ex-head-systems"')[1]!
      .split("</section>")[0]!;
    expect(tree.match(/tabindex="0"/g)).toHaveLength(1);
    expect(tree).toMatch(
      /tabindex="0"[^>]*data-id="systems\/repo:forge-ledger"|data-id="systems\/repo:forge-ledger"[^>]*tabindex="0"/,
    );
  });
});

describe("the Explorer opens pages through the shell", () => {
  const cases: [string, string, string][] = [
    ["a change", "changes/add-daily-transfer-limit", "#/changes/add-daily-transfer-limit"],
    ["a system", "systems/system:ledger", "#/canvas?node=system%3Aledger"],
    ["a repo", "systems/repo:forge-ledger", "#/canvas?node=repo%3Aforge-ledger"],
    ["a question group", "questions/repo:forge-teller", "#/questions"],
    ["the owner questions", "questions/owner", "#/questions?kind=owner"],
    ["a pinned page", "pinned/#/trust", "#/trust"],
  ];
  for (const [what, id, hash] of cases)
    it(`calls onOpen with ${what}'s address on a click`, () => {
      const onOpen = vi.fn();
      (rowOf({ onOpen }, id).props.onClick as () => void)();
      expect(onOpen).toHaveBeenCalledWith(hash);
    });

  it("toggles a system without opening it from its twisty", () => {
    const onOpen = vi.fn();
    const onToggleItem = vi.fn();
    const twisty = elements(<ExplorerView {...baseProps({ onOpen, onToggleItem })} />).find(
      (e) => e.props["data-twisty"] === "systems/system:payments",
    )!;
    (twisty.props.onClick as (e: { stopPropagation(): void }) => void)({
      stopPropagation: () => undefined,
    });
    expect(onToggleItem).toHaveBeenCalledWith("systems/system:payments");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("pinned pages, kept per viewer", () => {
  const store = () => {
    const saved: Record<string, string> = {};
    return {
      saved,
      getItem: (k: string) => saved[k] ?? null,
      setItem: (k: string, v: string) => {
        saved[k] = v;
      },
    };
  };

  it("pins and unpins a page, in the order pinned", () => {
    const s = store();
    expect(togglePin("#/trust", s)).toEqual(["#/trust"]);
    expect(togglePin("#/knowledge", s)).toEqual(["#/trust", "#/knowledge"]);
    expect(togglePin("#/trust", s)).toEqual(["#/knowledge"]);
    expect(JSON.parse(s.saved[PINS_KEY]!)).toEqual(["#/knowledge"]);
  });

  it("reads nothing from storage that refuses or holds something else", () => {
    const refuses = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readPins(refuses)).toEqual([]);
    expect(togglePin("#/trust", refuses)).toEqual(["#/trust"]);
    const odd = store();
    odd.saved[PINS_KEY] = '{"not":"a list"}';
    expect(readPins(odd)).toEqual([]);
    odd.saved[PINS_KEY] = '["#/trust", 4, "javascript:alert(1)"]';
    expect(readPins(odd)).toEqual(["#/trust"]);
  });

  it("offers to pin the page open now, and says when it is pinned", () => {
    const onPinHere = vi.fn();
    const props = baseProps({ onPinHere, current: "#/trust", pinnedHere: true });
    expect(renderToStaticMarkup(<ExplorerView {...props} />)).toContain('aria-pressed="true"');
    const pin = elements(<ExplorerView {...props} />).find(
      (e) => e.type === "button" && e.props["aria-pressed"] !== undefined,
    )!;
    (pin.props.onClick as () => void)();
    expect(onPinHere).toHaveBeenCalled();
  });
});
