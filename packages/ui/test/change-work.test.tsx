import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATES } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { SCREENS } from "../src/app/screens.js";
import { CW_SCREENS, SCREEN_COMPONENTS } from "../src/screens/registry.js";
import {
  ChangeWork,
  CwHead,
  EXPLAIN_FOLD,
  Explain,
  NEEDS_ATTENTION,
  StageBadge,
} from "../src/screens/work/cw.js";
import { ChangeList, HandoffChip, Pipeline, type ChangeSummary } from "../src/screens/Changes.js";
import { PastChangesView } from "../src/screens/work/Cockpit.js";
import { TaskList } from "../src/screens/work/Stage.js";
import { taskStep } from "../src/screens/work/next.js";

/**
 * beta.26: the change and work screens in the IDE look. Each sits in ChangeWork (the scope of
 * cw.css); a change page's head names the change, its id and its stage; a long explanation is cut
 * to two lines with More, its words whole in the page; the phases are a row of small named steps.
 */

const W = COPY.changeWork;
const C = COPY.changes;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** cw.css without its comments, and the declarations of the rule whose selector is exactly this. */
const CSS = readFileSync(new URL("../src/screens/work/cw.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rule = (selector: string): string => {
  const at = CSS.split("}").find((r) => r.split("{")[0]!.trim() === selector);
  if (!at) throw new Error(`no rule ${selector} in cw.css`);
  return at.split("{")[1]!;
};
const px = (selector: string) => Number(/font-size:\s*([\d.]+)px/.exec(rule(selector))?.[1]);

const row = (o: Partial<ChangeSummary> = {}): ChangeSummary => ({
  id: "add-note-tags",
  title: "Add note tags to every note in the notebook, searchable by tag",
  type: "feature",
  state: "design",
  openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
  ...o,
});

describe("the change and work screens' scope", () => {
  it("wraps every page of a change, Model runs, History and Flows, not the map's canvases", () => {
    const change = SCREENS.filter((s) => s.section === "Change").map((s) => s.id);
    for (const id of change.filter((x) => x !== "architecture" && x !== "change-diagram"))
      expect(CW_SCREENS.has(id), id).toBe(true);
    for (const id of ["runs", "history", "flows"]) expect(CW_SCREENS.has(id), id).toBe(true);
    // The map's canvas keeps its own look; Home, Questions, Knowledge and Set up aren't these.
    for (const id of ["architecture", "change-diagram", "home", "canvas", "questions", "repos"])
      expect(CW_SCREENS.has(id), id).toBe(false);
  });

  it("keeps a component for every page, the wrapped ones named after their page", () => {
    for (const s of SCREENS) expect(SCREEN_COMPONENTS[s.id], s.id).toBeDefined();
    expect(SCREEN_COMPONENTS.changes!.displayName).toBe("ChangeWork(changes)");
    expect(SCREEN_COMPONENTS.home!.displayName).not.toBe("ChangeWork(home)");
  });

  it("renders its page inside the cw root", () => {
    const out = renderToStaticMarkup(
      <ChangeWork>
        <p>page</p>
      </ChangeWork>,
    );
    expect(out).toBe('<div class="cw"><p>page</p></div>');
  });
});

describe("a change page's head", () => {
  it("names the change in full words that wrap, its id under it, its badges and actions", () => {
    const out = renderToStaticMarkup(
      <CwHead
        title="Add note tags"
        sub="add-note-tags"
        badges={<StageBadge state="design" />}
        actions={<a href="#/runs">runs</a>}
      />,
    );
    // Its whole name is on the page, not only in a hover title.
    expect(out).toContain('<p class="cw-title">Add note tags</p>');
    expect(out).not.toContain("title=");
    expect(out).toContain('<span class="cw-sub">add-note-tags</span>');
    expect(out).toContain(`>${C.design}</span>`);
    expect(out).toContain('<div class="cw-head-actions"><a href="#/runs">runs</a></div>');
  });

  it("leaves out the line under the title and the actions when there are none", () => {
    const out = renderToStaticMarkup(<CwHead title="Fix note search ranking" />);
    expect(out).not.toContain("cw-head-sub");
    expect(out).not.toContain("cw-head-actions");
  });

  it("says the stage in words, and Blocked when a blocking finding is open", () => {
    expect(renderToStaticMarkup(<StageBadge state="release-ready" />)).toContain(`>${C.release}<`);
    expect(renderToStaticMarkup(<StageBadge state="design" />)).toContain(`>${C.design}<`);
    const blocked = renderToStaticMarkup(<StageBadge state="plan" blocked />);
    expect(blocked).toContain("chip blocking");
    expect(blocked).toContain(`>${C.blocked}<`);
  });

  it("has words for every lifecycle state, never the raw state", () => {
    expect(Object.keys(W.lifecycle).sort()).toEqual([...LIFECYCLE_STATES].sort());
    for (const s of LIFECYCLE_STATES) {
      const word = W.lifecycle[s];
      expect(word, s).toMatch(/^[A-Z]/);
      const out = renderToStaticMarkup(<StageBadge state={s} />);
      expect(out, s).toContain(`>${esc(word)}</span>`);
      expect(out, s).not.toContain(`>${s}<`);
    }
    expect(renderToStaticMarkup(<StageBadge state="released" />)).toContain(">Released<");
    expect(renderToStaticMarkup(<StageBadge state="post-release-review" />)).toContain(
      ">Post-release review<",
    );
    expect(renderToStaticMarkup(<StageBadge state="archived" />)).toContain(">Archived<");
    // A state the app doesn't know yet is shown as it is, quietly.
    expect(renderToStaticMarkup(<StageBadge state="someday" />)).toBe(
      '<span class="chip dim cw-badge">someday</span>',
    );
  });

  it("is amber only for a state that waits on someone, quiet otherwise", () => {
    expect([...NEEDS_ATTENTION].sort()).toEqual([
      "post-release-review",
      "release-ready",
      "returned",
    ]);
    for (const s of LIFECYCLE_STATES) {
      const out = renderToStaticMarkup(<StageBadge state={s} />);
      expect(out, s).toContain(`class="chip ${NEEDS_ATTENTION.has(s) ? "warn" : "dim"} cw-badge"`);
    }
    for (const s of ["draft", "define", "design", "plan", "build", "qa", "released", "archived"])
      expect(renderToStaticMarkup(<StageBadge state={s} />), s).not.toContain("warn");
    // Blocked wins over the state's own colour.
    expect(renderToStaticMarkup(<StageBadge state="returned" blocked />)).not.toContain("warn");
  });

  it("says a change's risk as a badge in sentence case", () => {
    expect(W.risk("low")).toBe("Low risk");
    expect(W.risk("high")).toBe("High risk");
  });
});

describe("an explanation", () => {
  const long = "Everything about this stage in one place, in order. ".repeat(4);

  it("is cut to two lines with More, its words all in the page", () => {
    expect(long.length).toBeGreaterThan(EXPLAIN_FOLD);
    const out = renderToStaticMarkup(<Explain text={long} />);
    expect(out).toContain('class="cw-explain cut"');
    expect(out).toContain(esc(long));
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(`>${W.more}</button>`);
    // More names the words it opens.
    const controls = /aria-controls="([^"]+)"/.exec(out)?.[1];
    expect(controls).toBeTruthy();
    expect(out).toContain(`id="${controls}"`);
    // Its name says what it opens, so two Mores on a page are told apart; it starts with More.
    expect(out).toContain(
      `aria-label="${esc(W.moreAbout("Everything about this stage in one…"))}"`,
    );
    expect(W.moreAbout("x").startsWith(W.more)).toBe(true);
    expect(W.lessAbout("x").startsWith(W.less)).toBe(true);
  });

  it("names its More by what the panel is about when told, and each More apart", () => {
    const a = renderToStaticMarkup(<Explain text={long} about="Similar past changes" />);
    expect(a).toContain(`aria-label="${esc(W.moreAbout("Similar past changes"))}"`);
    const b = renderToStaticMarkup(<Explain text={`Other words to read first. ${long}`} />);
    const name = (h: string) => /aria-label="([^"]+)"/.exec(h)?.[1];
    expect(name(b)).toBeTruthy();
    expect(name(a)).not.toBe(name(b));
  });

  it("is shown whole, without More, when it is short", () => {
    const out = renderToStaticMarkup(<Explain text="Files attached to this change." />);
    expect(out).toContain('class="cw-explain"');
    expect(out).not.toContain("<button");
  });
});

