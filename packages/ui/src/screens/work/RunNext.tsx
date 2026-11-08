import type { Loaded } from "../../api/client.js";
import { NewChange } from "./NewChange.js";
import { RunStep } from "../../app/runstep.js";
import { View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";
import type { Slash, Step } from "./next.js";
import { hasAction, StepAction } from "./step-action.js";
import "./work.css";

const R = COPY.runNext;

/**
 * A command on its own line with a copy button; a keyboard reaches the button. An AI step also
 * gets a Run button where a model can be reached from here (ADR 0106): Copilot in a VS Code
 * panel, the server's model in a browser.
 */
export function Command({
  text,
  label,
  noRun,
}: {
  text: string;
  label: string;
  /** The page shows the step's Run itself, so the command doesn't show it twice. */
  noRun?: boolean;
}) {
  return (
    <>
      <div className="work-cmd">
        <code className="mono">{text}</code>
        <CopyButton text={text} label={`${label}: ${text}`} />
      </div>
      {!noRun && <RunStep command={text} />}
    </>
  );
}

/**
 * Eighth UX walk: an AI step offered outside Run next (a stage's critic panel, the breaks panel,
 * the target flows): the in-app Prepare (or Run) first, then the slash command, and the command
 * folded under "Or in a terminal", as Run next does.
 */
export function PrepareFirst({ command, slash }: { command: string; slash?: string | undefined }) {
  return (
    <>
      <RunStep command={command} />
      {slash && (
        <>
          <p className="work-say">{R.slash}</p>
          <Command text={slash} label={R.copySlash} noRun />
        </>
      )}
      <details className="work-terminal">
        <summary>{R.orTerminal}</summary>
        <p className="work-say">{R.terminal}</p>
        <Command text={command} label={R.copy} noRun />
      </details>
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
  // Seventh UX walk: the step's in-app action first (a button, Prepare, or the page that does
  // it); the command stays copyable under "Or in a terminal". A step the app can't take keeps
  // the command first.
  const action = hasAction(step);
  // With no control of its own, the page that does the step is the action.
  const link = step.link && (
    <p style={{ margin: 0 }}>
      <a className={action ? undefined : "btn primary"} href={step.link.href}>
        {step.link.label}
      </a>
    </p>
  );
  const inApp = action || !!step.link;
  return (
    <section className="panel hero work-next" aria-labelledby="run-next">
      <h2 id="run-next" className="h">
        {R.title}
      </h2>
      <p className="work-why">{step.why}</p>
      {inApp ? (
        <>
          {action && <StepAction {...step} />}
          {link}
          {step.slash && <SlashLine slash={step.slash} />}
          <details className="work-terminal">
            <summary>{R.orTerminal}</summary>
            <p className="work-say">{R.terminal}</p>
            <Command text={step.command} label={R.copy} noRun />
          </details>
        </>
      ) : (
        <>
          <p className="work-say">{R.terminal}</p>
          <Command text={step.command} label={R.copy} />
          {step.slash ? <SlashLine slash={step.slash} /> : <p className="work-say">{R.noSlash}</p>}
        </>
      )}
      <p className="work-say">{R.whatNext}</p>
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
/**
 * A change's tab (At a glance, a stage) opened with no change in its address: pick one in All
 * changes, and every tab of Change follows it. Bare inside a panel, else a panel of its own.
 */
export function PickAChange({ bare = false }: { bare?: boolean }) {
  const W = COPY.work;
  const body = (
    <>
      <p className="work-why">{W.pickAChange}</p>
      <p className="work-say">
        <a href="#/changes">{W.openAllChanges}</a>
      </p>
    </>
  );
  if (bare) return <div className="state">{body}</div>;
  return (
    <section className="panel" aria-labelledby="pick-a-change" style={{ gridColumn: "1 / -1" }}>
      <h2 id="pick-a-change" className="h">
        {W.pickAChangeTitle}
      </h2>
      {body}
    </section>
  );
}

export function NoChangeYet({ title }: { title?: string }) {
  const W = COPY.work;
  return (
    <section className="panel" aria-labelledby="no-change" style={{ gridColumn: "1 / -1" }}>
      <h2 id="no-change" className="h">
        {title ?? W.noChangeTitle}
      </h2>
      <p className="work-why">{W.noChangeYet}</p>
      <NewChange />
      <details className="work-terminal">
        <summary>{R.orTerminal}</summary>
        <p className="work-say">{R.terminal}</p>
        <Command text={W.noChangeCommand} label={R.copy} />
      </details>
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
