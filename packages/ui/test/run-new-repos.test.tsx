import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";
import { COPY } from "../src/copy.js";

/**
 * ADR 0204 decision 4 on the page: one button for the three new repos, the part and repo said
 * while it runs with Stop, Continue: N left after a Stop, the hand-off pause with what to paste
 * and I've read them: continue, and the end ("N of M are on the map.") with Show them.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/app/propose.js", () => ({ Propose: () => null }));
const { RunNewRepos } = await import("../src/screens/setup/RunNewRepos.js");

const W = COPY.connectAB;
const repos = ["forge-fx", "forge-rates", "forge-tax"].map((id) => ({
  id,
  url: `https://git.forge.example/forge/${id}.git`,
}));
const part = (
  p: Api.ReposRunPartT["part"],
  state: Api.ReposRunPartT["state"],
): Api.ReposRunPartT => ({ part: p, state, repos: repos.map((r) => ({ repo: r.id, state })) });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function open(answers: Api.ReposRunResultT[]) {
  const sent: Api.ReposRunRequestT[] = [];
  const stopped: string[] = [];
  let release: (() => void) | undefined;
  const m = mount(
    RunNewRepos as never,
    {
      repos,
      io: {
        follow: (
          body: Api.ReposRunRequestT,
          onJob: (id: string) => void,
          onLine: (l: string) => void,
        ) => {
          sent.push(body);
          onJob("job-1");
          onLine("Part 2 of 4: syncing forge-fx (1 of 3). No estimate yet.");
          return new Promise((res) => {
            release = () => res(answers.shift()!);
          });
        },
        stop: (job: string) => {
          stopped.push(job);
          return Promise.resolve();
        },
      },
    } as never,
  );
  const button = (name: string) =>
    all(m.tree).find((e) => e.type === "button" && text(e.props.children) === name);
  const done = async () => {
    release!();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
  };
  return { m, button, sent, stopped, done };
}

describe("Sync, read and apply these N (ADR 0204 4.1 to 4.5)", () => {
  it("runs, says where it is with Stop, and continues after a Stop", async () => {
    const t = open([
      { parts: [part("add", "done"), part("sync", "stopped")], done: 0, of: 3 },
      {
        parts: ["add", "sync", "read", "apply"].map((x) => part(x as never, "done")),
        done: 3,
        of: 3,
      },
    ]);
    (t.button(W.run(3))!.props.onClick as () => void)();
    await tick();
    t.m.render();
    // JobWait is the panel's own; its Stop prop is the job's.
    const wait = all(t.m.tree).find((e) => typeof e.props.onStop === "function")!;
    expect(wait.props.what).toBe("Part 2 of 4: syncing forge-fx (1 of 3). No estimate yet.");
    (wait.props.onStop as () => void)();
    expect(t.stopped).toEqual(["job-1"]);
    await t.done();
    expect(t.button(W.continue(3))).toBeDefined();
    (t.button(W.continue(3))!.props.onClick as () => void)();
    await t.done();
    expect(t.sent).toEqual([{ repos }, { repos }]);
    expect(text(t.m.tree)).toContain(W.onMap(3, 3));
    expect(all(t.m.tree).some((e) => e.type === "a" && e.props.href === "#/map")).toBe(true);
  });

  it("pauses with the command to paste, and goes on with I've read them", async () => {
    const t = open([
      {
        parts: [part("add", "done"), part("sync", "done"), part("read", "waiting")],
        handoff: {
          command: "/atticus-map forge-fx\n/atticus-map forge-rates\n/atticus-map forge-tax",
        },
        done: 0,
        of: 3,
      },
      {
        parts: ["add", "sync", "read", "apply"].map((x) => part(x as never, "done")),
        done: 3,
        of: 3,
      },
    ]);
    (t.button(W.run(3))!.props.onClick as () => void)();
    await t.done();
    expect(text(t.m.tree)).toContain(W.readHandoff);
    expect(t.button(W.run(3))).toBeUndefined();
    (t.button(W.readDone)!.props.onClick as () => void)();
    await t.done();
    expect(t.sent[1]).toEqual({ repos, read: true });
    expect(text(t.m.tree)).toContain(W.onMap(3, 3));
  });
});
