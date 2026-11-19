import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { stopJob } from "../../api/client.js";
import { followJob, JobFailed } from "../../app/job.js";
import { JobWait } from "../../app/job-wait.js";
import { Propose } from "../../app/propose.js";
import { Command } from "../work/RunNext.js";
import { COPY } from "../../copy.js";

/**
 * ADR 0204 decision 4: Sync, read and apply these N, one job of four parts (POST
 * /api/setup/repos/run). The page says the part, the repo and the time left, offers Stop
 * (heard between parts and repos), and after a Stop reads Continue: N left (the parts are worked
 * out from disk). Where the app can't start the assistant the job pauses with the command to
 * paste and I've read them: continue. Nothing here commits or pushes.
 */

const W = COPY.connectAB;
type Repos = Api.ReposRunRequestT["repos"];
export interface RunIo {
  follow: (
    body: Api.ReposRunRequestT,
    onJob: (id: string) => void,
    onLine: (line: string) => void,
  ) => Promise<Api.ReposRunResultT>;
  stop: (job: string) => Promise<unknown>;
}
const APP: RunIo = {
  follow: async (body, onJob, onLine) => {
    try {
      const r = await followJob("/api/setup/repos/run", body, undefined, onJob, (p) =>
        onLine(p.message),
      );
      return r.result as Api.ReposRunResultT;
    } catch (e) {
      // A part failed (a clone refused) or a Stop: the parts still say where each stands.
      if (e instanceof JobFailed && Array.isArray(e.result?.parts))
        return e.result as unknown as Api.ReposRunResultT;
      throw e;
    }
  },
  stop: (job) => stopJob(job),
};

/** How many repos the run hasn't put on the map yet. */
export const leftOf = (r: Api.ReposRunResultT) => r.of - r.done;

export function RunNewRepos(p: { repos: Repos; platform?: string; io?: RunIo }) {
  const io = p.io ?? APP;
  const [busy, setBusy] = useState<{ job?: string; line?: string; stopping?: boolean }>();
  const [res, setRes] = useState<Api.ReposRunResultT>();
  const [error, setError] = useState<string | undefined>();
  const go = (read = false) => {
    setBusy({});
    setError(undefined);
    io.follow(
      {
        repos: p.repos,
        ...(p.platform ? { platform: p.platform } : {}),
        ...(read ? { read } : {}),
      },
      (job) => setBusy((b) => ({ ...b, job })),
      (line) => setBusy((b) => ({ ...b, line })),
    )
      .then(setRes, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(undefined));
  };
  const n = p.repos.length;
  const waiting = !!res?.handoff;
  const left = res ? leftOf(res) : n;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {!busy && !waiting && (!res || left > 0) && (
        <button type="button" className="btn primary" disabled={n === 0} onClick={() => go()}>
          {res ? W.continue(left) : W.run(n)}
        </button>
      )}
      {busy && (
        <JobWait
          what={busy.line ?? W.noEstimate}
          line={busy.line}
          onStop={
            busy.job
              ? () => {
                  setBusy((b) => (b ? { ...b, stopping: true } : b));
                  void io.stop(busy.job!);
                }
              : undefined
          }
          stopping={!!busy.stopping}
        />
      )}
      {res && (
        <ul className="stack" style={{ gap: 2, margin: 0, paddingLeft: 18 }}>
          {res.parts.map((x) => (
            <li key={x.part}>
              <span className="hud">{W.partWords[x.part]}</span>{" "}
              {x.repos
                .map((r) => `${r.repo} (${W.repoState[r.state]}${r.why ? `: ${r.why}` : ""})`)
                .join(", ")}
            </li>
          ))}
        </ul>
      )}
      {res?.handoff && !busy && (
        <div className="stack" role="status">
          <p className="ev-say">{W.readHandoff}</p>
          <Command text={res.handoff.command} label={W.readHandoff} noRun />
          <button type="button" className="btn primary" onClick={() => go(true)}>
            {W.readDone}
          </button>
        </div>
      )}
      {res && !res.handoff && !busy && (
        <div className="stack" role="status">
          <p className="ev-say">{W.onMap(res.done, res.of)}</p>
          {res.done > 0 && (
            <a className="btn" href="#/map">
              {W.showThem}
            </a>
          )}
          <Propose scope="org-pack" />
        </div>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </div>
  );
}
