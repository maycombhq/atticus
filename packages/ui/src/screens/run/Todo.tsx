import { useState, type FormEvent } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { Donut, Panel, Ring, View } from "../../app/ui.js";
import {
  AdapterChip,
  Choice,
  CopyButton,
  Note,
  SYSTEM_LABEL,
  day,
  plural,
  useAction,
} from "./shared.js";

interface ResultField {
  name: string;
  label: string;
  format: string;
  required: boolean;
  pattern?: string;
  choices?: string[];
  help?: string;
}
interface Step {
  id: string;
  change?: string;
  system: string;
  action: string;
  state: "open" | "done" | "skipped";
  title: string;
  where: string;
  procedure?: string;
  fields: { name: string; value: string; help?: string }[];
  instructions: string[];
  result: ResultField[];
  waitsFor: string[];
  reason?: string;
  recorded?: {
    by: string;
    at: string;
    values: Record<string, unknown>;
    note?: string;
    via: string;
  };
  runs: { runId: string; executor: string; at: string; status: string; by: string }[];
  executors: string[];
}
interface Todo {
  steps: Step[];
  sources: { system: string; configured: string | null; open: number }[];
  exports: { workItems: number; requests: number; files: string[] };
  procedures: {
    id: string;
    name: string;
    system: string;
    status: string;
    writes: number;
    allowed: string[];
    configured: string[];
    runs: number;
    lastRun?: { at: string; status: string; executor: string };
  }[];
  executors: { configured: string[]; problems: string[] };
}
interface Finding {
  id: string;
  change: string;
  gate: string;
  state: string;
  summary: string;
  question?: { text: string; owner?: string };
}
interface Preview {
  inputs: Record<string, unknown>;
  inputsSha256: string;
  executors: string[];
  writes: boolean;
}

