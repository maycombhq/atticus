import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { SCREENS } from "../src/app/screens.js";
import { CW_SCREENS, SCREEN_COMPONENTS } from "../src/screens/registry.js";
import { ChangeWork, CwHead, EXPLAIN_FOLD, Explain, StageBadge } from "../src/screens/work/cw.js";
import { Pipeline } from "../src/screens/Changes.js";

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
  it("names the change, whole on hover, its id under it, its badges and actions", () => {
    const out = renderToStaticMarkup(
      <CwHead
        title="Add note tags"
        sub="add-note-tags"
        badges={<StageBadge state="design" />}
        actions={<a href="#/runs">runs</a>}
      />,
    );
    expect(out).toContain('<p class="cw-title" title="Add note tags">Add note tags</p>');
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
    const blocked = renderToStaticMarkup(<StageBadge state="plan" blocked />);
    expect(blocked).toContain("chip blocking");
    expect(blocked).toContain(`>${C.blocked}<`);
    // A state the app has no word for is shown as it is.
    expect(renderToStaticMarkup(<StageBadge state="archived" />)).toContain(">archived<");
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
