import type { Loaded } from "../../api/client.js";
import { RunStep } from "../../app/runstep.js";
import { View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";
import type { Slash, Step } from "./next.js";
import "./work.css";

const R = COPY.runNext;

/**
 * A command on its own line with a copy button; a keyboard reaches the button. An AI step also
 * gets a Run button where a model can be reached from here (ADR 0106): Copilot in a VS Code
 * panel, the server's model in a browser.
 */
export function Command({ text, label }: { text: string; label: string }) {
  return (
    <>
      <div className="work-cmd">
        <code className="mono">{text}</code>
        <CopyButton text={text} label={`${label}: ${text}`} />
      </div>
      <RunStep command={text} />
    </>
  );
}

function SlashLine({ slash }: { slash: Slash }) {
  return (
    <>
      <p className="work-say">
        {slash.where === COPY.work.slashWhere.metarepo ? R.slash : R.slashIn(slash.where)}
      </p>
      <Command text={slash.command} label={R.copySlash} />
    </>
  );
}

/**
 * The page's "Run next" (plan 4.5): the command for this page's step with a copy button, and
 * the slash command to type in Copilot Chat where one exists. An AI step also gets a Run button
 * where a model can be reached from here (ADR 0106).
 */
export function RunNextPanel({ step }: { step: Step }) {
  return (
    <section className="panel hero work-next" aria-labelledby="run-next">
      <h2 id="run-next" className="h">
        {R.title}
      </h2>
      <p className="work-why">{step.why}</p>
      <p className="work-say">{R.terminal}</p>
      <Command text={step.command} label={R.copy} />
      {step.slash ? <SlashLine slash={step.slash} /> : <p className="work-say">{R.noSlash}</p>}
      <p className="work-say">{R.whatNext}</p>
      {step.link && (
        <p style={{ margin: "8px 0 0" }}>
          <a href={step.link.href}>{step.link.label}</a>
        </p>
      )}
      {step.after && step.after.length > 0 && (
        <details className="work-after">
          <summary>{R.after}</summary>
          <ol>
            {step.after.map((a) => (
              <li key={a.command}>
                <p className="work-say">{a.why}</p>
                <Command text={a.command} label={R.copy} />
                {a.slash && <SlashLine slash={a.slash} />}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** Run next while its data loads, fails or is ready: never a blank where the command goes. */
export function RunNext<T>({ of, step }: { of: Loaded<T>; step: (d: T) => Step }) {
  return <View of={of}>{(d) => <RunNextPanel step={step(d)} />}</View>;
}

/**
 * A page that works on one change, when there is none: what to run to start one, with Copy,
 * and where the changes are listed. Always in a panel, never a bare line.
 */
export function NoChangeYet({ title }: { title?: string }) {
  const W = COPY.work;
  return (
    <section className="panel" aria-labelledby="no-change" style={{ gridColumn: "1 / -1" }}>
      <h2 id="no-change" className="h">
        {title ?? W.noChangeTitle}
      </h2>
      <p className="work-why">{W.noChangeYet}</p>
      <p className="work-say">{R.terminal}</p>
      <Command text={W.noChangeCommand} label={R.copy} />
      <p className="work-say">
        <a href="#/changes">{W.noChangeLink}</a>
      </p>
    </section>
  );
}

/** Files that couldn't be read, by name, so nothing is dropped silently. */
export function Problems({ list }: { list: { file: string; message: string }[] }) {
  if (list.length === 0) return null;
  return (
    <div className="state error" role="alert">
      {COPY.work.unreadable}
      <ul>
        {list.map((p) => (
          <li key={`${p.file}:${p.message}`}>
            <code className="mono">{p.file}</code>: {p.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