describe("a change's phases", () => {
  it("names each step by its phase and where it stands, the current one marked", () => {
    const out = renderToStaticMarkup(<Pipeline state="plan" />);
    expect(out).toContain(`aria-label="${C.phases}"`);
    expect(out).toContain(`aria-label="${esc(`${C.define}: ${C.done}`)}"`);
    expect(out).toContain(`aria-label="${esc(`${C.design}: ${C.done}`)}"`);
    expect(out).toContain(`aria-label="${esc(C.currentPhase(C.plan))}"`);
    expect(out).toContain(`aria-label="${esc(`${C.build}: ${C.toCome}`)}"`);
    expect(out.match(/aria-current="step"/g)).toHaveLength(1);
    expect(out).toContain('class="cw-gate now"');
    expect(out.match(/class="cw-gate done"/g)).toHaveLength(2);
  });
});

describe("words the screens no longer cut short (beta.26 review)", () => {
  it("wraps a change's title in its head in full, a long word broken anywhere", () => {
    const r = rule(".cw-title");
    expect(r).not.toMatch(/nowrap|ellipsis/);
    expect(r).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("clamps a list row's title to two lines and wraps its id, with no hover title", () => {
    const t = rule(".cw-row-title");
    expect(t).not.toMatch(/nowrap|ellipsis/);
    expect(t).toMatch(/-webkit-line-clamp:\s*2/);
    expect(t).toMatch(/overflow-wrap:\s*anywhere/);
    const sub = rule(".cw-row-sub");
    expect(sub).not.toMatch(/nowrap|ellipsis/);
    expect(sub).toMatch(/overflow-wrap:\s*anywhere/);
    const list = renderToStaticMarkup(<ChangeList list={{ state: "ready", data: [row()] }} />);
    const link = /<a [^>]*class="cw-row"[^>]*>/.exec(list)?.[0];
    expect(link).toBeTruthy();
    expect(link).not.toContain("title=");
    expect(list).toContain(`<span class="cw-row-title">${esc(row().title)}</span>`);
  });

  it("shows Find a change as a visible label", () => {
    const list = renderToStaticMarkup(<ChangeList list={{ state: "ready", data: [row()] }} />);
    expect(list).toContain(`<label for="change-filter" class="cw-label">${C.findAChange}</label>`);
  });

  it("wraps an earlier change's summary in full, not one cut monospace line", () => {
    const summary =
      "Business customers hit the daily transfer limit when paying suppliers at the end of each month.";
    const out = renderToStaticMarkup(
      <PastChangesView
        r={{
          how: "meaning",
          changes: [
            {
              id: "2026-05-12-raise-transfer-limit",
              change: "raise-transfer-limit",
              title: "Raise the daily transfer limit",
              archived: "2026-05-12",
              summary,
              file: "openspec/changes/archive/2026-05-12-raise-transfer-limit/brief.md",
              score: 3.2,
            },
          ],
        }}
      />,
    );
    expect(out).toContain(`<p class="cw-past-summary">${esc(summary)}</p>`);
    expect(out).not.toContain("cw-row-sub");
    expect(rule(".cw-past-summary")).not.toMatch(/nowrap|ellipsis/);
  });

  it("lets At a glance's stage rows wrap inside the side column", () => {
    expect(rule(".cw-stages > li")).toMatch(/flex-wrap:\s*wrap/);
    expect(CSS).not.toMatch(/\.cw-stages \.cw-row-sub\s*\{[^}]*flex:\s*none/);
    expect(rule(".cw-stages .cw-row-sub")).toMatch(/white-space:\s*normal/);
  });

  it("keeps headings in a panel's document in a descending size order", () => {
    const sizes = [
      ".cw .panel h1",
      ".cw .panel h2:not(.h)",
      ".cw .panel h3:not(.hud):not(.h)",
      ".cw .panel h4",
    ].map(px);
    for (const s of sizes) expect(s).toBeGreaterThan(0);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThan(sizes[i - 1]!);
  });
});

describe("a change's hand-off chip", () => {
  const pr = "https://git.example.com/forge/forge-notes/pull/42";

  it("shows its PR as a short link, the whole address its href, so a narrow panel doesn't scroll", () => {
    const out = renderToStaticMarkup(
      <HandoffChip handoff={{ phase: "design", state: "merged", pr }} />,
    );
    expect(out).toContain(`href="${pr}"`);
    expect(out).toContain(`>${W.prShort("42")}<`);
    // The address is not in the chip's words.
    expect(out.replace(/href="[^"]*"/g, "")).not.toContain("git.example.com");
    expect(out).toContain(esc(C.handOff("DESIGN", "MERGED", "")));
    expect(rule(".cw-chips > .chip")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".cw-chips > .chip")).toMatch(/max-width:\s*100%/);
    expect(rule(".cw-chips > .chip")).toMatch(/white-space:\s*normal/);
  });

  it("says a PR with no number as PR, and a hand-off with no PR without a link", () => {
    expect(W.prShort()).toBe("PR");
    const none = renderToStaticMarkup(<HandoffChip handoff={{ phase: "plan", state: "open" }} />);
    expect(none).not.toContain("<a ");
    expect(none).toContain(esc(C.handOff("PLAN", "OPEN", "")));
  });
});

describe("a task's commands", () => {
  it("names each task's terminal fold apart, and keeps both its commands inside it", () => {
    const change = "add-note-tags";
    const tasks = [
      { id: "1.1", repo: "forge-notes", description: "Add the tag column", done: false },
      { id: "1.2", repo: "forge-notes", description: "Search by tag", done: false },
    ];
    const out = renderToStaticMarkup(<TaskList change={change} tasks={tasks} />);
    for (const t of tasks) {
      expect(W.fromTerminalFor(t.id).startsWith(COPY.work.fromTerminal)).toBe(true);
      const at = out.indexOf(`aria-label="${esc(W.fromTerminalFor(t.id))}"`);
      expect(at, t.id).toBeGreaterThan(-1);
      const fold = out.slice(out.lastIndexOf("<details", at), out.indexOf("</details>", at));
      const s = taskStep(change, t);
      expect(fold, t.id).toContain(esc(s.command));
      expect(fold, t.id).toContain(esc(s.slash!.command));
    }
  });
});
