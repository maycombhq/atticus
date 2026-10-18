import { useState, type ReactNode } from "react";
import { ApiError, useApi, type Loaded } from "../../api/client.js";

/** A read-only view (`/api/view/<name>[/<id>]`): the JSON an `atticus … --json` command prints. */
export function useView<T>(
  name: string,
  id?: string | undefined,
  skip = false,
): Loaded<T> & { reload: () => void } {
  const v = useApi<{ code: number; data: T }>(
    skip ? undefined : `/api/view/${name}${id ? `/${encodeURIComponent(id)}` : ""}`,
  );
  if (v.state !== "ready") return v as Loaded<T> & { reload: () => void };
  return { state: "ready", data: v.data.data, reload: v.reload };
}

export function queryParam(hash: string, name: string): string | undefined {
  const q = hash.split("?")[1];
  return q ? (new URLSearchParams(q).get(name) ?? undefined) : undefined;
}

export function setQueryParam(screen: string, name: string, value: string) {
  location.hash = `#/${screen}?${name}=${encodeURIComponent(value)}`;
}

interface ChangeSummary {
  id: string;
  title: string;
  state: string;
}

/** Pick a change for screens that work on one; remembered in the hash (?change=). */
export function useChange(hash: string, screen: string) {
  const list = useApi<ChangeSummary[]>("/api/changes");
  const wanted = queryParam(hash, "change");
  const id = wanted ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  const picker = (
    <label className="row" style={{ gap: 8 }}>
      <span className="hud" style={{ fontSize: 10 }}>
        Change
      </span>
      <select
        value={id ?? ""}
        onChange={(e) => setQueryParam(screen, "change", e.target.value)}
        disabled={list.state !== "ready" || list.data.length === 0}
        style={{
          height: 32,
          background: "#0B1016",
          color: "var(--text)",
          border: "1px solid var(--line-2)",
          borderRadius: 7,
          padding: "0 8px",
          font: "inherit",
        }}
      >
        {list.state === "ready" && list.data.length === 0 && (
          <option value="">No changes yet</option>
        )}
        {list.state === "ready" &&
          list.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.state}
            </option>
          ))}
      </select>
    </label>
  );
  return { id, picker, none: list.state === "ready" && list.data.length === 0 };
}

/** A small, safe Markdown view: headings, lists, tables as text and paragraphs; never HTML. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      out.push(
        <ul
          key={`l${out.length}`}
          style={{ margin: "4px 0 8px", paddingLeft: 20, lineHeight: 1.6 }}
        >
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      out.push(
        <div
          key={out.length}
          className={level <= 2 ? "h" : "hud"}
          style={{ margin: "12px 0 6px", fontSize: level <= 1 ? 16 : level === 2 ? 14 : 11 }}
        >
          {h[2]}
        </div>,
      );
    } else if (li) list.push(li[1]!);
    else if (!line.trim() || /^<!--/.test(line)) flush();
    else {
      flush();
      out.push(
        <p
          key={out.length}
          style={{
            margin: "4px 0",
            lineHeight: 1.6,
            color: "var(--text-2)",
            fontFamily: line.startsWith("|") ? "var(--mono)" : undefined,
            fontSize: line.startsWith("|") ? 11.5 : undefined,
          }}
        >
          {line}
        </p>,
      );
    }
  }
  flush();
  return <div>{out}</div>;
}

export function message(e: unknown): string {
  return e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e);
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await f();
      setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, run };
}

export function Note({ note }: { note?: { ok: boolean; text: string } | undefined }) {
  if (!note) return null;
  return (
    <p
      role={note.ok ? "status" : "alert"}
      style={{
        margin: "8px 0 0",
        whiteSpace: "pre-line",
        color: note.ok ? "var(--green)" : "#FF9BCB",
        fontSize: 12.5,
      }}
    >
      {note.text}
    </p>
  );
}

export function Table<R>(p: {
  rows: R[];
  cols: { label: string; cell: (r: R) => ReactNode; mono?: boolean; width?: string }[];
  rowKey: (r: R) => string;
  caption?: string;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 480 }}>
        {p.caption && <caption className="sr">{p.caption}</caption>}
        <thead>
          <tr className="hud" style={{ textAlign: "left", fontSize: 10 }}>
            {p.cols.map((c) => (
              <th
                key={c.label}
                style={{ padding: "4px 8px 6px 0", fontWeight: 400, width: c.width }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={p.rowKey(r)} style={{ borderTop: "1px solid #18202A", verticalAlign: "top" }}>
              {p.cols.map((c) => (
                <td
                  key={c.label}
                  className={c.mono ? "mono" : undefined}
                  style={{ padding: "7px 8px 7px 0", wordBreak: "break-word" }}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const list = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v);
