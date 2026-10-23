import { useState } from "react";
import { api, useApi } from "../../api/client.js";
import { Bar, Panel, Ring, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Choice, CopyButton, Note, plural, useAction } from "./shared.js";

interface LessonStep {
  id: string;
  n: number;
  title: string;
  body: string;
  commands: string[];
  question?: string;
  hint: string;
}
interface Learning {
  sandbox: boolean;
  roles: { role: string; lessons: number; done: number }[];
  lessons: {
    id: string;
    role: string;
    title: string;
    summary: string;
    minutes: number;
    steps: number;
    done: number;
    state: "not-started" | "in-progress" | "done";
  }[];
  current?: {
    lesson: string;
    title: string;
    intro: string;
    steps: number;
    completed: boolean;
    step?: LessonStep;
    outro?: string;
  };
  problems: string[];
}
interface CheckResult {
  pass: boolean;
  message: string;
  next: string | null;
  completed: boolean;
  hint?: string;
}

const STATE = {
  "not-started": { label: "NEW", cls: "dim" },
  "in-progress": { label: "IN PROGRESS", cls: "warn" },
  done: { label: "DONE", cls: "done" },
} as const;

function Exercise({ cur, reload }: { cur: NonNullable<Learning["current"]>; reload: () => void }) {
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState(false);
  const act = useAction();
  const step = cur.step;
  if (!step)
    return (
      <div className="stack">
        <p className="run-note ok">You have finished this lesson.</p>
        <p className="run-text">{cur.outro}</p>
      </div>
    );
  return (
    <form
      className="stack"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () =>
            api<CheckResult>("/api/learning/check", {
              method: "POST",
              body: answer ? { answer } : {},
            }).then((r) => {
              if (r.pass) {
                setAnswer("");
                setHint(false);
                reload();
              }
              if (!r.pass)
                throw new Error(`Not yet: ${r.message}${r.hint ? `\nHint: ${r.hint}` : ""}`);
              return r;
            }),
          (r) => `Passed: ${(r as CheckResult).message}`,
        );
      }}
    >
      <span className="hud" style={{ fontSize: 10 }}>
        Step {step.n} of {cur.steps}
      </span>
      <p className="n" style={{ margin: 0, fontSize: 18 }}>
        {step.title}
      </p>
      <p className="run-text">{step.body}</p>
      {step.commands.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="hud" style={{ fontSize: 10 }}>
            Try in the sandbox
          </span>
          {step.commands.map((c) => (
            <div
              key={c}
              className="row between run-field"
              style={{ gridTemplateColumns: "1fr auto" }}
            >
              <code className="value">{c}</code>
              <CopyButton text={c} label={`Copy ${c}`} />
            </div>
          ))}
        </div>
      )}
      {step.question && (
        <label className="run-label" htmlFor="learn-answer">
          {step.question}
          <input
            id="learn-answer"
            className="run-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="submit" className="btn primary" disabled={act.busy}>
          Check my work
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={hint}
          onClick={() => setHint((h) => !h)}
        >
          {hint ? "Hide the hint" : "Show a hint"}
        </button>
      </div>
      {hint && (
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Hint: {step.hint}
        </p>
      )}
      <Note note={act.note} />
    </form>
  );
}

function SandboxForm() {
  const [dir, setDir] = useState("");
  const [blank, setBlank] = useState(false);
  const act = useAction();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        // No folder yet: say so, rather than a button that silently does nothing.
        if (!dir.trim()) {
          setBlank(true);
          return;
        }
        setBlank(false);
        void act.run(
          () => api<{ root: string }>("/api/learning/sandbox", { method: "POST", body: { dir } }),
          (r) =>
            `Made a practice sandbox. Start the app there with: atticus ui --root ${(r as { root: string }).root}`,
        );
      }}
    >
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Lessons run only in a practice sandbox: a throwaway copy of the invented Forge estate. No
        network, no real systems, no real data. This metarepo isn't one, so lessons are read-only
        here.
      </p>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="run-label" htmlFor="sandbox-dir" style={{ flex: "1 1 260px" }}>
          A new, empty folder for the sandbox
          <input
            id="sandbox-dir"
            className="run-input"
            value={dir}
            onChange={(e) => {
              setDir(e.target.value);
              setBlank(false);
            }}
            aria-describedby={blank ? "sandbox-dir-blank" : undefined}
            placeholder="/home/you/atticus-sandbox"
          />
        </label>
        <button type="submit" className="btn primary" disabled={act.busy}>
          Make a sandbox
        </button>
      </div>
      {blank && (
        <p id="sandbox-dir-blank" role="alert" className="run-note bad">
          {COPY.app.needFolder}
        </p>
      )}
      <Note note={act.note} />
    </form>
  );
}

