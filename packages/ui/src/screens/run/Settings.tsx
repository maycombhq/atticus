import { useState } from "react";
import { api, useApi, type Loaded } from "../../api/client.js";
import { useMe } from "../../app/me.js";
import { CheckAgain, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Facts, Note, useAction } from "./shared.js";

const T = COPY.settings;

interface Settings {
  runtime: {
    assistants: { allowed: string[]; default: string };
    editors: string[];
    modes: { allowed: string[]; default: string };
    models: { allowed: string[]; recommended: Record<string, string> };
    autonomy: { default: string; capPerRepo: Record<string, string>; maxFixRounds: number };
    budgets: { defaultTokens: number; perAgent: Record<string, number> };
    retention: { runsDays: number };
    telemetry: { enabled: boolean };
    buildEngine: { default: string; perRepo: Record<string, string> };
  };
  adapters: { kind: string; type: string | null; mode: "live" | "manual" | "mock" | "not-set" }[];
  executors: {
    configured: {
      name: string;
      transport: string;
      where?: string;
      fillOnly: boolean;
      covers: string[];
      allowedFor: string[];
    }[];
    missing: { procedure: string; executor: string }[];
    problems: string[];
  };
  orgPack: {
    platforms: string[];
    pack?: { name?: string; version?: string };
    counts: Record<string, number>;
    defaulted: string[];
    problems: { file: string; path: string; message: string }[];
  };
  gates: {
    id: string;
    phase: string;
    checklists: string[];
    checks: string[];
    /** null: no round limit (ADR 0087). */
    maxAuthorRounds: number | null;
  }[];
}
interface Check {
  executors: {
    name: string;
    reachable: boolean;
    version?: string;
    covers: string[];
    problem?: string;
  }[];
  problems: string[];
}

const MODES: { id: string; name: string; what: string }[] = [
  {
    id: "hand-off",
    name: T.handOff,
    what: T.yourOwnAssistantCopilot,
  },
  {
    id: "model",
    name: T.model,
    what: T.directModelAccessThrough,
  },
  {
    id: "headless-claude-code",
    name: T.headlessClaudeCode,
    what: T.claudeCodeRunsA,
  },
];

const KIND_LABEL: Record<string, string> = {
  workTracker: T.workTracker,
  serviceDesk: T.serviceDesk,
  gitHost: T.gitHost,
  wiki: T.wiki,
  notify: T.notifications,
  design: T.designTool,
  model: T.modelProvider,
};
const MODE_CHIP: Record<string, { cls: string; label: string; what: string }> = {
  live: {
    cls: "done",
    label: "CONNECTED",
    what: T.liveFallsBackTo,
  },
  manual: {
    cls: "warn",
    label: "MANUAL",
    what: T.writesBecomeStepsIn,
  },
  mock: { cls: "dim", label: "MOCK", what: T.inMemoryForTests },
  "not-set": { cls: "dim", label: T.notSet, what: T.notConfigured },
};

const AI_MODE: Record<string, { label: string; what: string }> = {
  on: { label: "ON", what: T.everyAiStepMay },
  "text-only": {
    label: T.textOnly,
    what: T.noAiStepIs,
  },
  off: {
    label: "OFF",
    what: T.noAiStepRuns,
  },
};

interface Doctor {
  checks: {
    id: string;
    label: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    fix?: string;
  }[];
  ok: boolean;
}