/** An input that fits the value's format, so the browser helps a person type it right. */
function ResultInput(p: {
  f: ResultField;
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const common = { id: p.id, value: p.value, required: p.f.required, className: "run-input" };
  if (p.f.format === "choice" || p.f.format === "yes-no") {
    const opts = p.f.format === "yes-no" ? ["yes", "no"] : (p.f.choices ?? []);
    return (
      <select {...common} className="run-select" onChange={(e) => p.onChange(e.target.value)}>
        <option value="">Choose</option>
        {opts.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  const type =
    p.f.format === "url"
      ? "url"
      : p.f.format === "date"
        ? "date"
        : p.f.format === "number" || p.f.format === "integer"
          ? "number"
          : "text";
  return (
    <input
      {...common}
      type={type}
      placeholder={p.f.help ?? (p.f.format === "handles" ? "pat, dana" : "")}
      onChange={(e) => p.onChange(e.target.value)}
    />
  );
}

function LocalTool({ step, done }: { step: Step; done: () => void }) {
  const [executor, setExecutor] = useState(step.executors[0] ?? "");
  const [preview, setPreview] = useState<Preview | undefined>();
  const act = useAction();
  if (step.executors.length === 0) return null;
  return (
    <div className="stack" style={{ borderTop: "1px solid #18202a", paddingTop: 10 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="chip ai">LOCAL TOOL</span>
        <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          A tool on the allow-list can do this step for you. You approve the exact inputs; it gets
          no credentials.
        </span>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="run-label" htmlFor={`exec-${step.id}`}>
          Tool
          <select
            id={`exec-${step.id}`}
            className="run-select"
            value={executor}
            onChange={(e) => {
              setExecutor(e.target.value);
              setPreview(undefined);
            }}
          >
            {step.executors.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          style={{ alignSelf: "flex-end" }}
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () =>
                api<Preview>(
                  `/api/todo/${step.id}/run?with=${encodeURIComponent(executor)}${step.change ? `&change=${encodeURIComponent(step.change)}` : ""}`,
                ).then(setPreview),
              "These are the exact inputs the tool gets. Approve them to run it.",
            )
          }
        >
          Show the inputs
        </button>
      </div>
      {preview && (
        <>
          <pre
            className="run-inert"
            aria-label="Inputs the tool gets"
            style={{ borderStyle: "solid" }}
          >
            {JSON.stringify(preview.inputs, null, 2)}
          </pre>
          <span className="hud" style={{ fontSize: 10 }}>
            sha-256 {preview.inputsSha256.slice(0, 16)}…
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={act.busy}
            onClick={() =>
              void act.run(
                () =>
                  api<{ lines: string[] }>(`/api/todo/${step.id}/run`, {
                    method: "POST",
                    body: {
                      with: executor,
                      inputsSha256: preview.inputsSha256,
                      ...(step.change ? { change: step.change } : {}),
                    },
                  }).then((r) => {
                    done();
                    return r;
                  }),
                (r) => (r as { lines: string[] }).lines.join("\n") || `${executor} did the step.`,
              )
            }
          >
            Run with {executor}, I approve these inputs
          </button>
        </>
      )}
      <Note note={act.note} />
    </div>
  );
}

function StepDetail({ step, done }: { step: Step; done: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const copyAll = useAction();
  const act = useAction();
  const allText = step.fields.map((f) => `${f.name}: ${f.value}`).join("\n");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    void act.run(
      () =>
        api(`/api/todo/${step.id}/done`, {
          method: "POST",
          body: { values: filled, ...(step.change ? { change: step.change } : {}) },
        }).then(done),
      `Recorded step ${step.id}.`,
    );
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <span className="chip">{(SYSTEM_LABEL[step.system] ?? step.system).toUpperCase()}</span>
        <span className="chip warn">MANUAL</span>
        {step.procedure && <span className="chip dim">PROCEDURE {step.procedure}</span>}
        {step.change && (
          <a className="chip" href={`#/changes/${step.change}`}>
            {step.change}
          </a>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 15 }}>{step.title}</p>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Where: {step.where}. {step.reason ? `Why this is manual: ${step.reason}. ` : ""}
        Every value comes from the change files. Nothing is sent until you do it.
      </p>
      {step.waitsFor.length > 0 && (
        <p className="run-note bad" role="note">
          Do {step.waitsFor.join(", ")} first: this step depends on{" "}
          {step.waitsFor.length === 1 ? "it" : "them"}.
        </p>
      )}
      {step.instructions.length > 0 && (
        <ol className="run-steps">
          {step.instructions.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ol>
      )}
      {step.fields.length > 0 && (
        <div>
          <div className="row between" style={{ marginBottom: 4 }}>
            <span className="hud" style={{ fontSize: 10 }}>
              Fields to copy
            </span>
            <span className="row" style={{ gap: 6 }}>
              <CopyButton text={allText} label="Copy all fields" />
              <button
                type="button"
                className="btn run-copy"
                disabled={copyAll.busy}
                onClick={() =>
                  void copyAll.run(
                    () =>
                      api<{ text: string }>(
                        `/api/todo/${step.id}/export?format=csv${step.change ? `&change=${encodeURIComponent(step.change)}` : ""}`,
                      ).then((r) => {
                        if (!navigator.clipboard)
                          throw new Error(
                            "This browser won't copy from here; use Copy all fields.",
                          );
                        return navigator.clipboard.writeText(r.text);
                      }),
                    "Copied the fields as CSV, ready to import.",
                  )
                }
              >
                Copy as CSV
              </button>
            </span>
          </div>
          {step.fields.map((f) => (
            <div key={f.name} className="run-field">
              <span className="hud" style={{ fontSize: 10 }}>
                {f.name}
              </span>
              <span className={`value ${f.value ? "" : "empty"}`}>{f.value || "Empty"}</span>
              {f.value ? <CopyButton text={f.value} label={`Copy ${f.name}`} /> : <span />}
            </div>
          ))}
          <Note note={copyAll.note} />
        </div>
      )}
      {step.state === "open" ? (
        <form onSubmit={submit} className="stack">
          <span className="hud" style={{ fontSize: 10 }}>
            When it's done, record
          </span>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            {step.result.map((f) => (
              <label key={f.name} className="run-label" htmlFor={`r-${step.id}-${f.name}`}>
                {f.label}
                {f.required ? "" : " (optional)"}
                <ResultInput
                  f={f}
                  id={`r-${step.id}-${f.name}`}
                  value={values[f.name] ?? ""}
                  onChange={(v) => setValues((x) => ({ ...x, [f.name]: v }))}
                />
              </label>
            ))}
            <button type="submit" className="btn primary" disabled={act.busy}>
              Mark done
            </button>
          </div>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="run-label" htmlFor={`skip-${step.id}`} style={{ flex: "1 1 240px" }}>
              Reason to skip
              <input
                id={`skip-${step.id}`}
                className="run-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={act.busy || !note.trim()}
              onClick={() =>
                void act.run(
                  () =>
                    api(`/api/todo/${step.id}/done`, {
                      method: "POST",
                      body: { skip: true, note, ...(step.change ? { change: step.change } : {}) },
                    }).then(done),
                  `Skipped step ${step.id}.`,
                )
              }
            >
              Skip with this reason
            </button>
          </div>
          <Note note={act.note} />
          <LocalTool step={step} done={done} />
        </form>
      ) : (
        <p className="run-note ok">
          {step.state === "done" ? "Done" : "Skipped"} by {step.recorded?.by} on{" "}
          {day(step.recorded?.at)}
          {step.recorded?.via === "executor" ? " (by a local tool)" : ""}.
          {step.recorded?.note ? ` ${step.recorded.note}` : ""}
          {Object.entries(step.recorded?.values ?? {})
            .map(([k, v]) => ` ${k}: ${String(v)}.`)
            .join("")}
        </p>
      )}
    </div>
  );
}

export function Todo() {
  const todo = useApi<Todo>("/api/todo?all=1");
  const findings = useApi<Finding[]>("/api/findings");
  const [current, setCurrent] = useState<string | undefined>();
  const [change, setChange] = useState<string>("all");
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      todo.reload();
      findings.reload();
    }
  });
  const steps =
    todo.state === "ready"
      ? todo.data.steps.filter((s) => change === "all" || (s.change ?? "none") === change)
      : [];
  const open = steps.filter((s) => s.state === "open");
  const closed = steps.filter((s) => s.state !== "open");
  const waiting = open.filter((s) => s.waitsFor.length > 0);
  const changes =
    todo.state === "ready" ? [...new Set(todo.data.steps.map((s) => s.change ?? "none"))] : [];
  const selected = steps.find((s) => s.id === current) ?? open[0];
  const questions =
    findings.state === "ready"
      ? findings.data.filter((f) => f.question && (f.state === "open" || f.state === "asked"))
      : [];

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {todo.state !== "ready"
            ? "To-do and manual steps"
            : open.length
              ? `${plural(open.length, "step")} wait for a person.`
              : "Nothing to do: every manual step is done."}
        </p>
        {changes.length > 1 && (
          <Choice
            label="Change"
            value={change}
            onChange={setChange}
            options={[
              { value: "all", label: "All changes" },
              ...changes.map((c) => ({ value: c, label: c === "none" ? "No change" : c })),
            ]}
          />
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Steps a person does in the work tracker, service desk or Git host when Atticus can't reach
        them.
      </p>

      <div className="bento">
        <Panel title="Progress" span="span 3">
          <View of={todo} empty={() => steps.length === 0} emptyText="No manual steps yet.">
            {() => (
              <div className="stack" style={{ alignItems: "flex-start" }}>
                <Ring
                  value={closed.length}
                  max={steps.length}
                  size={72}
                  label={`${closed.length} of ${steps.length} steps done`}
                />
                <Donut
                  title="Steps"
                  parts={[
                    { label: "Done", value: closed.length, color: "var(--green)" },
                    { label: "Open", value: open.length - waiting.length, color: "var(--accent)" },
                    { label: "Waiting on others", value: waiting.length, color: "var(--amber)" },
                  ]}
                />
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Where steps come from" span="span 4">
          <View of={todo}>
            {(d) => (
              <div className="stack" style={{ gap: 2 }}>
                {d.sources
                  .filter((s) => s.configured || s.open)
                  .map((s) => (
                    <div key={s.system} className="list-row">
                      <span>{SYSTEM_LABEL[s.system] ?? s.system}</span>
                      <span className="row" style={{ gap: 6 }}>
                        {s.open > 0 && <span className="chip warn">{s.open} OPEN</span>}
                        <AdapterChip type={s.configured} />
                      </span>
                    </div>
                  ))}
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  {d.exports.files.length
                    ? `Exports in inputs/: ${plural(d.exports.workItems, "work item")}, ${plural(d.exports.requests, "request")}.`
                    : "No exports in inputs/ yet: drop a tracker or desk export there so Atticus can check results."}
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Local automation" span="span 5">
          <View of={todo}>
            {(d) => (
              <div className="stack">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  Allow-listed tools can do a step for you. A person approves each write and no
                  credentials are passed. <a href="#/settings">Executors allow-list</a>
                </p>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {d.executors.configured.length ? (
                    d.executors.configured.map((x) => (
                      <span key={x} className="chip ai">
                        {x}
                      </span>
                    ))
                  ) : (
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      No tools set up on this machine (.atticus/executors.yaml).
                    </span>
                  )}
                </div>
                {d.executors.problems.map((p) => (
                  <p key={p} className="run-note bad">
                    {p}
                  </p>
                ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Open steps" meta={open.length} span="span 4" rows="span 2">
          <View of={todo} empty={() => open.length === 0} emptyText="No open steps.">
            {() => (
              <nav aria-label="Open steps" className="stack" style={{ gap: 2 }}>
                {Object.entries(
                  open.reduce<Record<string, Step[]>>((a, s) => {
                    (a[s.system] ??= []).push(s);
                    return a;
                  }, {}),
                ).map(([system, list]) => (
                  <div key={system} className="stack" style={{ gap: 2 }}>
                    <span className="hud" style={{ fontSize: 10, marginTop: 6 }}>
                      {SYSTEM_LABEL[system] ?? system}
                    </span>
                    {list.map((s) => (
                      <button
                        key={`${s.change}/${s.id}`}
                        type="button"
                        className="run-pick"
                        aria-current={s.id === selected?.id ? "true" : undefined}
                        onClick={() => setCurrent(s.id)}
                      >
                        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 12.5 }}>{s.title}</span>
                          <span className="hud" style={{ fontSize: 9.5 }}>
                            {s.change ?? "no change"} · {s.id}
                          </span>
                        </span>
                        <span className={`chip ${s.waitsFor.length ? "warn" : ""}`}>
                          {s.waitsFor.length ? "WAITS" : "TO DO"}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            )}
          </View>
        </Panel>

        <Panel
          title={selected ? "Step" : "No step selected"}
          span="span 8"
          rows="span 2"
          kind="hero"
        >
          <View of={todo} empty={() => !selected} emptyText="Pick a step on the left.">
            {() => (
              <StepDetail
                key={`${selected!.change}/${selected!.id}`}
                step={selected!}
                done={() => todo.reload()}
              />
            )}
          </View>
        </Panel>

        <Panel title="Procedures a local tool can run" span="span 7">
          <View
            of={todo}
            empty={(d) => d.procedures.length === 0}
            emptyText="The org pack has no procedures yet (process/procedures)."
          >
            {(d) => (
              <table className="run-table">
                <thead>
                  <tr>
                    <th>Procedure</th>
                    <th>Tools allowed</th>
                    <th>Writes</th>
                    <th>Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {d.procedures.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.name}
                        <div className="hud" style={{ fontSize: 9.5 }}>
                          {p.id} · {p.status}
                        </div>
                      </td>
                      <td>
                        {p.allowed.length === 0 ? (
                          <span className="muted">none (off)</span>
                        ) : (
                          p.allowed.map((x) => (
                            <span
                              key={x}
                              className={`chip ${p.configured.includes(x) ? "ai" : "dim"}`}
                              title={
                                p.configured.includes(x)
                                  ? "Set up here"
                                  : "Not set up on this machine"
                              }
                              style={{ marginRight: 4 }}
                            >
                              {x}
                              {p.configured.includes(x) ? "" : " · not here"}
                            </span>
                          ))
                        )}
                      </td>
                      <td>{p.writes}</td>
                      <td>
                        {p.lastRun
                          ? `${day(p.lastRun.at)} · ${p.lastRun.status} · ${p.lastRun.executor}`
                          : "never run"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </View>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            Each run shows the exact inputs first, waits for your approval, and logs what happened.
            Protected branches and deploys are never touched.
          </p>
        </Panel>

        <Panel title="Done" meta={closed.length} span="span 5">
          <View of={todo} empty={() => closed.length === 0} emptyText="Nothing done yet.">
            {() =>
              closed.map((s) => (
                <button
                  key={`${s.change}/${s.id}`}
                  type="button"
                  className="run-pick"
                  aria-current={s.id === selected?.id ? "true" : undefined}
                  onClick={() => setCurrent(s.id)}
                >
                  <span style={{ fontSize: 12.5 }}>{s.title}</span>
                  <span className={`chip ${s.state === "done" ? "done" : "dim"}`}>
                    {s.state.toUpperCase()}
                  </span>
                </button>
              ))
            }
          </View>
        </Panel>

        <Panel title="Owner questions waiting" meta={questions.length || undefined} span="span 12">
          <View
            of={findings}
            empty={() => questions.length === 0}
            emptyText="No owner questions waiting."
          >
            {() => (
              <div className="stack" style={{ gap: 0 }}>
                {questions.map((f) => (
                  <div key={`${f.change}/${f.gate}/${f.id}`} className="list-row">
                    <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5 }}>{f.question!.text}</span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {f.question!.owner ?? "owner not known"} · {f.change} · {f.gate}
                      </span>
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`chip ${f.state === "asked" ? "ai" : "warn"}`}>
                        {f.state.toUpperCase()}
                      </span>
                      <CopyButton text={f.question!.text} label="Copy question text" />
                      <a
                        className="btn"
                        href={`#/changes/${f.change}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          textDecoration: "none",
                        }}
                      >
                        Open change
                      </a>
                    </span>
                  </div>
                ))}
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  Each question is asked once and the answer is reused at every gate. Asking happens
                  outside Atticus: copy the text, then record the answer on the change.
                </p>
              </div>
            )}
          </View>
        </Panel>
      </div>
    </>
  );
}
