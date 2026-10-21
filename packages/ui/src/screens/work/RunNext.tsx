import type { Loaded } from "../../api/client.js";
import { View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";
import type { Slash, Step } from "./next.js";
import "./work.css";

const R = COPY.runNext;

/** A command on its own line with a copy button; a keyboard reaches the button. */
export function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="work-cmd">
      <code className="mono">{text}</code>
      <CopyButton text={text} label={`${label}: ${text}`} />
    </div>
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
 * the slash command to type in Copilot Chat where one exists. It shows; it never runs.
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
