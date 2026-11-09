import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import type { Task } from "../src/screens/Changes.js";
import { PushAgain, runIsTheStep, TaskRunState, TaskTick } from "../src/screens/know/task-pr.js";

/**
 * App-only audit (API 3.3.0): an UNVERIFIED task's card says what is true now (a build command
 * set since), offers Build and raise PR and Run again; a task whose branch holds work the change
 * branch hasn't says so beside Mark done, and a person's decision to let it go is shown.
 */
const T = COPY.phase;
const CHANGE = "show-an-account-s-status";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const unverified = (repoBuilds: boolean): Task => ({
  id: "1.1",
  repo: "forge-ledger-core",
  description: "Step 1.1",
  done: false,
  branch: `task/${CHANGE}/1.1`,
  taskRun: {
    state: "unverified",
    level: "draft",
    branch: `task/${CHANGE}/1.1`,
    commit: "0123456789abcdef0123456789abcdef01234567",
    notes: ["forge-ledger-core has no build command in repos.manifest.yaml."],
  },
  unmerged: { commits: 1, branch: `task/${CHANGE}/1.1` },
  repoBuilds,
});

describe("an unverified task on the Task board (app-only audit)", () => {
  it("with no build command yet: says where to set it, and offers no build", () => {
    const html = renderToStaticMarkup(<TaskRunState change={CHANGE} task={unverified(false)} />);
    expect(html).toContain(
      esc(T.taskUnverified("forge-ledger-core", `task/${CHANGE}/1.1`, `change/${CHANGE}`)),
    );
    expect(html).not.toContain(`>${esc(T.buildAndRaise)}</button>`);
  });

  it("with a build command set since: says so and offers Build and raise PR", () => {
    const html = renderToStaticMarkup(<TaskRunState change={CHANGE} task={unverified(true)} />);
    expect(html).toContain(
      esc(T.taskUnverifiedBuildable("forge-ledger-core", `task/${CHANGE}/1.1`)),
    );
    expect(html).not.toContain(
      esc(T.taskUnverified("forge-ledger-core", `task/${CHANGE}/1.1`, `change/${CHANGE}`)),
    );
    expect(html).toContain(`>${esc(T.buildAndRaise)}</button>`);
    expect(html).toContain(esc(T.buildAndRaiseWhy));
  });

  it("Run again is its step too", () => {
    expect(runIsTheStep(unverified(true))).toBe(true);
  });

  it("Mark done says its code isn't in the change yet", () => {
    const html = renderToStaticMarkup(<TaskTick change={CHANGE} task={unverified(true)} />);
    expect(html).toContain(esc(T.taskUnmerged(`task/${CHANGE}/1.1`, 1, `change/${CHANGE}`)));
    expect(html).toContain(esc(T.tickTask));
  });

  it("a person's decision to let its work go is shown with why", () => {
    const t: Task = {
      ...unverified(true),
      done: true,
      decision: { by: "pat", at: "2026-11-09T10:00:00Z", reason: "Done in 1.2." },
    };
    delete t.unmerged;
    const html = renderToStaticMarkup(<TaskTick change={CHANGE} task={t} />);
    expect(html).toContain(esc(T.taskDecided("pat", "2026-11-09", "Done in 1.2.")));
  });
});

describe("a hand-off branch whose push failed (app-only audit)", () => {
  it("says it is here but not pushed, with Push again and why the click is enough", () => {
    const html = renderToStaticMarkup(
      <PushAgain change={CHANGE} branch={`handoff/${CHANGE}/plan`} />,
    );
    expect(html).toContain(esc(T.handoffUnpushed(`handoff/${CHANGE}/plan`)));
    expect(html).toContain(`>${esc(T.pushAgain)}</button>`);
    expect(html).toContain(esc(T.pushAgainWhy));
  });
});
