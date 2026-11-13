import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  callAsJob,
  getAsJob,
  JobStopped,
  onWrote,
  readAsJob,
  stopJob,
} from "../src/api/client.js";
import { CorrectionNextPanel } from "../src/app/correction-next.js";
import { JobStoppedNote, JobWait } from "../src/app/job-wait.js";
import { COPY } from "../src/copy.js";
import { Pairing } from "../src/screens/architecture/Connect.js";

/**
 * Beta.28.1 (the owner's field reports 2 and 3, local API 3.14.0): nothing slow runs silently.
 * A read the person waits on (the Connect panel's calls and APIs, Edit the map's pairing, a
 * correction's candidates, the preview of the next Apply) is asked as a job: the page shows the
 * job's last line and a Stop, and says when it was stopped. An older server's own answer is
 * taken as it is.
 */

const W = COPY.app.jobWait;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
afterEach(() => vi.unstubAllGlobals());

type Answer = { status: number; body: unknown };
function serve(answers: (path: string, init: RequestInit | undefined) => Answer) {
  vi.stubGlobal("document", { querySelector: () => null });
  const calls: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const a = answers(path, init);
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
const now = async () => undefined;
const running = (message: string) => ({
  status: 200,
  body: { state: "running", errors: [], progress: { done: 0, total: 1, message } },
});

describe("a read the person waits on, as a job", () => {
  it("asks with job=1, hears each new line once, and gives the read's own answer", async () => {
    const said = ["Reading the estate's facts", "Reading the estate's facts", "Joining"];
    let n = 0;
    const calls = serve((path) =>
      path.startsWith("/api/links/candidates")
        ? { status: 202, body: { jobId: "job-1" } }
        : n < said.length
          ? running(said[n++]!)
          : { status: 200, body: { state: "done", errors: [], result: { answer: { ok: 1 } } } },
    );
    const lines: string[] = [];
    let job = "";
    const r = await getAsJob<{ ok: number }>("/api/links/candidates?from=a&to=b", {
      wait: now,
      onLine: (l) => lines.push(l),
      onJob: (id) => (job = id),
    });
    expect(r).toEqual({ ok: 1 });
    expect(job).toBe("job-1");
    expect(lines).toEqual(["Reading the estate's facts", "Joining"]);
    expect(calls[0]!.path).toBe("/api/links/candidates?from=a&to=b&job=1");
    expect(calls[0]!.method).toBe("GET");
  });

  it("a path without a query gets ?job=1; an older server's own answer is taken as it is", async () => {
    const calls = serve(() => ({ status: 200, body: { steps: [] } }));
    expect(await getAsJob("/api/facts/forge-billing/preview", { wait: now })).toEqual({
      steps: [],
    });
    expect(calls[0]!.path).toBe("/api/facts/forge-billing/preview?job=1");
  });

  it("a stopped read throws JobStopped; a refusal throws its problem", async () => {
    serve((path) =>
      path.startsWith("/api/x")
        ? { status: 202, body: { jobId: "job-2" } }
        : { status: 200, body: { state: "cancelled", errors: [] } },
    );
    const e = await getAsJob("/api/x", { wait: now }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JobStopped);
    expect((e as Error).message).toBe(COPY.app.jobEnded("cancelled", ""));
    serve((path) =>
      path.startsWith("/api/x")
        ? { status: 202, body: { jobId: "job-3" } }
        : {
            status: 200,
            body: {
              state: "done",
              errors: [],
              result: { problem: { type: "x", title: "Not found", status: 404, detail: "no" } },
            },
          },
    );
    const p = await getAsJob("/api/x", { wait: now }).catch((x: unknown) => x);
    expect(p).toBeInstanceOf(ApiError);
    expect((p as ApiError).problem.status).toBe(404);
  });

  it("a page that went stops following (the job is left to finish)", async () => {
    const calls = serve((path) =>
      path.startsWith("/api/x") ? { status: 202, body: { jobId: "job-4" } } : running("still"),
    );
    const ctl = new AbortController();
    const e = await getAsJob("/api/x", {
      wait: async () => ctl.abort(),
      signal: ctl.signal,
    }).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  });

  it("Stop is POST /api/jobs/{id}/cancel; a write as a job hears its lines too", async () => {
    let n = 0;
    const calls = serve((path) =>
      path === "/api/links/connect"
        ? { status: 202, body: { jobId: "job-5" } }
        : path.endsWith("/cancel")
          ? { status: 200, body: { id: "job-5", state: "cancelled" } }
          : n++ === 0
            ? running("Previewing the next Apply of forge-billing")
            : { status: 200, body: { state: "done", errors: [], result: { answer: { ok: 2 } } } },
    );
    const lines: string[] = [];
    expect(
      await callAsJob(
        "/api/links/connect",
        { preview: true },
        { wait: now, onLine: (l) => lines.push(l) },
      ),
    ).toEqual({ ok: 2 });
    expect(lines).toEqual(["Previewing the next Apply of forge-billing"]);
    expect(calls[0]!.body).toEqual({ preview: true, job: true });
    await stopJob("job-5");
    expect(calls.at(-1)).toMatchObject({ path: "/api/jobs/job-5/cancel", method: "POST" });
  });
});

describe("a preview as a job writes nothing (the review of beta.28.1)", () => {
  it("callAsJob with write false: a Stop is JobStopped, and no page hears a write", async () => {
    let heard = 0;
    const off = onWrote(() => heard++);
    try {
      serve((path) =>
        path === "/api/links/connect"
          ? { status: 202, body: { jobId: "job-8" } }
          : { status: 200, body: { state: "cancelled", errors: [] } },
      );
      const e = await callAsJob(
        "/api/links/connect",
        { preview: true },
        { wait: now, write: false },
      ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(JobStopped);
      serve((path) =>
        path === "/api/links/connect"
          ? { status: 202, body: { jobId: "job-9" } }
          : { status: 200, body: { state: "done", errors: [], result: { answer: { ok: 3 } } } },
      );
      expect(
        await callAsJob("/api/links/connect", { preview: true }, { wait: now, write: false }),
      ).toEqual({ ok: 3 });
      expect(heard).toBe(0);
      // A write as a job is heard as one, and its Stop keeps its problem (its callers read one).
      serve((path) =>
        path === "/api/x"
          ? { status: 202, body: { jobId: "job-10" } }
          : { status: 200, body: { state: "done", errors: [], result: { answer: {} } } },
      );
      await callAsJob("/api/x", {}, { wait: now });
      expect(heard).toBeGreaterThan(0);
    } finally {
      off();
    }
  });
});

describe("a read nobody waits on any more is stopped (the review of beta.28.1)", () => {
  it("the panel goes while its read runs: the job is stopped", async () => {
    const calls = serve((path) =>
      path.startsWith("/api/links/candidates")
        ? { status: 202, body: { jobId: "job-11" } }
        : path.endsWith("/cancel")
          ? { status: 200, body: {} }
          : running("Joining the estate's calls and APIs"),
    );
    const ctl = new AbortController();
    const lines: string[] = [];
    const e = await readAsJob(
      "/api/links/candidates?from=a&to=b",
      ctl.signal,
      {
        onLine: (l) => lines.push(l),
      },
      async () => ctl.abort(),
    ).catch((x: unknown) => x);
    expect((e as Error).name).toBe("AbortError");
    expect(lines).toEqual(["Joining the estate's calls and APIs"]);
    expect(calls.some((c) => c.path === "/api/jobs/job-11/cancel" && c.method === "POST")).toBe(
      true,
    );
  });

  it("two panels on one job: the first that goes stops nothing, the last one stops it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = serve((path) =>
      path.startsWith("/api/links/candidates")
        ? { status: 202, body: { jobId: "job-13" } }
        : path.endsWith("/cancel")
          ? { status: 200, body: {} }
          : running("Joining the estate's calls and APIs"),
    );
    const a = new AbortController();
    const b = new AbortController();
    const path = "/api/links/candidates?from=a&to=c";
    const wait = () => held;
    const ra = readAsJob(path, a.signal, {}, wait).catch((x: unknown) => x);
    const rb = readAsJob(path, b.signal, {}, wait).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 10));
    a.abort();
    const cancels = () => calls.filter((c) => c.path === "/api/jobs/job-13/cancel").length;
    expect(cancels()).toBe(0);
    b.abort();
    expect(cancels()).toBe(1);
    release();
    await Promise.all([ra, rb]);
  });

  it("a page that went before the server named the job stops it once named", async () => {
    const calls = serve((path) =>
      path.startsWith("/api/y")
        ? { status: 202, body: { jobId: "job-14" } }
        : path.endsWith("/cancel")
          ? { status: 200, body: {} }
          : running("Reading the estate's facts"),
    );
    const ctl = new AbortController();
    const r = readAsJob("/api/y", ctl.signal, {}, now).catch((x: unknown) => x);
    ctl.abort();
    expect(((await r) as Error).name).toBe("AbortError");
    expect(calls.some((c) => c.path === "/api/jobs/job-14/cancel")).toBe(true);
  });

  it("a read that ended is never stopped afterwards", async () => {
    const calls = serve((path) =>
      path.startsWith("/api/x")
        ? { status: 202, body: { jobId: "job-12" } }
        : { status: 200, body: { state: "done", errors: [], result: { answer: { ok: 4 } } } },
    );
    const ctl = new AbortController();
    expect(await readAsJob("/api/x", ctl.signal, {}, now)).toEqual({ ok: 4 });
    ctl.abort();
    expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  });
});

