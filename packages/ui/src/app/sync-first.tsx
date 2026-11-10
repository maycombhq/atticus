import { useState } from "react";
import { COPY } from "../copy.js";
import { Note, useAction } from "../screens/know/common.js";
import { ShowInConsole } from "./activity.js";
import { followJob } from "./job.js";

const T = COPY.appStep;

/**
 * Review of beta.23 (ADR 0188): a step that needs a repo's base clone this machine doesn't have
 * (Apply, Apply to every repo, the read of a repo) ends with Sync the repos for those repos, not a
 * command to type. Once they are synced, the step is pressed again.
 */
export function SyncFirst({ repos, onSynced }: { repos: string[]; onSynced?: () => void }) {
  const act = useAction();
  const [jobId, setJobId] = useState<string | undefined>();
  const [synced, setSynced] = useState(false);
  if (!repos.length) return null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="work-say" style={{ margin: 0 }}>
        {synced ? T.syncFirstDone(repos.join(", ")) : T.syncFirstSay(repos.join(", "))}
      </p>
      {!synced && (
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          <button
            type="button"
            className="btn primary"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                await followJob("/api/workspace/sync", { repos }, undefined, setJobId);
                setSynced(true);
                onSynced?.();
              }, T.synced)
            }
          >
            {act.busy ? T.syncing : T.sync}
          </button>
          {act.busy && <ShowInConsole id={jobId} />}
        </div>
      )}
      <Note note={act.note} />
    </div>
  );
}
