import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import type { JobFollow } from "../src/api/client.js";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.28.1 (the owner's field reports 2 and 3): the Connect panel's Preview, asked as a job,
 * shows the job's last line under the buttons with a Stop that cancels the job; a preview that
 * was stopped says so (not an error). Correct on a pairing shows the candidates' wait with its
 * line and Stop. Rendered with the tiny hooks runtime, no DOM.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { COPY } = await import("../src/copy.js");
const { JobStopped } = await import("../src/api/client.js");
const { JobStoppedNote, JobWait } = await import("../src/app/job-wait.js");
const { Pairing } = await import("../src/screens/architecture/Connect.js");
const { CorrectDecision } = await import("../src/app/decisions.js");

afterEach(() => vi.unstubAllGlobals());
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (tree: unknown, label: string) =>
  all(tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
const waits = (tree: unknown) => all(tree).filter((e) => e.type === JobWait);

const view: Api.LinkCandidatesViewT = {
  from: "forge-billing",
  to: { repo: "gw" },
  toName: "gw",
  calls: [
    {
      fact: "a",
      callType: "rest",
      method: "GET",
      path: "/a",
      at: "x:1",
      status: "left",
      suggestion: { api: "e1", score: 0.9, why: "same-path" },
      confident: true,
    },
  ],
  apis: [{ id: "e1", kind: "route", path: "/a" }],
};

describe("Connect's Preview as a job", () => {
  it("shows the job's last line and a Stop that cancels the job, then the preview", async () => {
    const cancels: string[] = [];
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        cancels.push(path);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    let finish!: () => void;
    const sent: { preview?: boolean }[] = [];
    const m = mount(
      Pairing as never,
      {
        from: "forge-billing",
        box: { repo: "gw" },
        cands: { state: "ready", data: view },
        post: async (b: { preview?: boolean }, follow?: JobFollow) => {
          sent.push(b);
          follow?.onJob?.("job-7");
          follow?.onLine?.("Previewing the next Apply of forge-billing");
          await new Promise<void>((r) => (finish = r));
          return { written: false, file: "f", lines: ["l"], verify: "v", commit: "c" };
        },
      } as never,
    );
    (button(m.tree, COPY.connect.preview).props.onClick as () => void)();
    await flush();
    m.render();
    const w = waits(m.tree);
    expect(w).toHaveLength(1);
    expect(w[0]!.props.what).toBe(COPY.connect.previewing);
    expect(w[0]!.props.line).toBe("Previewing the next Apply of forge-billing");
    (w[0]!.props.onStop as () => void)();
    await flush();
    m.render();
    expect(cancels).toContain("/api/jobs/job-7/cancel");
    expect(waits(m.tree)[0]!.props.stopping).toBe(true);
    finish();
    await flush();
    m.render();
    expect(waits(m.tree)).toHaveLength(0);
    expect(sent[0]!.preview).toBe(true);
  });

  it("a preview stopped says so, not as an error", async () => {
    const m = mount(
      Pairing as never,
      {
        from: "forge-billing",
        box: { repo: "gw" },
        cands: { state: "ready", data: view },
        post: async () => {
          throw new JobStopped();
        },
      } as never,
    );
    (button(m.tree, COPY.connect.preview).props.onClick as () => void)();
    await flush();
    m.render();
    expect(all(m.tree).some((e) => e.type === JobStoppedNote)).toBe(true);
    expect(all(m.tree).some((e) => e.props.role === "alert")).toBe(false);
  });
});

describe("Correct on a pairing: the candidates' wait", () => {
  it("shows the read's line and its Stop while the other repo's APIs are read", () => {
    const stop = () => undefined;
    const m = mount(
      CorrectDecision as never,
      {
        d: {
          kind: "link",
          item: "link:forge-billing:call.a",
          repo: "forge-billing",
          what: "forge-billing GET /a → gw GET /a",
          decided: "e1",
          to: { repo: "gw", path: "/a", method: "GET" },
          runtime: "copilot-acp",
          run: "run-1",
          at: "2026-11-08T10:15:00Z",
          cites: [],
        },
        apis: { state: "loading", line: "Joining the estate's calls and APIs", stop },
        repos: { state: "ready", data: [{ id: "gw" }] },
        onClose: () => undefined,
      } as never,
    );
    const w = waits(m.tree);
    expect(w).toHaveLength(1);
    expect(w[0]!.props.what).toBe(COPY.decisions.apisLoading);
    expect(w[0]!.props.line).toBe("Joining the estate's calls and APIs");
    expect(w[0]!.props.onStop).toBe(stop);
  });
});