describe("the wait as the page shows it", () => {
  it("JobWait: the wait's words, the job's last line, and a labelled Stop", () => {
    const out = renderToStaticMarkup(
      <JobWait
        what="Reading…"
        line="Joining the estate's calls and APIs"
        onStop={() => undefined}
      />,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(esc(W.now("Joining the estate's calls and APIs")));
    expect(out).toContain(`aria-label="${esc(W.stopLabel("Reading…"))}"`);
    expect(out).toContain(`>${W.stop}<`);
    const stopping = renderToStaticMarkup(
      <JobWait what="Reading…" onStop={() => undefined} stopping />,
    );
    expect(stopping).toContain(W.stopping);
    expect(stopping).toContain("disabled");
    // Before the server named its job there is no Stop, and no line.
    const bare = renderToStaticMarkup(<JobWait what="Reading…" />);
    expect(bare).not.toContain("<button");
    expect(bare).not.toContain(esc(W.now("")));
    // The live region is there, empty, before the first line: a screen reader hears each line.
    expect(bare).toContain('aria-live="polite"');
  });

  it("JobStoppedNote: says it was stopped and nothing changed, with Start it again", () => {
    const out = renderToStaticMarkup(<JobStoppedNote onAgain={() => undefined} />);
    expect(out).toContain(esc(W.stopped));
    expect(out).toContain(W.again);
    expect(renderToStaticMarkup(<JobStoppedNote />)).not.toContain("<button");
  });

  const box = { from: "forge-billing", box: { repo: "forge-partner-gateway" } };
  it("Connect: the candidates' wait shows the line and Stop; a stopped read says so", () => {
    const out = renderToStaticMarkup(
      <Pairing
        {...box}
        cands={{
          state: "loading",
          line: "Reading forge-partner-gateway's APIs",
          stop: () => undefined,
        }}
      />,
    );
    expect(out).toContain(esc(COPY.connect.loading));
    expect(out).toContain(esc(W.now("Reading forge-partner-gateway's APIs")));
    expect(out).toContain(`>${W.stop}<`);
    const stopped = renderToStaticMarkup(
      <Pairing
        {...box}
        cands={{ state: "error", error: "x", stopped: true, reload: () => undefined }}
      />,
    );
    expect(stopped).toContain(esc(W.stopped));
    expect(stopped).not.toContain('role="alert"');
  });

  it("after a correction: the preview's wait shows the line and Stop; stopped says so", () => {
    const panel = (preview: Parameters<typeof CorrectionNextPanel>[0]["preview"]) =>
      renderToStaticMarkup(
        <CorrectionNextPanel file="facts/a.corrections.jsonl" preview={preview} />,
      );
    const out = panel({ state: "loading", line: "Building the catalog", stop: () => undefined });
    expect(out).toContain(esc(COPY.correctionNext.loading));
    expect(out).toContain(esc(W.now("Building the catalog")));
    expect(out).toContain(`>${W.stop}<`);
    const stopped = panel({ state: "error", error: "x", stopped: true });
    expect(stopped).toContain(esc(W.stopped));
    expect(stopped).not.toContain(esc(COPY.correctionNext.failed("x")));
  });
});
