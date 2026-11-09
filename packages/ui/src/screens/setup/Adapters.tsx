import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";
import { EditPreview, type FileEdit } from "./EditPreview.js";

/**
 * ADR 0190: the Adapters panel on Set up. Each outside system runtime.yaml names: its type (only
 * those the schema takes; manual is a step for a person, the default where a system has no API
 * access from here), the settings Atticus reads (the metarepo's repo on the Git host, its protected
 * branches, a project), any other setting the adapter's plugin reads, never a secret. Each change
 * is previewed, written to runtime.yaml and proposed for review.
 */

const S = COPY.setup;
type Kind = Api.AdaptersViewT["kinds"][number];
type Value = string | number | boolean | string[];

/** "name: value" lines as settings; the lines that don't read, to say so. */
export function settingsOf(text: string): { settings: Record<string, string>; bad: string[] } {
  const settings: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(l);
    if (m) settings[m[1]!] = m[2]!.trim();
    else bad.push(l);
  }
  return { settings, bad };
}

/** What the form sends: the type, the known fields (a list one a line) and the other settings. */
export function adapterValue(
  kind: Kind,
  type: string,
  fields: Record<string, string>,
  more: string,
): Api.AdaptersViewT["kinds"][number]["current"] {
  if (!type) return null;
  const settings: Record<string, Value> = { ...settingsOf(more).settings };
  for (const f of kind.fields) {
    const v = (fields[f.name] ?? "").trim();
    if (!v) continue;
    settings[f.name] = f.list
      ? v
          .split(/[\r\n,]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      : v;
  }
  return { type, settings };
}

function AdapterForm({ kind, onWritten }: { kind: Kind; onWritten: () => void }) {
  const cur = kind.current;
  const known = new Set(kind.fields.map((f) => f.name));
  const [type, setType] = useState(cur?.type ?? "");
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(
      kind.fields.map((f) => {
        const v = cur?.settings[f.name];
        return [f.name, Array.isArray(v) ? v.join("\n") : v === undefined ? "" : String(v)];
      }),
    ),
  );
  const [more, setMore] = useState(
    Object.entries(cur?.settings ?? {})
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
      .join("\n"),
  );
  const [round, setRound] = useState(0);
  const label = S.kinds[kind.kind] ?? kind.kind;
  const id = `adapter-${kind.kind}`;
  const types = cur && !kind.types.includes(cur.type) ? [...kind.types, cur.type] : kind.types;
  const bad = settingsOf(more).bad;
  const touch = () => setRound(round + 1);
  const put = (preview: boolean) =>
    api<FileEdit>(`/api/setup/adapters/${kind.kind}`, {
      method: "PUT",
      body: {
        value: adapterValue(kind, type, fields, more),
        ...(preview ? { preview: true } : {}),
      },
    });
  return (
    <details open={kind.kind === "gitHost"} className="list-row" style={{ display: "block" }}>
      <summary>
        <span style={{ fontSize: 13 }}>{label}</span>{" "}
        <span className="chip dim">{cur ? (S.types[cur.type] ?? cur.type) : S.notSet}</span>
      </summary>
      <fieldset className="stack" style={{ gap: 6, border: 0, padding: "8px 0 0", margin: 0 }}>
        <legend className="sr">{S.kindFor(label)}</legend>
        <label htmlFor={`${id}-type`}>{S.typeOf(label)}</label>
        <select
          id={`${id}-type`}
          className="field"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            touch();
          }}
        >
          <option value="">{S.notSet}</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {S.types[t] ?? t}
            </option>
          ))}
        </select>
        {type && type !== "manual" && type !== "mock" && (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {S.live(S.types[type] ?? type)}
          </p>
        )}
        {type &&
          kind.fields.map((f) => (
            <div key={f.name} className="stack" style={{ gap: 4 }}>
              <label htmlFor={`${id}-${f.name}`}>{S.fields[f.name] ?? f.name}</label>
              {f.list ? (
                <textarea
                  id={`${id}-${f.name}`}
                  className="field mono"
                  rows={2}
                  value={fields[f.name] ?? ""}
                  aria-describedby={S.fieldHints[f.name] ? `${id}-${f.name}-hint` : undefined}
                  onChange={(e) => {
                    setFields({ ...fields, [f.name]: e.target.value });
                    touch();
                  }}
                />
              ) : (
                <input
                  id={`${id}-${f.name}`}
                  className="field mono"
                  value={fields[f.name] ?? ""}
                  aria-describedby={S.fieldHints[f.name] ? `${id}-${f.name}-hint` : undefined}
                  onChange={(e) => {
                    setFields({ ...fields, [f.name]: e.target.value });
                    touch();
                  }}
                />
              )}
              {S.fieldHints[f.name] && (
                <span id={`${id}-${f.name}-hint`} className="muted" style={{ fontSize: 12 }}>
                  {S.fieldHints[f.name]}
                </span>
              )}
            </div>
          ))}
        {type && (
          <>
            <label htmlFor={`${id}-more`}>{S.more}</label>
            <textarea
              id={`${id}-more`}
              className="field mono"
              rows={2}
              value={more}
              aria-describedby={`${id}-more-hint`}
              onChange={(e) => {
                setMore(e.target.value);
                touch();
              }}
            />
            <span id={`${id}-more-hint`} className="muted" style={{ fontSize: 12 }}>
              {bad.length ? bad.map(S.badLine).join(" ") : S.moreHint}
            </span>
          </>
        )}
        <EditPreview
          key={round}
          disabled={bad.length > 0 || (!type && !cur)}
          label={!type && cur ? S.takeOut : undefined}
          preview={() => put(true)}
          write={() => put(false)}
          onWritten={onWritten}
        />
      </fieldset>
    </details>
  );
}

export function AdaptersPanel({ span }: { span?: string }) {
  const a = useApi<Api.AdaptersViewT>("/api/setup/adapters");
  useReloadOnFiles(a);
  return (
    <Panel
      title={S.adaptersTitle}
      meta={a.state === "ready" ? a.data.path : undefined}
      span={span ?? "span 12"}
    >
      <View of={a}>
        {(d) => (
          <div className="stack" style={{ gap: 8 }}>
            <p className="muted" style={{ margin: 0, maxWidth: "75ch", fontSize: 12.5 }}>
              {S.adaptersIntro}
            </p>
            {d.problems.map((p) => (
              <p key={p} className="run-note bad">
                {p}
              </p>
            ))}
            {d.kinds.map((k) => (
              // Keyed by kind: a write read back keeps the form (and its Propose) as it is.
              <AdapterForm key={k.kind} kind={k} onWritten={() => undefined} />
            ))}
            <div className="stack" style={{ gap: 4 }}>
              <h4 className="hud" style={{ margin: 0, fontSize: 11 }}>
                {S.secretTitle}
              </h4>
              <p className="muted" style={{ margin: 0, fontSize: 12.5, maxWidth: "75ch" }}>
                {S.secretWhy}
              </p>
              <div className="work-cmd">
                <code className="mono">{S.secretCommand}</code>
                <CopyButton text={S.secretCommand} label={COPY.decisions.copy(S.secretCommand)} />
              </div>
            </div>
          </div>
        )}
      </View>
    </Panel>
  );
}
