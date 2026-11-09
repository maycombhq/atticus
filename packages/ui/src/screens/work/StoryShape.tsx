import { useId, useState, type FormEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles } from "../../api/client.js";
import { confirmed } from "../../api/confirm.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";

/**
 * ADR 0189, on the Stories tab. "The BA shapes, the AI re-checks": the business analyst renames,
 * splits, merges or adds a story in plain words; the next draft of the stories maps the tasks to
 * them, and the check says what is left uncovered. And the plan's work items: each story with its
 * tasks goes into the work tracker (a manual tracker makes a step each, with the fields to copy
 * and the id to record), and the ids are kept so a later update changes them, never duplicates.
 */

const S = COPY.roleWork.shape;
const WI = COPY.roleWork.workItems;

type Op = "rename" | "split" | "merge" | "add";

/** A story's id and title, from the work items' plan (`story:<id>`). */
export function storiesOf(plan: Api.WorkItemPlanT | undefined): { id: string; title: string }[] {
  return (plan?.items ?? [])
    .filter((i) => i.type === "story")
    .map((i) => ({ id: i.key.replace(/^story:/, ""), title: i.title }));
}

/** One shaping, in words. */
export function shapeWords(e: Api.StoryShapeViewT["entries"][number]): string {
  if (e.op === "rename") return S.entry.rename(e.story ?? "", e.name);
  if (e.op === "merge") return S.entry.merge((e.stories ?? []).join(", "), e.name);
  if (e.op === "split")
    return S.entry.split(
      e.story ?? "",
      [`"${e.name}"`, ...(e.parts ?? []).map((p) => `${p.id} "${p.name}"`)].join(", "),
    );
  return S.entry.add(e.added ?? "", e.name);
}

/** The request body a filled form sends, or why it can't be sent yet. */
export function shapeBody(f: {
  op: Op;
  story: string;
  stories: string[];
  name: string;
  words: string;
  part: string;
  partWords: string;
}): { body: Record<string, unknown> } | { error: string } {
  if (!f.name.trim()) return { error: S.name };
  if ((f.op === "rename" || f.op === "split") && !f.story) return { error: S.needStory };
  if (f.op === "merge" && f.stories.length < 2) return { error: S.needTwo };
  if (f.op === "split" && !f.part.trim()) return { error: S.needPart };
  const words = f.words.trim() ? { words: f.words.trim() } : {};
  if (f.op === "rename") return { body: { op: "rename", story: f.story, name: f.name.trim() } };
  if (f.op === "merge") return { body: { op: "merge", stories: f.stories, name: f.name.trim() } };
  if (f.op === "add") return { body: { op: "add", name: f.name.trim(), ...words } };
  return {
    body: {
      op: "split",
      story: f.story,
      name: f.name.trim(),
      ...words,
      parts: [
        { name: f.part.trim(), ...(f.partWords.trim() ? { words: f.partWords.trim() } : {}) },
      ],
    },
  };
}

