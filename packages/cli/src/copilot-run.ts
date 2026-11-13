import type { Api } from "@maycombhq/core";
import type { MapAllEvent } from "./map-all.js";

/**
 * ADR 0173: one unattended Copilot run started from the app, as the app shows it: its progress
 * from `map --all`'s events, and its lines split into Console tabs (the run's own first, then one
 * per session, which keeps the lines from the session's start to the verify after it). Pure: the
 * route feeds it and publishes what it gives back.
 */

/** The most lines a tab keeps; older ones are dropped, and `from` says how many. */
export const TAB_LINES = 5000;

type Tab = Api.CopilotRunTabT;

export interface NewLines {
  tab: string;
  title: string;
  at: number;
  lines: string[];
}

export class CopilotRun {
  readonly view: Api.CopilotRunViewT;
  private current = "run";

  constructor(o: {
    runId: string;
    jobId: string;
    kind: Api.CopilotRunKindT;
    repos?: string[];
    force?: boolean;
    by?: string;
    model?: string;
    startedAt: string;
  }) {
    this.view = {
      runId: o.runId,
      jobId: o.jobId,
      kind: o.kind,
      ...(o.repos?.length ? { repos: o.repos } : {}),
      ...(o.force ? { force: true } : {}),
      state: "running",
      ...(o.by ? { by: o.by } : {}),
      ...(o.model ? { model: o.model } : {}),
      startedAt: o.startedAt,
      progress: { repos: 0, repoIndex: 0, sessions: 0 },
      totals: { kept: 0, rejected: 0, tokens: 0 },
      tabs: [{ id: "run", title: "Run", state: "running", from: 0, lines: [] }],
    };
  }

  private tab(id: string): Tab {
    return this.view.tabs.find((t) => t.id === id) ?? this.view.tabs[0]!;
  }

  private push(id: string, lines: string[]): NewLines {
    const t = this.tab(id);
    const at = t.from + t.lines.length;
    t.lines.push(...lines);
    if (t.lines.length > TAB_LINES) {
      const drop = t.lines.length - TAB_LINES;
      t.lines.splice(0, drop);
      t.from += drop;
    }
    return { tab: t.id, title: t.title, at, lines };
  }

  /** A line the run printed: into the session under way (or just ended, until the next repo). */
  line(text: string): NewLines {
    return this.push(this.current, [text]);
  }

  /** A step of the run: progress, and the tabs it opens or closes. Returns the lines it adds. */
  event(e: MapAllEvent): NewLines[] {
    const v = this.view;
    const out: NewLines[] = [];
    switch (e.type) {
      case "plan":
        v.progress.repos = e.repos.length;
        break;
      case "repo":
        v.progress.repoIndex = e.index;
        v.progress.repos = e.total;
        v.progress.repo = e.repo;
        delete v.progress.session;
        this.current = "run";
        break;
      case "session": {
        const id = `s${v.progress.sessions + 1}`;
        v.progress.sessions++;
        const title = `${e.repo}, ${e.label}${e.attempt ? " (again)" : ""}`;
        v.progress.session = title;
        v.tabs.push({ id, title, repo: e.repo, state: "running", from: 0, lines: [] });
        out.push(this.push("run", [`Session ${v.progress.sessions}: ${title}`]));
        this.current = id;
        break;
      }
      case "session.end": {
        const t = v.tabs.findLast((x) => x.repo === e.repo && x.state === "running");
        if (t) {
          t.state = e.failed ? "failed" : "ended";
          t.ended = e.failed ?? e.ended;
          out.push(this.push("run", [`${t.title}: ended (${t.ended})`]));
        }
        if (e.tokens) v.totals.tokens += e.tokens;
        delete v.progress.session;
        break;
      }
      case "repo.stopped": {
        // beta.27: a Problem the page shows, and a line in the run's tab saying why.
        const { type: _t, ...problem } = e;
        (v.problems ??= []).push(problem);
        out.push(this.push("run", [`Stopped: ${e.message}`]));
        break;
      }
      case "verify":
        v.totals.kept += e.kept;
        v.totals.rejected += e.rejected;
        if (this.current !== "run")
          out.push(
            this.push("run", [
              `${e.repo}: ${e.kept} kept, ${e.rejected} rejected, coverage ${Math.round(e.coverage * 100)}%, ${e.open} open`,
            ]),
          );
        break;
    }
    return out;
  }

  /** How it ended: done, stopped by a person, or failed with the error said. */
  /** `said` replaces the run's last line (beta.28: a Stop whose work is still ending says so). */
  finish(
    state: Exclude<Api.CopilotRunStateT, "running">,
    at: string,
    message?: string,
    said?: string,
  ): NewLines {
    const v = this.view;
    v.state = state;
    v.finishedAt = at;
    if (message) v.message = message;
    for (const t of v.tabs)
      if (t.state === "running") {
        t.state = state === "failed" ? "failed" : "ended";
        if (t.id !== "run") t.ended ??= state;
      }
    this.current = "run";
    return this.push("run", [
      said ??
        (state === "done"
          ? "The run finished."
          : state === "stopped"
            ? "Stopped. The next run carries on from here."
            : `The run stopped: ${message ?? "an error"}`),
    ]);
  }

  /** The state without the lines, for the live event. */
  summary(): Omit<Api.CopilotRunViewT, "tabs"> {
    const { tabs: _tabs, ...rest } = this.view;
    return structuredClone(rest);
  }
}
