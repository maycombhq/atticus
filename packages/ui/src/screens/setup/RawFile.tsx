import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi } from "../../api/client.js";
import { confirmed } from "../../api/confirm.js";
import { escapeCloses, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { EditPreview, type FileEdit } from "./EditPreview.js";

/**
 * ADR 0190: the fallback for a setting with no form, as the artifact editor edits a change's
 * files: the org-pack file's whole text, checked with its schema before it is written and only
 * onto the file as opened, previewed as lines, then proposed for review.
 */

const S = COPY.setup;

export function RawFileEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const f = useApi<Api.OrgPackFileViewT>(`/api/setup/file?path=${encodeURIComponent(path)}`);
  const [text, setText] = useState<string>();
  const [round, setRound] = useState(0);
  const id = `raw-${path.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <section
      className="stack"
      style={{ gap: 6 }}
      aria-labelledby={`${id}-t`}
      onKeyDown={escapeCloses(onClose)}
    >
      <h4 id={`${id}-t`} className="hud" style={{ margin: 0, fontSize: 11 }}>
        {S.rawTitle(f.state === "ready" ? f.data.path : path)}
      </h4>
      <View of={f}>
        {(d) => {
          const put = (preview: boolean, confirm?: "ai-model") => async () =>
            api<FileEdit>("/api/setup/file", {
              method: "PUT",
              body: {
                path: d.rel,
                content: text ?? d.content,
                baseSha256: d.sha256,
                ...(preview ? { preview: true } : {}),
                // ADR 0186: a raw edit that moves where the model's key goes is the person's.
                ...(confirm ? await confirmed(confirm, "model") : {}),
              },
            });
          return (
            <div className="stack" style={{ gap: 6 }}>
              <p className="muted" style={{ margin: 0, fontSize: 12 }} id={`${id}-hint`}>
                {d.checked ? S.rawHint : S.rawUnchecked} {d.exists ? "" : S.rawNew}
              </p>
              <label htmlFor={id} className="sr">
                {S.rawText(d.path)}
              </label>
              <textarea
                id={id}
                className="field mono"
                rows={16}
                spellCheck={false}
                aria-describedby={`${id}-hint`}
                value={text ?? d.content}
                onChange={(e) => {
                  setText(e.target.value);
                  setRound(round + 1);
                }}
                style={{ width: "100%", font: "12.5px/1.6 var(--mono)" }}
              />
              <EditPreview
                key={round}
                disabled={text === undefined || text === d.content}
                preview={() => put(true)()}
                write={(confirm) => put(false, confirm)()}
                onWritten={() => f.reload()}
              />
              <div className="row">
                <button type="button" className="btn" onClick={onClose}>
                  {S.close}
                </button>
              </div>
            </div>
          );
        }}
      </View>
    </section>
  );
}

/** "Edit in app": the raw editor of one org-pack file, opened under the panel that shows it. */
export function EditInApp({ path, label }: { path: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          aria-label={S.editFile(path)}
          onClick={() => setOpen(!open)}
        >
          {label ?? S.editInApp}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {S.noForm}
        </span>
      </div>
      {open && <RawFileEditor path={path} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Any file of the org pack, by its path, in the raw editor. */
export function RawFilePicker() {
  const [path, setPath] = useState("");
  const [open, setOpen] = useState<string>();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <form
        className="row"
        style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) setOpen(path.trim());
        }}
      >
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 220 }}>
          <label htmlFor="raw-pick">{S.rawPick}</label>
          <input
            id="raw-pick"
            className="field mono"
            value={path}
            aria-describedby="raw-pick-hint"
            onChange={(e) => setPath(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={!path.trim()}>
          {S.open}
        </button>
      </form>
      <span id="raw-pick-hint" className="muted" style={{ fontSize: 12 }}>
        {S.rawPickHint}
      </span>
      {open && <RawFileEditor key={open} path={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
}