export function StoryShapePanel({ change }: { change: string }) {
  const id = useId();
  const shape = useApi<Api.StoryShapeViewT>(
    `/api/changes/${encodeURIComponent(change)}/stories/shape`,
  );
  const plan = useApi<Api.WorkItemPlanT>(`/api/changes/${encodeURIComponent(change)}/work-items`);
  useReloadOnFiles(shape);
  useReloadOnFiles(plan);
  const [f, setF] = useState({
    op: "rename" as Op,
    story: "",
    stories: [] as string[],
    name: "",
    words: "",
    part: "",
    partWords: "",
  });
  const [error, setError] = useState<string | undefined>();
  const act = useAction();
  const remove = useAction();
  const stories = storiesOf(plan.state === "ready" ? plan.data : undefined);
  const set = (x: Partial<typeof f>) => setF((o) => ({ ...o, ...x }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = shapeBody(f);
    if ("error" in b) {
      setError(b.error);
      return;
    }
    setError(undefined);
    void act.run(
      () =>
        api(`/api/changes/${encodeURIComponent(change)}/stories/shape`, {
          method: "POST",
          body: b.body,
        }).then(() => {
          set({ name: "", words: "", part: "", partWords: "", stories: [] });
          shape.reload();
        }),
      S.recorded,
    );
  };
  const label = (s: { id: string; title: string }) => `${s.id} · ${s.title}`;
  return (
    <Panel title={S.title} span="1 / -1">
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
        {S.intro}
      </p>
      <View of={shape}>
        {(v) => (
          <div className="stack" style={{ gap: 10 }}>
            {v.entries.length === 0 ? (
              <div className="state">{S.none}</div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
                {v.entries.map((e) => (
                  <li key={e.id} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13 }}>{shapeWords(e)}</span>
                    <span className={`chip ${e.state === "applied" ? "done" : "warn"}`}>
                      {e.state === "applied" ? S.applied : S.waiting}
                    </span>
                    {e.state === "waiting" && (
                      <button
                        type="button"
                        className="btn"
                        disabled={remove.busy}
                        aria-label={S.removeFor(shapeWords(e))}
                        onClick={() =>
                          void remove.run(
                            () =>
                              api(
                                `/api/changes/${encodeURIComponent(change)}/stories/shape/${e.id}/remove`,
                                { method: "POST" },
                              ).then(() => shape.reload()),
                            S.remove,
                          )
                        }
                      >
                        {S.remove}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Note note={remove.note} />
            {v.entries.length > 0 && (
              <section aria-labelledby={`${id}-cover`} className="stack" style={{ gap: 4 }}>
                <h3 id={`${id}-cover`} className="hud" style={{ margin: 0, fontSize: 10 }}>
                  {S.uncovered}
                </h3>
                {v.uncovered.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {v.uncovered.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="chip done" style={{ width: "fit-content" }}>
                    {S.allCovered}
                  </span>
                )}
              </section>
            )}
          </div>
        )}
      </View>
      {stories.length === 0 ? (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          {S.notDrafted}
        </p>
      ) : (
        <form className="stack" style={{ gap: 6, marginTop: 10 }} onSubmit={submit}>
          <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
            <legend className="hud" style={{ fontSize: 10 }}>
              {S.op}
            </legend>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              {(["rename", "split", "merge", "add"] as const).map((op) => (
                <label key={op} className="row" style={{ gap: 4 }}>
                  <input
                    type="radio"
                    name={`${id}-op`}
                    checked={f.op === op}
                    onChange={() => set({ op })}
                  />
                  {S.ops[op]}
                </label>
              ))}
            </div>
          </fieldset>
          {(f.op === "rename" || f.op === "split") && (
            <div className="stack" style={{ gap: 2 }}>
              <label htmlFor={`${id}-story`} className="hud" style={{ fontSize: 10 }}>
                {S.story}
              </label>
              <select
                id={`${id}-story`}
                className="field"
                value={f.story}
                onChange={(e) => set({ story: e.target.value })}
              >
                <option value="">{S.needStory}</option>
                {stories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {f.op === "merge" && (
            <fieldset className="stack" style={{ gap: 2, border: 0, padding: 0, margin: 0 }}>
              <legend className="hud" style={{ fontSize: 10 }}>
                {S.stories}
              </legend>
              {stories.map((s) => (
                <label key={s.id} className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={f.stories.includes(s.id)}
                    onChange={(e) =>
                      set({
                        stories: e.target.checked
                          ? [...f.stories, s.id]
                          : f.stories.filter((x) => x !== s.id),
                      })
                    }
                  />
                  {label(s)}
                </label>
              ))}
            </fieldset>
          )}
          <div className="stack" style={{ gap: 2 }}>
            <label htmlFor={`${id}-name`} className="hud" style={{ fontSize: 10 }}>
              {f.op === "split" ? S.firstName : S.name}
            </label>
            <input
              id={`${id}-name`}
              className="field"
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          {(f.op === "add" || f.op === "split") && (
            <div className="stack" style={{ gap: 2 }}>
              <label htmlFor={`${id}-words`} className="hud" style={{ fontSize: 10 }}>
                {S.words}
              </label>
              <textarea
                id={`${id}-words`}
                className="field"
                rows={2}
                value={f.words}
                onChange={(e) => set({ words: e.target.value })}
              />
            </div>
          )}
          {f.op === "split" && (
            <>
              <div className="stack" style={{ gap: 2 }}>
                <label htmlFor={`${id}-part`} className="hud" style={{ fontSize: 10 }}>
                  {S.part}
                </label>
                <input
                  id={`${id}-part`}
                  className="field"
                  value={f.part}
                  onChange={(e) => set({ part: e.target.value })}
                />
              </div>
              <div className="stack" style={{ gap: 2 }}>
                <label htmlFor={`${id}-part-words`} className="hud" style={{ fontSize: 10 }}>
                  {S.partWords}
                </label>
                <textarea
                  id={`${id}-part-words`}
                  className="field"
                  rows={2}
                  value={f.partWords}
                  onChange={(e) => set({ partWords: e.target.value })}
                />
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="state error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn primary" disabled={act.busy}>
              {act.busy ? S.recording : S.record}
            </button>
          </div>
          <Note note={act.note} />
        </form>
      )}
    </Panel>
  );
}

/** A work item's standing, in words. */
export function workItemState(i: Api.WorkItemPlanT["items"][number]): string {
  if (i.action === "create") return WI.toCreate;
  if (i.action === "update") return WI.changed;
  if (i.action === "orphaned") return WI.gone;
  return i.id?.startsWith("manual:") ? WI.waiting : `${WI.created}: ${i.id}`;
}

export function WorkItemsPanel({ change }: { change: string }) {
  const plan = useApi<Api.WorkItemPlanT>(`/api/changes/${encodeURIComponent(change)}/work-items`);
  useReloadOnFiles(plan);
  const act = useAction();
  return (
    <Panel title={WI.title} span="1 / -1">
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
        {WI.intro}
      </p>
      <View
        of={plan}
        empty={(p) => p.items.filter((i) => i.type === "story").length === 0}
        emptyText={WI.empty}
      >
        {(p) => {
          const todo = p.items.filter((i) => i.action === "create" || i.action === "update");
          return (
            <div className="stack" style={{ gap: 8 }}>
              <p className="work-why" style={{ margin: 0 }}>
                {p.tracker === "none" ? WI.none : p.tracker === "manual" ? WI.manual : WI.live}
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
                {p.items.map((i) => (
                  <li
                    key={i.key}
                    className="row"
                    style={{ gap: 8, flexWrap: "wrap", paddingLeft: i.type === "task" ? 18 : 0 }}
                  >
                    <span style={{ fontSize: 13 }}>
                      {i.type === "story"
                        ? WI.story(i.title)
                        : i.type === "task"
                          ? WI.task(i.title)
                          : WI.feature(i.title)}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {workItemState(i)}
                    </span>
                    {i.step && i.action === "unchanged" && (
                      <a href={`#/todo?change=${encodeURIComponent(change)}`}>{WI.openStep}</a>
                    )}
                  </li>
                ))}
              </ul>
              {p.tracker !== "none" && todo.length > 0 && (
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(
                        async () => {
                          const c =
                            p.tracker === "live" ? await confirmed("work-items", change) : {};
                          const r = await api<Api.WorkItemSyncResultT>(
                            `/api/changes/${encodeURIComponent(change)}/work-items`,
                            { method: "POST", body: c },
                          );
                          plan.reload();
                          return r;
                        },
                        (r) => r.lines.join(" "),
                      )
                    }
                  >
                    {act.busy
                      ? WI.pushing
                      : todo.some((i) => i.action === "update")
                        ? WI.update
                        : p.tracker === "live"
                          ? WI.pushLive
                          : WI.push}
                  </button>
                </div>
              )}
              <Note note={act.note} />
            </div>
          );
        }}
      </View>
    </Panel>
  );
}
