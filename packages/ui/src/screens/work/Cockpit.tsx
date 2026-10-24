import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { screenOf, tabHref } from "../../app/screens.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, queryParam, useAction } from "../know/common.js";
import type { ChangeRow } from "./next.js";
import { Command, PickAChange } from "./RunNext.js";
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

/** WP7.6: the archived changes nearest this one, each one click from being its example. */
export function PastChangesView(p: {
  r: Api.SimilarChangesT;
  onUse?: (id: string) => void;
  busy?: boolean;
}) {
  const L = C.like;
  return (
    <section aria-label={L.title}>
      <h3>{L.title}</h3>
      <p className="muted">{L.intro}</p>
      {p.r.how === "words" && p.r.note && p.r.changes.length > 0 && (
        <p className="muted">{L.byWords(p.r.note)}</p>
      )}
      {p.r.changes.length === 0 ? (
        <p className="muted">{L.none}</p>
      ) : (
        <ul className="plain">
          {p.r.changes.map((c) => (
            <li key={c.id}>
              <strong>{c.title}</strong>
              {c.archived && <span className="muted"> · {L.archived(c.archived)}</span>}
              {c.summary && <div>{c.summary}</div>}
              {p.onUse && (
                <button
                  type="button"
                  className="btn"
                  disabled={p.busy}
                  onClick={() => p.onUse?.(c.id)}
                >
                  {L.use}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PastChanges({ change }: { change: string }) {
  const r = useApi<Api.SimilarChangesT>(`/api/past-changes?change=${encodeURIComponent(change)}`);
  const act = useAction();
  return (
    <View of={r}>
      {(d) => (
        <>
          <PastChangesView
            r={d}
            busy={act.busy}
            onUse={(id) =>
              void act.run(
                () =>
                  api(`/api/changes/${encodeURIComponent(change)}/like`, {
                    method: "POST",
                    body: { like: id },
                  }),
                C.like.used,
              )
            }
          />
          <Note note={act.note} />
        </>
      )}
    </View>
  );
}

/** Follow this change without being on it (WP7.5): kept in the person's own file. */
export function WatchButton(p: { change: string; watching: boolean; onChanged?: () => void }) {
  const act = useAction();
  return (
    <span className="row" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn"
        aria-pressed={p.watching}
        disabled={act.busy}
        onClick={() =>
          void act.run(
            async () => {
              await api("/api/me/watch", {
                method: "PUT",
                body: { change: p.change, watch: !p.watching },
              });
              p.onChanged?.();
            },
            p.watching ? C.unwatched : C.watched,
          )
        }
      >
        {p.watching ? C.unwatch : C.watch}
      </button>
      <Note note={act.note} />
    </span>
  );
}

/**
 * The page once the list is loaded: the change its address names, picked in All changes; without
 * one (or with one not in the list), say to pick it there.
 */
export function CockpitPicked(p: {
  list: ChangeRow[];
  current: string | undefined;
  c: Loaded<Cockpit>;
}) {
  if (!p.current || !p.list.some((x) => x.id === p.current)) return <PickAChange bare />;
  return (
    <>
      <ChangePicker list={p.list} current={p.current} screen="cockpit" />
      <View of={p.c}>{(d) => <CockpitView c={d} />}</View>
      <PastChanges change={p.current} />
    </>
  );
}

export function ChangeCockpit({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const current = queryParam(hash, "change");
  const c = useApi<Cockpit>(
    current ? `/api/changes/${encodeURIComponent(current)}/cockpit` : undefined,
  );
  const me = useApi<{ watching?: string[] }>("/api/me");
  useReloadOnFiles(c);
  return (
    <Panel
      title={C.title}
      meta={
        current && me.state === "ready" ? (
          <WatchButton
            change={current}
            watching={(me.data.watching ?? []).includes(current)}
            onChanged={me.reload}
          />
        ) : undefined
      }
    >
      <View of={list} empty={(l) => l.length === 0} emptyText={C.none}>
        {(l) => <CockpitPicked list={l} current={current} c={c} />}
      </View>
    </Panel>
  );
}
