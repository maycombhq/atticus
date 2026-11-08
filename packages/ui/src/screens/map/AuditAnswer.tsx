import { useEffect, useId, useState } from "react";
import { Propose } from "../../app/propose.js";
import type { Api } from "@maycombhq/core";
import { api, useApi, type Loaded } from "../../api/client.js";
import { CorrectFact, useEvidence } from "../../app/evidence.js";
import { COPY } from "../../copy.js";
import { CopyButton, message } from "../run/shared.js";

/**
 * Map › Trust's Sample audit answered in the app (P3's follow-up, ADR 0149). The sample is drawn
 * by the server as `atticus verify audit` draws it (the same seed, the same items), each item
 * with its cited lines; right, wrong or unsure, with a note, is written to
 * `facts/<repo>.audit.yaml` by the CLI's own functions (POST /api/facts/{repo}/audit). A wrong
 * fact opens Correct this; a wrong link points to the canvas's This link is wrong. The app runs
 * no git: the answer carries the command.
 */

const A = COPY.trust.sample;
type Sample = Api.AuditSampleViewT;
type Item = Api.AuditItemViewT;
type Answer = "right" | "wrong" | "unsure";
export type Pick = { answer?: Answer; note: string };
export type AuditSaving =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; result: Api.AuditAnswerResultT }
  | { state: "error"; text: string };

function Cmd({ text, label }: { text: string; label: string }) {
  return (
    <div className="work-cmd">
      <code className="mono">{text}</code>
      <CopyButton text={text} label={`${label}: ${text}`} />
    </div>
  );
}

