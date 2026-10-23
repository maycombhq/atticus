import { useState } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { Donut, ExternalLink, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import {
  AdapterChip,
  Choice,
  CopyButton,
  Note,
  plural,
  useAction,
  withForceHint,
} from "./shared.js";

interface Request {
  change: string;
  heading: string;
  template?: string;
  requestType: string;
  record: string;
  leadTimeDays?: number;
  approvers: string[];
  fields: { name: string; value: string; required: boolean }[];
  missing: string[];
  state: "to-file" | "waiting" | "filed";
  step?: string;
  number?: string;
  url?: string;
}
interface Queue {
  adapter: { configured: string | null };
  exports: { requests: number; files: string[] };
  templates: { id: string; name: string; requestType: string; leadTimeDays: number }[];
  executors: string[];
  requests: Request[];
}
interface ChangeSummary {
  id: string;
  title: string;
  state: string;
}

type Filter = "to-file" | "waiting" | "filed" | "all";
const STATE: Record<Request["state"], { label: string; cls: string }> = {
  "to-file": { label: "TO FILE", cls: "warn" },
  waiting: { label: "WAITING FOR YOU", cls: "ai" },
  filed: { label: "FILED", cls: "done" },
};
const keyOf = (r: Request) => `${r.change}|${r.heading}`;

function DraftForm({ done }: { done: () => void }) {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const [change, setChange] = useState("");
  const [force, setForce] = useState(false);
  const act = useAction();
  return (
    <View of={changes} empty={(l) => l.length === 0} emptyText="No changes to draft requests for.">
      {(l) => (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const id = change || l[0]!.id;
            void act.run(
              () =>
                api<{ lines: string[] }>(`/api/service-desk/${id}/draft`, {
                  method: "POST",
                  body: force ? { force: true } : {},
                })
                  .then((r) => {
                    done();
                    return r;
                  })
                  .catch(withForceHint(COPY.app.forceSnow)),
              (r) => (r as { lines: string[] }).lines.join("\n") || "Drafted.",
            );
          }}
        >
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="run-label" htmlFor="draft-change">
              Draft the requests a change needs
              <select
                id="draft-change"
                className="run-select"
                value={change || l[0]!.id}
                onChange={(e) => setChange(e.target.value)}
              >
                {l.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} ({c.state})
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 6, fontSize: 12.5 }} htmlFor="draft-force">
              <input
                id="draft-force"
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Replace a snow.md a person edited
            </label>
            <button type="submit" className="btn" disabled={act.busy}>
              Draft from the org pack's templates
            </button>
          </div>
          <Note note={act.note} />
        </form>
      )}
    </View>
  );
}

function RequestDetail({ r, done }: { r: Request; done: () => void }) {
  const act = useAction();
  const all = r.fields.map((f) => `${f.name}: ${f.value}`).join("\n");
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <span className={`chip ${STATE[r.state].cls}`}>{STATE[r.state].label}</span>
        <a className="chip" href={`#/changes/${r.change}`}>
          {r.change}
        </a>
        {r.template ? (
          <span className="chip dim">TEMPLATE {r.template}</span>
        ) : (
          <span className="chip blocking">NO TEMPLATE MATCHES</span>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {r.leadTimeDays !== undefined ? `Lead time ${r.leadTimeDays} days. ` : ""}
        Approvers: {r.approvers.join(", ") || "none named"}. Values come from snow.md; edit them
        there.
      </p>
      <div>
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="hud" style={{ fontSize: 10 }}>
            Fields
          </span>
          <CopyButton text={all} label="Copy all fields" />
        </div>
        {r.fields.map((f) => (
          <div key={f.name} className="run-field">
            <span className="hud" style={{ fontSize: 10 }}>
              {f.name}
              {f.required ? " · required" : ""}
            </span>
            <span className={`value ${f.value ? "" : "empty"}`}>
              {f.value || (f.required ? "Missing: fill it in snow.md" : "Empty")}
            </span>
            {f.value ? <CopyButton text={f.value} label={`Copy ${f.name}`} /> : <span />}
          </div>
        ))}
      </div>
      {r.state === "to-file" && (
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Atticus never calls the desk from here. Filing makes a step in To-do with every field
            ready to copy; you submit it in the desk and record the number.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || r.missing.length > 0}
              title={r.missing.length ? `Fill ${r.missing.join(", ")} first` : undefined}
              onClick={() =>
                void act.run(
                  () =>
                    api<{ lines: string[] }>(`/api/service-desk/${r.change}/submit`, {
                      method: "POST",
                      body: {},
                    }).then((x) => {
                      done();
                      return x;
                    }),
                  (x) => (x as { lines: string[] }).lines.join("\n") || "Filed as a step.",
                )
              }
            >
              File {r.change}'s complete drafts as steps
            </button>
          </div>
          {r.missing.length > 0 && (
            <p className="run-note bad">Fill {r.missing.join(", ")} in snow.md before filing.</p>
          )}
        </div>
      )}
      {r.state === "waiting" && (
        <p style={{ margin: 0, fontSize: 12.5 }}>
          Filed as step <span className="mono">{r.step}</span>. Submit it in the desk, then{" "}
          <a href="#/todo">record the request number in To-do</a>.
        </p>
      )}
      {r.state === "filed" && (
        <p className="run-note ok">
          Filed as {r.number}
          {r.url ? (
            <>
              {" "}
              (<ExternalLink href={r.url}>open</ExternalLink>)
            </>
          ) : null}
          .
        </p>
      )}
      <Note note={act.note} />
    </div>
  );
}