/** What this machine needs (atticus doctor, ADR 0049): each check with its fix. */
function MachinePanel() {
  const [fresh, setFresh] = useState(0);
  const d = useApi<Doctor>(`/api/doctor${fresh ? `?fresh=1&n=${fresh}` : ""}`);
  const chip = { ok: "done", warn: "warn", fail: "blocking" } as const;
  return (
    <Panel
      title={T.thisMachine}
      meta={d.state === "ready" ? (d.data.ok ? T.ready : T.needsFixing) : undefined}
      span="span 12"
    >
      <View of={d} empty={(x) => x.checks.length === 0} emptyText={T.noChecksRan}>
        {(x) => (
          <div className="stack" style={{ gap: 6 }}>
            {x.checks.map((c) => (
              <div key={c.id} className="row between" style={{ alignItems: "flex-start", gap: 10 }}>
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5 }}>
                    {c.label} <span className="muted">· {c.detail}</span>
                  </span>
                  {c.status !== "ok" && c.fix && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {c.fix}
                    </span>
                  )}
                </span>
                <span className={`chip ${chip[c.status]}`}>{c.status.toUpperCase()}</span>
              </div>
            ))}
            <div className="row" style={{ gap: 8 }}>
              <CheckAgain of={d} label={T.checkAgain} run={() => setFresh(fresh + 1)} />
              <span className="muted" style={{ fontSize: 12 }}>
                {T.theSameChecksAs}
                <code className="mono">{T.atticusDoctor}</code>
                {T.nothingLeavesThisMachine}
              </span>
            </div>
          </div>
        )}
      </View>
    </Panel>
  );
}

/** The person's own digest settings: how often, and where it goes. Kept in .atticus/me.yaml. */
function NotifyPanel() {
  const { me, saveNotify } = useMe();
  const [digest, setDigest] = useState<string | undefined>();
  const [channel, setChannel] = useState<string | undefined>();
  const act = useAction();
  const d = digest ?? me?.notify?.digest ?? "off";
  const c = channel ?? me?.notify?.channel ?? "";
  return (
    <Panel title={T.yourNotifications} meta={T.atticusMeYaml} span="span 12">
      {!me ? (
        <div className="stack" aria-busy="true">
          <span className="sr">{T.loading}</span>
          <div className="skeleton" style={{ width: "70%" }} />
        </div>
      ) : (
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(
              () => saveNotify({ digest: d, ...(c.trim() ? { channel: c.trim() } : {}) }),
              T.saved,
            );
          }}
        >
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>
            {T.yourDigestListsThe}
            <code className="mono" style={{ whiteSpace: "nowrap" }}>
              {T.atticusDigestAsSend(me.user)}
            </code>
            .
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="stack" style={{ gap: 4 }}>
              <label htmlFor="notify-digest" className="hud" style={{ fontSize: 10 }}>
                {T.howOften}
              </label>
              <select
                id="notify-digest"
                className="field"
                value={d}
                onChange={(e) => setDigest(e.target.value)}
              >
                <option value="off">{T.off}</option>
                <option value="daily">{T.daily}</option>
                <option value="weekly">{T.weekly}</option>
              </select>
            </div>
            <div className="stack" style={{ gap: 4, flex: 1, minWidth: 180 }}>
              <label htmlFor="notify-channel" className="hud" style={{ fontSize: 10 }}>
                {T.whereItGoes}
              </label>
              <input
                id="notify-channel"
                className="field"
                value={c}
                placeholder={T.aDirectMessage(me.user)}
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
            <button type="submit" className="btn primary" disabled={act.busy}>
              {T.save}
            </button>
          </div>
          <Note note={act.note} />
        </form>
      )}
    </Panel>
  );
}

