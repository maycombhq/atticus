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

type Scalar = string | number | boolean;

/** One value as YAML reads it: a yes or no, a number, a quoted string, else the words. */
function readScalar(t: string): Scalar {
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(t) && Number.isFinite(Number(t)))
    return Number(t);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** A flow list's items (`[a, "b, c"]`), split at commas outside quotes; undefined when not one. */
function flowItems(t: string): string[] | undefined {
  if (!/^\[.*\]$/.test(t)) return undefined;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!;
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += inner[++k] ?? "";
      else if (c === q) q = undefined;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (q) return undefined;
  out.push(cur.trim());
  return out.some((x) => !x || /^[[{]/.test(x)) ? undefined : out;
}

/**
 * A setting's value as typed, read as YAML reads it (`false` a no, `3` a number, `[a, b]` a
 * list, `"3"` words), so a value keeps its type through the form.
 */
export function readValue(text: string): Value {
  const t = text.trim();
  const items = flowItems(t);
  if (items) return items.map((x) => String(readScalar(x)));
  return readScalar(t);
}

/** A value as the "other settings" box shows it: YAML that reads back as the same value. */
export function shown(v: Value): string {
  const one = (x: Scalar) =>
    typeof x !== "string" || (readValue(x) === x && !/^\s|\s$|[#,[\]{}"']|: /.test(x))
      ? String(x)
      : JSON.stringify(x);
  return Array.isArray(v) ? `[${v.map(one).join(", ")}]` : one(v);
}

/** "name: value" lines as settings, each value read as YAML; the lines that don't read, to say so. */
export function settingsOf(text: string): { settings: Record<string, Value>; bad: string[] } {
  const settings: Record<string, Value> = {};
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(l);
    if (m) settings[m[1]!] = readValue(m[2]!.trim());
    else bad.push(l);
  }
  return { settings, bad };
}

/** A known field's value as its box shows it (a list one a line). */
const fieldText = (v: Value | undefined) =>
  Array.isArray(v) ? v.join("\n") : v === undefined ? "" : String(v);

/**
 * What the form sends: the type, the known fields (a list one a line) and the other settings.
 * A known field left as the file had it (`was`) is sent as the file had it, a number or a yes
 * included, so only what the person changed changes.
 */
export function adapterValue(
  kind: Kind,
  type: string,
  fields: Record<string, string>,
  more: string,
  was: Record<string, Value> = {},
): Api.AdaptersViewT["kinds"][number]["current"] {
  if (!type) return null;
  const settings: Record<string, Value> = { ...settingsOf(more).settings };
  for (const f of kind.fields) {
    const raw = fields[f.name] ?? "";
    const v = raw.trim();
    if (!v) continue;
    const before = was[f.name];
    if (before !== undefined && raw === fieldText(before)) settings[f.name] = before;
    else
      settings[f.name] = f.list
        ? v
            .split(/[\r\n,]+/)
            .map((x) => x.trim())
            .filter(Boolean)
        : v;
  }
  return { type, settings };
}

/** The form's words: the type, the known fields and the other settings. */
interface Texts {
  type: string;
  fields: Record<string, string>;
  more: string;
}

/** The form as the file has the adapter. */
export function textsOf(kind: Kind): Texts {
  const cur = kind.current;
  const known = new Set(kind.fields.map((f) => f.name));
  return {
    type: cur?.type ?? "",
    fields: Object.fromEntries(kind.fields.map((f) => [f.name, fieldText(cur?.settings[f.name])])),
    more: Object.entries(cur?.settings ?? {})
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => `${k}: ${shown(v)}`)
      .join("\n"),
  };
}

/** A value with its keys in order, to tell whether two forms say the same. */
const said = (kind: Kind, t: Texts, was: Record<string, Value>) => {
  const v = adapterValue(kind, t.type, t.fields, t.more, was);
  return JSON.stringify(
    v && { type: v.type, settings: Object.fromEntries(Object.entries(v.settings).sort()) },
  );
};

/** The form the file was read into: its sha256 (sent back as the write's base) and its values. */
interface Base {
  sha256: string;
  texts: Texts;
  was: Record<string, Value>;
}

export function AdapterForm({
  kind,
  sha256,
  onWritten,
}: {
  kind: Kind;
  /** runtime.yaml's sha256 as last read. */
  sha256: string;
  onWritten: () => void;
}) {
  const cur = kind.current;
  const fresh = textsOf(kind);
  const [form, setForm] = useState<Texts>(fresh);
  const [base, setBase] = useState<Base>({ sha256, texts: fresh, was: cur?.settings ?? {} });
  const [round, setRound] = useState(0);
  const restart = () => {
    setForm(fresh);
    setBase({ sha256, texts: fresh, was: cur?.settings ?? {} });
  };
  // runtime.yaml read again (a write here, another window, the raw editor, the CLI): a form the
  // person hasn't changed, or one that says what the file now says, follows the file. One they
  // have changed keeps their edit, and says that writing it would be refused.
  if (
    base.sha256 !== sha256 &&
    (said(kind, form, base.was) === said(kind, base.texts, base.was) ||
      said(kind, form, base.was) === said(kind, fresh, cur?.settings ?? {}))
  )
    restart();
  const stale = base.sha256 !== sha256;
  const { type, fields, more } = form;
  const label = S.kinds[kind.kind] ?? kind.kind;
  const id = `adapter-${kind.kind}`;
  const types = cur && !kind.types.includes(cur.type) ? [...kind.types, cur.type] : kind.types;
  const bad = settingsOf(more).bad;
  const touch = () => setRound(round + 1);
  const setType = (t: string) => setForm({ ...form, type: t });
  const setFields = (f: Record<string, string>) => setForm({ ...form, fields: f });
  const setMore = (m: string) => setForm({ ...form, more: m });
  const put = (preview: boolean) =>
    api<FileEdit>(`/api/setup/adapters/${kind.kind}`, {
      method: "PUT",
      body: {
        value: adapterValue(kind, type, fields, more, base.was),
        // The file as this form read it: one changed since is refused (409), never overwritten.
        baseSha256: base.sha256,
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
        {stale && (
          <div className="stack" style={{ gap: 4 }}>
            <p className="run-note bad" role="status" style={{ margin: 0 }}>
              {S.adapterChanged(label)}
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  restart();
                  touch();
                }}
              >
                {S.adapterReload}
              </button>
            </div>
          </div>
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
              // Keyed by kind: a write read back keeps the form (and its Propose) as it is, and the
              // form follows the file read again while the person hasn't changed it.
              <AdapterForm key={k.kind} kind={k} sha256={d.sha256} onWritten={() => undefined} />
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
