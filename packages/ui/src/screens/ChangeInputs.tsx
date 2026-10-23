import { useId, useRef, type ChangeEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "./know/common.js";

const T = COPY.changes;
const MAX_MB = 15;

/** A file's bytes as base64, in chunks so a big file doesn't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The files attached to a change (ADR 0113), and an "Attach a file" control: a person picks a
 * file, the app sends it to the local API, which copies it into the change's inputs/ (the same
 * code as atticus change attach). The pick is the person's approval; nothing leaves the machine.
 */
export function ChangeInputs({ change }: { change: string }) {
  const list = useApi<Api.ChangeInputListT>(`/api/changes/${change}/inputs`);
  const attach = useAction();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    void attach.run(async () => {
      if (f.size > MAX_MB * 1024 * 1024)
        throw new Error(T.attachTooLarge(Math.ceil(f.size / (1024 * 1024))));
      const content = toBase64(new Uint8Array(await f.arrayBuffer()));
      const r = await api<Api.AttachResultT>(`/api/changes/${change}/inputs`, {
        method: "POST",
        body: { name: f.name, content },
      });
      list.reload();
      if (input.current) input.current.value = "";
      return r;
    }, T.attached(f.name));
  };
  return (
    <Panel
      title={T.inputs}
      span="span 4"
      meta={list.state === "ready" ? list.data.files.length : undefined}
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className="stack" style={{ gap: 4 }}>
          <label htmlFor={id} className="hud">
            {T.attachLabel}
          </label>
          <input
            id={id}
            ref={input}
            type="file"
            disabled={attach.busy}
            aria-describedby={`${id}-help`}
            onChange={onPick}
          />
          <span id={`${id}-help`} className="muted" style={{ fontSize: 12 }}>
            {T.attachHelp}
          </span>
          <Note note={attach.note} />
        </div>
        <View of={list} empty={(d) => d.files.length === 0} emptyText={T.noInputs}>
          {(d) => (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <caption className="sr">{T.inputs}</caption>
              <thead>
                <tr className="hud" style={{ textAlign: "left", fontSize: 10 }}>
                  <th style={{ padding: "4px 0", fontWeight: 400 }}>{T.inputFile}</th>
                  <th style={{ fontWeight: 400 }}>{T.inputKind}</th>
                  <th style={{ fontWeight: 400 }}>{T.inputWho}</th>
                </tr>
              </thead>
              <tbody>
                {d.files.map((f) => (
                  <tr key={f.path} style={{ borderTop: "1px solid var(--rule)" }}>
                    <td className="mono" style={{ padding: "7px 0", wordBreak: "break-all" }}>
                      {f.path}
                    </td>
                    <td>
                      <span className="stack" style={{ gap: 2 }}>
                        <span>{`${f.kind} · ${f.format}`}</span>
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {T.inputRead(f.read, f.citeBy)}
                        </span>
                        {f.supersededBy && (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {T.inputOlder(f.supersededBy)}
                          </span>
                        )}
                        {f.defences?.risk === "high" && (
                          <span className="chip blocking">{T.inputHidden}</span>
                        )}
                      </span>
                    </td>
                    <td>{T.inputWhen(f.addedBy, f.addedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </View>
      </div>
    </Panel>
  );
}