/** A wrong answer's way to correct it: Correct this for a fact, the canvas for a link. */
function CorrectWrong({ repo, item }: { repo: string; item: Item }) {
  const ev = useEvidence();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (item.kind === "fact") ev?.need(repo);
  }, [ev, repo, item.kind]);
  if (item.kind === "link")
    return (
      <a href={`#/canvas?lens=repo&node=${encodeURIComponent(`repo:${repo}`)}`}>
        {A.wrongLink(repo)}
      </a>
    );
  const facts = ev?.of(repo);
  const fact =
    facts?.state === "ready" ? facts.data.facts.find((f) => f.id === item.fact) : undefined;
  if (facts?.state === "ready" && !fact) return <p className="work-say">{A.factGone}</p>;
  return (
    <div>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-label={A.wrongFactOf(item.claim)}
        disabled={!fact}
        onClick={() => setOpen((o) => !o)}
      >
        {A.wrongFact}
      </button>
      {open && fact && <CorrectFact repo={repo} fact={fact} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The draw and its answers from their state, so tests can render each one. */
export function AuditAnswerForm(p: {
  repo: string;
  sample: Loaded<Sample>;
  picks: Readonly<Record<string, Pick>>;
  onPick: (id: string, pick: Pick) => void;
  saving: AuditSaving;
  onSave: (answers: { id: string; answer: Answer; note?: string }[]) => void;
  problem?: string | undefined;
}) {
  const id = useId();
  if (p.sample.state === "loading")
    return (
      <p role="status" aria-busy="true" className="work-say">
        {A.loading}
      </p>
    );
  if (p.sample.state === "error")
    return (
      <p role="alert" className="state error">
        {A.failed(p.sample.error)}
      </p>
    );
  const v = p.sample.data;
  if (v.refused)
    return (
      <div>
        <p className="work-say">{A.refused[v.refused]!(p.repo, v.unverified ?? 0)}</p>
        <Cmd text={v.command} label={A.copyCommand} />
      </div>
    );
  if (!v.items.length) return <p className="work-say">{A.empty}</p>;
  const pickOf = (i: Item): Pick => p.picks[i.id] ?? { note: i.note ?? "" };
  // Not a form: a wrong fact's Correct this is a form of its own, and forms don't nest.
  const submit = () => {
    const answers = v.items.flatMap((i) => {
      const k = p.picks[i.id];
      // Review round 32: a note edited on an item answered before keeps the answer on file.
      const answer = k && (k.answer ?? i.answer);
      return answer
        ? [{ id: i.id, answer, ...(k.note.trim() ? { note: k.note.trim() } : {}) }]
        : [];
    });
    p.onSave(answers);
  };
  const s = p.saving;
  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby={`${id}-t`}>
      <h4 id={`${id}-t`} className="h" style={{ fontSize: 14 }}>
        {A.openOf(p.repo)}
      </h4>
      <ol className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0 }}>
        {v.items.map((i, k) => {
          const pick = pickOf(i);
          const chosen = pick.answer ?? i.answer;
          const name = `${id}-${k}`;
          const what = i.kind === "fact" ? A.fact : A.link(i.of);
          return (
            <li key={i.id}>
              <fieldset className="ev-choice">
                <legend>{A.item(k + 1, v.items.length, what, i.claim)}</legend>
                <p className="hud" style={{ margin: 0 }}>
                  {A.lines}
                </p>
                <ul className="ev-list">
                  {i.lines.map((l) => (
                    <li key={l.cite}>
                      <code className="mono">{l.cite}</code>{" "}
                      {l.text ? <code className="mono">{l.text}</code> : A.noText}
                    </li>
                  ))}
                </ul>
                {i.answer && i.by && (
                  <p className="work-say">{A.onFile(A.choices[i.answer]!, i.by)}</p>
                )}
                <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                  {(["right", "wrong", "unsure"] as const).map((a) => (
                    <label key={a} className="row" style={{ gap: 4 }}>
                      <input
                        type="radio"
                        name={name}
                        value={a}
                        checked={chosen === a}
                        onChange={() => p.onPick(i.id, { ...pick, answer: a })}
                      />
                      {A.choices[a]}
                    </label>
                  ))}
                </div>
                <label className="stack" style={{ gap: 2 }}>
                  <span className="hud">{chosen === "wrong" ? A.note : A.noteOptional}</span>
                  <textarea
                    rows={1}
                    value={pick.note}
                    onChange={(e) => p.onPick(i.id, { ...pick, note: e.target.value })}
                  />
                </label>
                {chosen === "wrong" && <CorrectWrong repo={p.repo} item={i} />}
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={s.state === "working"}
          onClick={submit}
        >
          {s.state === "working" ? A.saving : A.save}
        </button>
      </div>
      {p.problem && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {p.problem}
        </p>
      )}
      {s.state === "working" && (
        <p role="status" aria-busy="true" className="work-say">
          {A.saving}
        </p>
      )}
      {s.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {s.text}
        </p>
      )}
      {s.state === "done" && (
        <div role="status">
          <p className="work-say">{A.saved(s.result.file, s.result.answered, s.result.open)}</p>
          <Propose scope="audit" />
          <Cmd text={s.result.commit} label={A.copyCommit} />
        </div>
      )}
      <p className="work-say">{A.sameInTerminal}</p>
      <Cmd text={v.command} label={A.copyCommand} />
    </section>
  );
}

/** The seed and size, the draw, the answers and their POST. */
export function AuditAnswer({ repo }: { repo: string }) {
  const id = useId();
  const [seed, setSeed] = useState("");
  const [size, setSize] = useState("10");
  const [asked, setAsked] = useState({ seed: "", size: "10" });
  const query = new URLSearchParams({
    ...(asked.seed.trim() ? { seed: asked.seed.trim() } : {}),
    ...(asked.size ? { size: asked.size } : {}),
  }).toString();
  const sample = useApi<Sample>(`/api/facts/${encodeURIComponent(repo)}/audit?${query}`);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [saving, setSaving] = useState<AuditSaving>({ state: "idle" });
  const [problem, setProblem] = useState<string | undefined>();
  const v = sample.state === "ready" ? sample.data : undefined;
  const onSave = (answers: { id: string; answer: Answer; note?: string }[]) => {
    if (!v) return;
    if (!answers.length) return setProblem(A.nothingPicked);
    setProblem(undefined);
    setSaving({ state: "working" });
    api<Api.AuditAnswerResultT>(`/api/facts/${encodeURIComponent(repo)}/audit`, {
      method: "POST",
      body: { seed: v.seed, size: v.size, answers },
    }).then(
      (result) => {
        setSaving({ state: "done", result });
        setPicks({});
        sample.reload();
      },
      (e: unknown) => setSaving({ state: "error", text: message(e) }),
    );
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="work-say">{A.intro}</p>
      <form
        className="row"
        style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          setPicks({});
          setSaving({ state: "idle" });
          setAsked({ seed, size });
        }}
      >
        <label className="stack" style={{ gap: 2 }}>
          <span className="hud">{A.seed}</span>
          <input
            value={seed}
            aria-describedby={`${id}-seed`}
            onChange={(e) => setSeed(e.target.value)}
          />
          <span id={`${id}-seed`} className="work-say">
            {v?.defaultSeed ? A.seedHint(v.defaultSeed) : A.seedHintNone}
          </span>
        </label>
        <label className="stack" style={{ gap: 2 }}>
          <span className="hud">{A.size}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <button type="submit" className="btn">
          {A.draw}
        </button>
      </form>
      <AuditAnswerForm
        repo={repo}
        sample={sample}
        picks={picks}
        onPick={(itemId, pick) => setPicks((m) => ({ ...m, [itemId]: pick }))}
        saving={saving}
        onSave={onSave}
        problem={problem}
      />
    </div>
  );
}