export function Learning() {
  const l = useApi<Learning>("/api/learning");
  const [role, setRole] = useState("all");
  const start = useAction();
  const roles = l.state === "ready" ? l.data.roles : [];
  const lessons =
    l.state === "ready" ? l.data.lessons.filter((x) => role === "all" || x.role === role) : [];
  const totals =
    l.state === "ready"
      ? {
          done: l.data.lessons.filter((x) => x.state === "done").length,
          all: l.data.lessons.length,
        }
      : { done: 0, all: 0 };

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          Learning
        </p>
        {l.state === "ready" && (
          <span className={`chip ${l.data.sandbox ? "done" : "dim"}`}>
            {l.data.sandbox ? "PRACTICE SANDBOX · OFFLINE FORGE" : "NOT A SANDBOX"}
          </span>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Lessons built on the Forge estate, with a sandbox to practise in. Nothing here touches a
        real system.
      </p>

      <div className="bento">
        <Panel title="Progress" span="span 4">
          <View of={l}>
            {() => (
              <div className="row" style={{ alignItems: "flex-start" }}>
                <Ring
                  value={totals.done}
                  max={totals.all}
                  size={72}
                  text={totals.all ? `${Math.round((totals.done / totals.all) * 100)}%` : "0%"}
                  label={`${totals.done} of ${totals.all} lessons done`}
                />
                <span style={{ fontSize: 12.5 }}>
                  {totals.done} of {plural(totals.all, "lesson")} done.
                </span>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Progress by kind of work" meta="lessons done" span="span 8">
          <View of={l} empty={() => roles.length === 0} emptyText="No lessons are installed.">
            {() => (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "8px 16px",
                }}
              >
                {roles.map((r) => (
                  <div key={r.role} className="stack" style={{ gap: 4 }}>
                    <div className="row between">
                      <span style={{ fontSize: 12.5 }}>{r.role}</span>
                      <span className="hud" style={{ fontSize: 10 }}>
                        {r.done}/{r.lessons}
                      </span>
                    </div>
                    <Bar value={r.done} max={r.lessons} label={`${r.role} lessons done`} />
                  </div>
                ))}
              </div>
            )}
          </View>
        </Panel>

        {l.state === "ready" && !l.data.sandbox && (
          <Panel title="Practise in a sandbox" span="span 12">
            <SandboxForm />
          </Panel>
        )}

        {l.state === "ready" && l.data.current && (
          <Panel
            title={`Exercise · ${l.data.current.title}`}
            meta={l.data.current.completed ? "done" : undefined}
            span="span 12"
            kind="hero"
          >
            <Exercise key={l.data.current.lesson} cur={l.data.current} reload={() => l.reload()} />
          </Panel>
        )}

        <Panel title="Lessons" span="span 12">
          <div style={{ marginBottom: 10 }}>
            <Choice
              label="Written for"
              value={role}
              onChange={setRole}
              options={[
                { value: "all", label: "Everyone" },
                ...roles.map((r) => ({ value: r.role, label: r.role })),
              ]}
            />
          </div>
          <View
            of={l}
            empty={() => lessons.length === 0}
            emptyText="No lessons written for this kind of work."
          >
            {(d) => (
              <div className="stack" style={{ gap: 0 }}>
                {lessons.map((x) => (
                  <article key={x.id} className="list-row" style={{ alignItems: "flex-start" }}>
                    <span className="stack" style={{ gap: 3, minWidth: 0 }}>
                      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13.5 }}>{x.title}</span>
                        <span className={`chip ${STATE[x.state].cls}`}>
                          {STATE[x.state].label}
                          {x.state === "in-progress" ? ` · ${x.done}/${x.steps}` : ""}
                        </span>
                      </span>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {x.summary}
                      </span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {x.role} · {x.minutes} min · {plural(x.steps, "step")}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={!d.sandbox || start.busy || x.state === "done"}
                      title={d.sandbox ? undefined : "Lessons run in a practice sandbox"}
                      aria-label={`${x.state === "in-progress" ? "Continue" : "Start"} ${x.title}`}
                      onClick={() =>
                        void start.run(
                          () =>
                            api<{ setup: string[] }>("/api/learning/start", {
                              method: "POST",
                              body: { lesson: x.id },
                            }).then((r) => {
                              l.reload();
                              return r;
                            }),
                          (r) =>
                            [`Started ${x.title}.`, ...(r as { setup: string[] }).setup].join(" "),
                        )
                      }
                    >
                      {x.state === "in-progress"
                        ? "Continue"
                        : x.state === "done"
                          ? "Done"
                          : "Start"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </View>
          <Note note={start.note} />
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            Lessons and exercises use only the invented Forge ecosystem. A check passes from what
            the sandbox's files say, never from a model.
          </p>
        </Panel>
      </div>
    </>
  );
}
