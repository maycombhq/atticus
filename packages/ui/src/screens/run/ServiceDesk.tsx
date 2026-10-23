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

const T = COPY.serviceDesk;

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
  "to-file": { label: T.toFile2, cls: "warn" },
  waiting: { label: T.waitingForYou, cls: "ai" },
  filed: { label: "FILED", cls: "done" },
};
const keyOf = (r: Request) => `${r.change}|${r.heading}`;

function DraftForm({ done }: { done: () => void }) {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const [change, setChange] = useState("");
  const [force, setForce] = useState(false);
  const act = useAction();
  return (
    <View of={changes} empty={(l) => l.length === 0} emptyText={T.noChangesToDraft}>
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
              (r) => (r as { lines: string[] }).lines.join("\n") || T.drafted,
            );
          }}
        >
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="run-label" htmlFor="draft-change">
              {T.draftTheRequestsA}
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
              {T.replaceASnowMd}
            </label>
            <button type="submit" className="btn" disabled={act.busy}>
              {T.draftFromTheOrg}
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
          <span className="chip dim">{T.template(r.template)}</span>
        ) : (
          <span className="chip blocking">{T.noTemplateMatches}</span>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.approversValuesComeFrom(
          r.leadTimeDays !== undefined ? T.leadTimeDays(r.leadTimeDays) : "",
          r.approvers.join(", ") || T.noneNamed,
        )}
      </p>
      <div>
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="hud" style={{ fontSize: 10 }}>
            {T.fields}
          </span>
          <CopyButton text={all} label={T.copyAllFields} />
        </div>
        {r.fields.map((f) => (
          <div key={f.name} className="run-field">
            <span className="hud" style={{ fontSize: 10 }}>
              {f.name}
              {f.required ? T.required : ""}
            </span>
            <span className={`value ${f.value ? "" : "empty"}`}>
              {f.value || (f.required ? T.missingFillItIn : T.empty)}
            </span>
            {f.value ? <CopyButton text={f.value} label={T.copy(f.name)} /> : <span />}
          </div>
        ))}
      </div>
      {r.state === "to-file" && (
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {T.atticusNeverCallsThe}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || r.missing.length > 0}
              title={r.missing.length ? T.fillFirst(r.missing.join(", ")) : undefined}
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
                  (x) => (x as { lines: string[] }).lines.join("\n") || T.filedAsAStep,
                )
              }
            >
              {T.fileSCompleteDrafts(r.change)}
            </button>
          </div>
          {r.missing.length > 0 && (
            <p className="run-note bad">{T.fillInSnowMd(r.missing.join(", "))}</p>
          )}
        </div>
      )}
      {r.state === "waiting" && (
        <p style={{ margin: 0, fontSize: 12.5 }}>
          {T.filedAsStep}
          <span className="mono">{r.step}</span>
          {T.submitItInThe}
          <a href="#/todo">{T.recordTheRequestNumber}</a>.
        </p>
      )}
      {r.state === "filed" && (
        <p className="run-note ok">
          {T.filedAs(r.number ?? "")}
          {r.url ? (
            <>
              {" "}
              (<ExternalLink href={r.url}>{T.open}</ExternalLink>)
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
            ? T.serviceDeskQueue
            : n("to-file")
              ? T.toFile(plural(n("to-file"), "request"))
              : T.nothingToFile}
        </p>
        <Choice
          label={T.show}
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
        {T.draftsOnlyYouFile}
        <a href="#/release">{T.releasePlan}</a>.
      </p>

      <div className="bento">
        <Panel title={T.queue} span="span 4">
          <View of={q} empty={() => all.length === 0} emptyText={T.noDraftsYet}>
            {() => (
              <Donut
                title={T.requests}
                parts={[
                  { label: T.toFile3, value: n("to-file"), color: "var(--amber)" },
                  { label: T.waitingForYou2, value: n("waiting"), color: "var(--violet)" },
                  { label: T.filed, value: n("filed"), color: "var(--green)" },
                ]}
              />
            )}
          </View>
        </Panel>

        <Panel title={T.serviceDeskAdapter} span="span 4">
          <View of={q}>
            {(d) => (
              <div className="stack">
                <div className="row">
                  <AdapterChip type={d.adapter.configured} />
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  {T.writesFromTheApp}
                </p>
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  {T.inTheOrgPack(
                    d.exports.files.length
                      ? T.from(
                          plural(d.exports.requests, T.pastRequest),
                          plural(d.exports.files.length, "export"),
                        )
                      : T.noDeskExportLoaded,
                    plural(d.templates.length, T.requestTemplate),
                  )}
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title={T.localAutomationTool} span="span 4">
          <View of={q}>
            {(d) => (
              <div className="stack">
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {d.executors.length ? (
                    d.executors.map((x) => (
                      <span key={x} className="chip ai">
                        {T.approveEachWrite(x)}
                      </span>
                    ))
                  ) : (
                    <span className="chip dim">{T.noneAllowedHere}</span>
                  )}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  {T.calledThroughTheCommon}
                  <a href="#/todo">{T.toDo}</a>
                  {T.noCredentialsPassTo}
                  <a href="#/settings">{T.executorsAllowList}</a>
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title={T.requests} meta={shown.length} span="span 4" rows="span 2">
          <View
            of={q}
            empty={() => shown.length === 0}
            emptyText={all.length ? T.noneInThisView : T.noServiceDeskDrafts}
          >
            {() => (
              <nav aria-label={T.requests} className="stack" style={{ gap: 2 }}>
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
                            {r.missing.length ? T.toFill(r.missing.length) : ""}
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

        <Panel title={selected ? selected.heading : T.noRequestSelected} span="span 8" kind="hero">
          <View of={q} empty={() => !selected} emptyText={T.pickARequestOn}>
            {() => <RequestDetail key={keyOf(selected!)} r={selected!} done={() => q.reload()} />}
          </View>
        </Panel>

        <Panel title={T.draftRequests} span="span 8">
          <DraftForm done={() => q.reload()} />
        </Panel>
      </div>
    </>
  );
}
