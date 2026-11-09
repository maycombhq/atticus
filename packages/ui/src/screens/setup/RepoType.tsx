import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";
import { EditPreview, type FileEdit } from "./EditPreview.js";

/**
 * ADR 0190: a repo's type, on its row of Set up › Repos. Detect the type reads the clone's files
 * (the org pack's repo types, atticus repo-type detect, when it has any); the type, detected or
 * typed (prototype, say), is set in the manifest through the preview and proposed for review.
 */

const S = COPY.setup;

export function RepoType({
  repo,
  type,
  onChanged,
}: {
  repo: string;
  type: string;
  onChanged?: () => void;
}) {
  const detect = useAction();
  const [found, setFound] = useState<Api.RepoTypeDetectViewT>();
  const [value, setValue] = useState(type);
  const [round, setRound] = useState(0);
  // Written: its Propose stays shown after the list reads the new type back.
  const [wrote, setWrote] = useState(false);
  const id = `repo-${repo}-type`;
  const put = (preview: boolean) =>
    api<FileEdit>(`/api/repos/${encodeURIComponent(repo)}/type`, {
      method: "PUT",
      body: { type: value.trim(), ...(preview ? { preview: true } : {}) },
    });
  return (
    <div className="stack" style={{ gap: 6, margin: "8px 0" }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <label htmlFor={id} className="muted" style={{ fontSize: 12 }}>
            {S.type}
          </label>
          <input
            id={id}
            className="field mono"
            value={value}
            aria-describedby={`${id}-hint`}
            onChange={(e) => {
              setValue(e.target.value);
              setWrote(false);
              setRound(round + 1);
            }}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={detect.busy}
          aria-label={S.detectFor(repo)}
          onClick={() =>
            void detect.run(
              async () => {
                const d = await api<Api.RepoTypeDetectViewT>(
                  `/api/repos/${encodeURIComponent(repo)}/type/detect`,
                  { method: "POST" },
                );
                setFound(d);
                if (d.type) {
                  setValue(d.type);
                  setRound(round + 1);
                }
                return d;
              },
              (d) =>
                d.from === "repo-types"
                  ? S.detectedTypes(d.verdict, d.type)
                  : d.type
                    ? S.detected(d.type)
                    : S.noType,
            )
          }
        >
          {detect.busy ? S.detecting : S.detect}
        </button>
      </div>
      <span id={`${id}-hint`} className="muted" style={{ fontSize: 12 }}>
        {S.typeHint}
      </span>
      <Note note={detect.note} />
      {found?.signals && found.signals.length > 0 && (
        <p className="muted mono" style={{ margin: 0, fontSize: 12 }}>
          {found.signals.join(", ")}
        </p>
      )}
      {((value.trim() && value.trim() !== type) || wrote) && (
        <EditPreview
          key={round}
          label={S.setType}
          preview={() => put(true)}
          write={() => put(false)}
          onWritten={() => {
            setWrote(true);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
