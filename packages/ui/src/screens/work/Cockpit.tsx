import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../../api/client.js";
import { screenOf, tabHref } from "../../app/screens.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import type { ChangeRow } from "./next.js";
import { Command } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";

/**
 * The change cockpit (WP7.1): one page per change with what a person needs to follow it. Where
 * it is, the next step with its slash command, what blocks it, each stage's progress, the risk,
 * and each repo's change branch and base. It reads; the steps run in the assistant or the CLI.
 */

const C = COPY.cockpit;

type Cockpit = Api.ChangeCockpitT;

/** A tab's address by its id, keeping the change. */
const hrefOf = (id: string, change: string) => {
  const s = screenOf(id);
  return s ? tabHref(s, change) : `#/${id}`;
};

/** Which step of the stage path a stage is: done, the current one, or still to come. */
export function stageMark(s: Cockpit["stages"][number]): "done" | "current" | "todo" {
  if (s.state === "done") return "done";
  if (s.state === "not-started") return "todo";
  return "current";
}

export function CockpitView({ c }: { c: Cockpit }) {
  return (
    <div className="stack">
      <section aria-labelledby="cockpit-where" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-where" className="hud">
          {C.where}
        </h3>
        <p style={{ margin: 0 }}>{C.state(c.state, c.risk.level)}</p>
        <ol
          className="row"
          style={{ gap: 6, flexWrap: "wrap", listStyle: "none", padding: 0, margin: 0 }}
        >
          {c.stages.map((s) => {
            const mark = stageMark(s);
            return (
              <li key={s.stage}>
                <a
                  className={`chip ${mark === "done" ? "" : mark === "current" ? "warn" : ""}`}
                  href={hrefOf(C.stageScreen[s.stage]!, c.id)}
                  aria-current={mark === "current" ? "step" : undefined}
                >
                  {C.stage(C.stages[s.stage]!, C.marks[mark]!)}
                </a>
                {(s.drafts > 0 || s.openQuestions > 0) && (
                  <span className="muted" style={{ fontSize: 11.5, marginLeft: 4 }}>
                    {C.progress(s.drafts, s.rounds, s.openQuestions)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="cockpit-next" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-next" className="hud">
          {C.next}
        </h3>
        <p style={{ margin: 0 }}>{c.nextStep}</p>
        {c.next && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {c.next.why}
            </p>
            {c.next.slash && <Command text={c.next.slash} label={C.copySlash} />}
            <Command text={c.next.command} label={C.copyCommand} />
          </>
        )}
      </section>

      {c.reasons.length > 0 && (
        <section aria-labelledby="cockpit-blocks" className="stack" style={{ gap: 6 }}>
          <h3 id="cockpit-blocks" className="hud">
            {C.blocks}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {c.reasons.map((r) => (
              <li key={`${r.code}-${r.message}`}>{r.message}</li>
            ))}
          </ul>
        </section>
      )}

      {c.openQuestions > 0 && (
        <p style={{ margin: 0 }}>
          <a href={hrefOf("questions", c.id)}>{C.questions(c.openQuestions)}</a>
        </p>
      )}

      <section aria-labelledby="cockpit-repos" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-repos" className="hud">
          {C.repos}
        </h3>
        {c.repos.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {C.noRepos}
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {c.repos.map((r) => (
              <li key={r.id}>
                <span className="mono">{r.id}</span>: {C.branchOn(r.branch, r.base)}
                {r.pr && (
                  <>
                    {" · "}
                    <a href={r.pr}>{C.pr}</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ChangeCockpit({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const asked = queryParam(hash, "change");
  const current = asked ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  const c = useApi<Cockpit>(
    current ? `/api/changes/${encodeURIComponent(current)}/cockpit` : undefined,
  );
  useReloadOnFiles(c);
  return (
    <Panel title={C.title}>
      <View of={list} empty={(l) => l.length === 0} emptyText={C.none}>
        {(l) => (
          <>
            <ChangePicker list={l} current={current} screen="cockpit" />
            {current && <View of={c}>{(d) => <CockpitView c={d} />}</View>}
          </>
        )}
      </View>
    </Panel>
  );
}