export function ServiceDesk() {
  const q = useApi<Queue>("/api/service-desk");
  const [filter, setFilter] = useState<Filter>("all");
  const [current, setCurrent] = useState<string | undefined>();
  useLiveEvents((e) => {
    if (e.type === "file.changed") q.reload();
  });
  const all = q.state === "ready" ? q.data.requests : [];
  const shown = all.filter((r) => filter === "all" || r.state === filter);
  const selected = shown.find((r) => keyOf(r) === current) ?? shown[0];
  const n = (s: Request["state"]) => all.filter((r) => r.state === s).length;

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {q.state !== "ready"
            ? "Service desk queue"
            : n("to-file")
              ? `${plural(n("to-file"), "request")} to file.`
              : "Nothing to file."}
        </p>
        <Choice
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All ${all.length}` },
            { value: "to-file", label: `To file ${n("to-file")}` },
            { value: "waiting", label: `Waiting ${n("waiting")}` },
            { value: "filed", label: `Filed ${n("filed")}` },
          ]}
        />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Drafts only: you file them. Next: the <a href="#/release">release plan</a>.
      </p>

      <div className="bento">
        <Panel title="Queue" span="span 4">
          <View of={q} empty={() => all.length === 0} emptyText="No drafts yet.">
            {() => (
              <Donut
                title="Requests"
                parts={[
                  { label: "To file", value: n("to-file"), color: "var(--amber)" },
                  { label: "Waiting for you", value: n("waiting"), color: "var(--violet)" },
                  { label: "Filed", value: n("filed"), color: "var(--green)" },
                ]}
              />
            )}
          </View>
        </Panel>

        <Panel title="Service desk adapter" span="span 4">
          <View of={q}>
            {(d) => (
              <div className="stack">
                <div className="row">
                  <AdapterChip type={d.adapter.configured} />
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  Writes from the app become steps you perform. Reads come from an export you load
                  into inputs/.
                </p>
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  {d.exports.files.length
                    ? `${plural(d.exports.requests, "past request")} from ${plural(d.exports.files.length, "export")}.`
                    : "No desk export loaded yet."}{" "}
                  {plural(d.templates.length, "request template")} in the org pack.
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Local automation tool" span="span 4">
          <View of={q}>
            {(d) => (
              <div className="stack">
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {d.executors.length ? (
                    d.executors.map((x) => (
                      <span key={x} className="chip ai">
                        {x} · APPROVE EACH WRITE
                      </span>
                    ))
                  ) : (
                    <span className="chip dim">NONE ALLOWED HERE</span>
                  )}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  Called through the common step spec from <a href="#/todo">To-do</a>. No
                  credentials pass to the tool. <a href="#/settings">Executors allow-list</a>
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Requests" meta={shown.length} span="span 4" rows="span 2">
          <View
            of={q}
            empty={() => shown.length === 0}
            emptyText={
              all.length
                ? "None in this view."
                : "No service-desk drafts. Draft them for a change below."
            }
          >
            {() => (
              <nav aria-label="Requests" className="stack" style={{ gap: 2 }}>
                {Object.entries(
                  shown.reduce<Record<string, Request[]>>((a, r) => {
                    (a[r.requestType] ??= []).push(r);
                    return a;
                  }, {}),
                ).map(([type, list]) => (
                  <div key={type} className="stack" style={{ gap: 2 }}>
                    <span className="hud" style={{ fontSize: 10, marginTop: 6 }}>
                      {type}
                    </span>
                    {list.map((r) => (
                      <button
                        key={keyOf(r)}
                        type="button"
                        className="run-pick"
                        aria-current={selected && keyOf(selected) === keyOf(r) ? "true" : undefined}
                        onClick={() => setCurrent(keyOf(r))}
                      >
                        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 12.5 }}>{r.record || r.heading}</span>
                          <span className="hud" style={{ fontSize: 9.5 }}>
                            {r.change}
                            {r.missing.length ? ` · ${r.missing.length} to fill` : ""}
                          </span>
                        </span>
                        <span className={`chip ${STATE[r.state].cls}`}>{STATE[r.state].label}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            )}
          </View>
        </Panel>

        <Panel
          title={selected ? selected.heading : "No request selected"}
          span="span 8"
          kind="hero"
        >
          <View of={q} empty={() => !selected} emptyText="Pick a request on the left.">
            {() => <RequestDetail key={keyOf(selected!)} r={selected!} done={() => q.reload()} />}
          </View>
        </Panel>

        <Panel title="Draft requests" span="span 8">
          <DraftForm done={() => q.reload()} />
        </Panel>
      </div>
    </>
  );
}