export function Settings() {
  const s = useApi<Settings>("/api/settings");
  const ai = useMe().me?.ai ?? "on";
  const check = useAction();
  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {T.settings}
        </p>
        <span className="hud">{T.readOnlySetBy}</span>
      </div>

      <div className="bento">
        <Panel title={T.runtimeModes} meta={T.runtimeYaml} span="span 7">
          <View of={s}>
            {(d) => (
              <div className="stack" style={{ gap: 10 }}>
                <div className="list-row" style={{ alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2 }}>
                    <span style={{ fontSize: 13 }}>{T.aiInThisOrganisation}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {AI_MODE[ai]!.what}
                    </span>
                  </span>
                  <span className={`chip ${ai === "on" ? "done" : "warn"}`}>
                    {AI_MODE[ai]!.label}
                  </span>
                </div>
                {MODES.map((m) => {
                  const allowed = d.runtime.modes.allowed.includes(m.id);
                  const active = d.runtime.modes.default === m.id;
                  return (
                    <div key={m.id} className="list-row" style={{ alignItems: "flex-start" }}>
                      <span className="stack" style={{ gap: 2 }}>
                        <span style={{ fontSize: 13 }}>{m.name}</span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {m.what}
                        </span>
                      </span>
                      <span className={`chip ${active ? "" : allowed ? "done" : "dim"}`}>
                        {active ? T.default : allowed ? T.allowed : T.notApproved}
                      </span>
                    </div>
                  );
                })}
                <div className="run-safety" role="note">
                  <strong style={{ color: "var(--green)" }}>{T.safetyInEveryMode}</strong>{" "}
                  {T.aPersonApprovesEvery}
                </div>
                <Facts
                  rows={[
                    [
                      T.assistants,
                      `${d.runtime.assistants.allowed.join(", ")} (default ${d.runtime.assistants.default})`,
                    ],
                    [T.editors, d.runtime.editors.join(", ")],
                    [T.models, d.runtime.models.allowed.join(", ") || T.noneApproved],
                    [
                      T.autonomy,
                      `${d.runtime.autonomy.default} by default; at most ${d.runtime.autonomy.maxFixRounds} build-fix rounds${
                        Object.keys(d.runtime.autonomy.capPerRepo).length
                          ? `; capped: ${Object.entries(d.runtime.autonomy.capPerRepo)
                              .map(([r, a]) => `${r} ${a}`)
                              .join(", ")}`
                          : ""
                      }`,
                    ],
                    [
                      T.contextBudget,
                      `${d.runtime.budgets.defaultTokens.toLocaleString()} tokens per pack`,
                    ],
                    [
                      T.runRecords,
                      `kept ${d.runtime.retention.runsDays} days in .runs/ (git-ignored)`,
                    ],
                    [T.buildEngine, d.runtime.buildEngine.default],
                    [T.telemetry, d.runtime.telemetry.enabled ? "on" : "off"],
                  ]}
                />
              </div>
            )}
          </View>
        </Panel>

        <Panel title={T.adapters} span="span 5">
          <View of={s}>
            {(d) => (
              <div className="stack">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  {T.everyOutsideSystemSits}
                </p>
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>{T.system}</th>
                      <th>{T.adapter}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.adapters.map((a) => (
                      <tr key={a.kind}>
                        <td>
                          {KIND_LABEL[a.kind] ?? a.kind}
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {MODE_CHIP[a.mode]!.what}
                          </div>
                        </td>
                        <td>
                          <span className={`chip ${MODE_CHIP[a.mode]!.cls}`}>
                            {MODE_CHIP[a.mode]!.label}
                            {a.mode === "live" ? ` · ${a.type}` : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {T.testsAlwaysUseThe}
                </p>
              </div>
            )}
          </View>
        </Panel>

        <ExecutorsPanel s={s} check={check} />

        <Panel title={T.orgPack} span="span 5">
          <View of={s}>
            {(d) => (
              <div className="stack">
                <Facts
                  rows={[
                    [T.platforms, d.orgPack.platforms.join(", ") || "none"],
                    ...Object.entries(d.orgPack.counts).map(
                      ([k, v]) =>
                        [k.replace(/([A-Z])/g, " $1").toLowerCase(), String(v)] as [string, string],
                    ),
                  ]}
                />
                {d.orgPack.defaulted.length > 0 && (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {T.builtInDefaultsFor(d.orgPack.defaulted.join(", "))}
                  </p>
                )}
                {d.orgPack.problems.map((p) => (
                  <p key={`${p.file}${p.path}${p.message}`} className="run-note bad">
                    {p.file}
                    {p.path ? ` ${p.path}` : ""}: {p.message}
                  </p>
                ))}
                <a href="#/orgpack" style={{ fontSize: 12.5 }}>
                  {T.openTheOrgPack}
                </a>
              </div>
            )}
          </View>
        </Panel>

        <MachinePanel />

        <NotifyPanel />

        <Panel title={T.gates} meta={T.gatesYaml} span="span 12">
          <View of={s} empty={(d) => d.gates.length === 0} emptyText={T.noGates}>
            {(d) => (
              <div className="stack">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  {T.theCriticRunsAt}
                </p>
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>{T.gate}</th>
                      <th>{T.phase}</th>
                      <th>{T.checklists}</th>
                      <th>{T.checks}</th>
                      <th>{T.authorRounds}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.gates.map((g) => (
                      <tr key={g.id}>
                        <td className="mono">{g.id}</td>
                        <td>{g.phase}</td>
                        <td>{g.checklists.join(", ") || "-"}</td>
                        <td>{g.checks.join(", ") || "-"}</td>
                        <td>{g.maxAuthorRounds ?? T.noLimit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </View>
        </Panel>
      </div>
    </>
  );
}

function ExecutorsPanel({
  s,
  check,
}: {
  s: Loaded<Settings>;
  check: ReturnType<typeof useAction>;
}) {
  return (
    <Panel
      title={T.executorsAllowList}
      meta={s.state === "ready" ? T.setUp(s.data.executors.configured.length) : undefined}
      span="span 7"
    >
      <View of={s}>
        {(d) => (
          <div className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              {T.proceduresCallLocalAutomation}
            </p>
            {d.executors.configured.length === 0 ? (
              <p className="state">{T.noToolsAreSet}</p>
            ) : (
              <table className="run-table">
                <thead>
                  <tr>
                    <th>{T.executor}</th>
                    <th>{T.kind}</th>
                    <th>{T.allowedFor}</th>
                    <th>{T.approval}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.executors.configured.map((x) => (
                    <tr key={x.name}>
                      <td>
                        <span className="mono">{x.name}</span>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {x.where}
                        </div>
                      </td>
                      <td>{x.transport}</td>
                      <td>
                        {x.allowedFor.length ? (
                          x.allowedFor.join(", ")
                        ) : (
                          <span className="chip dim">{T.nothingOff}</span>
                        )}
                      </td>
                      <td>{T.eachWrite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.executors.missing.map((m) => (
              <p
                key={`${m.procedure}${m.executor}`}
                className="muted"
                style={{ margin: 0, fontSize: 12 }}
              >
                {T.procedureAllowsWhichIsnt(m.procedure, m.executor)}
              </p>
            ))}
            {d.executors.problems.map((p) => (
              <p key={p} className="run-note bad">
                {p}
              </p>
            ))}
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={check.busy || d.executors.configured.length === 0}
                aria-describedby={d.executors.configured.length === 0 ? "no-executors" : undefined}
                onClick={() =>
                  void check.run(
                    () => api<Check>("/api/settings/executors/check"),
                    (r) => {
                      const c = r as Check;
                      return [
                        ...c.executors.map(
                          (x) =>
                            `${x.name}: ${x.reachable ? `answers${x.version ? ` (${x.version})` : ""}` : `doesn't answer${x.problem ? ` (${x.problem})` : ""}`}`,
                        ),
                        ...c.problems,
                      ].join("\n");
                    },
                  )
                }
              >
                {T.checkTheyAnswer}
              </button>
              {d.executors.configured.length === 0 && (
                <span id="no-executors" className="muted" style={{ fontSize: 12 }}>
                  {COPY.app.noExecutors}
                </span>
              )}
            </div>
            <Note note={check.note} />
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {T.addingAToolTo}
            </p>
          </div>
        )}
      </View>
    </Panel>
  );
}
