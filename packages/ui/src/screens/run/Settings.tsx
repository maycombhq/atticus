import { api, useApi, type Loaded } from "../../api/client.js";
import { useMe } from "../../app/me.js";
import { Panel, View } from "../../app/ui.js";
import { Facts, Note, useAction } from "./shared.js";

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
    approvers: string[];
    minApprovals: number;
    checklists: string[];
    checks: string[];
    maxAuthorRounds: number;
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
    name: "Hand-off",
    what: "Your own assistant (Copilot or Claude Code) does the work. Atticus builds the context pack, watches the branch, then checks the result.",
  },
  {
    id: "model",
    name: "Model",
    what: "Direct model access through an approved gateway. Unlocks draft-and-PR runs and model comparisons.",
  },
  {
    id: "headless-claude-code",
    name: "Headless Claude Code",
    what: "Claude Code runs a task on its own in the change's worktree; a person still approves every write.",
  },
];

const KIND_LABEL: Record<string, string> = {
  workTracker: "Work tracker",
  serviceDesk: "Service desk",
  gitHost: "Git host",
  wiki: "Wiki",
  notify: "Notifications",
  design: "Design tool",
  model: "Model provider",
};
const MODE_CHIP: Record<string, { cls: string; label: string; what: string }> = {
  live: {
    cls: "done",
    label: "CONNECTED",
    what: "live; falls back to steps for a person when it can't be reached",
  },
  manual: {
    cls: "warn",
    label: "MANUAL",
    what: "writes become steps in To-do; reads come from exports",
  },
  mock: { cls: "dim", label: "MOCK", what: "in-memory, for tests and demos" },
  "not-set": { cls: "dim", label: "NOT SET", what: "not configured" },
};

const AI_MODE: Record<string, { label: string; what: string }> = {
  on: { label: "ON", what: "Every AI step may run, in the modes allowed below." },
  "text-only": {
    label: "TEXT ONLY",
    what: "No AI step is given a picture; pictures go to a person in Intake.",
  },
  off: {
    label: "OFF",
    what: "No AI step runs. People write what agents would draft, the rule checks review it, and no gate waits for an AI lens.",
  },
};

export function Settings() {
  const s = useApi<Settings>("/api/settings");
  const ai = useMe().me?.ai ?? "on";
  const check = useAction();
  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          Settings
        </p>
        <span className="hud">Read-only · set by the org pack, changed by PR</span>
      </div>

      <div className="bento">
        <Panel title="Runtime modes" meta="runtime.yaml" span="span 7">
          <View of={s}>
            {(d) => (
              <div className="stack" style={{ gap: 10 }}>
                <div className="list-row" style={{ alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2 }}>
                    <span style={{ fontSize: 13 }}>AI in this organisation</span>
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
                        {active ? "DEFAULT" : allowed ? "ALLOWED" : "NOT APPROVED"}
                      </span>
                    </div>
                  );
                })}
                <div className="run-safety" role="note">
                  <strong style={{ color: "var(--green)" }}>Safety, in every mode:</strong> a person
                  approves every write, AI never pushes to protected branches or deploys, scans
                  never call the network or a model, and ingested content is data, never
                  instructions. These rules can't be configured.
                </div>
                <Facts
                  rows={[
                    [
                      "Assistants",
                      `${d.runtime.assistants.allowed.join(", ")} (default ${d.runtime.assistants.default})`,
                    ],
                    ["Editors", d.runtime.editors.join(", ")],
                    ["Models", d.runtime.models.allowed.join(", ") || "none approved"],
                    [
                      "Autonomy",
                      `${d.runtime.autonomy.default} by default; at most ${d.runtime.autonomy.maxFixRounds} build-fix rounds${
                        Object.keys(d.runtime.autonomy.capPerRepo).length
                          ? `; capped: ${Object.entries(d.runtime.autonomy.capPerRepo)
                              .map(([r, a]) => `${r} ${a}`)
                              .join(", ")}`
                          : ""
                      }`,
                    ],
                    [
                      "Context budget",
                      `${d.runtime.budgets.defaultTokens.toLocaleString()} tokens per pack`,
                    ],
                    [
                      "Run records",
                      `kept ${d.runtime.retention.runsDays} days in .runs/ (git-ignored)`,
                    ],
                    ["Build engine", d.runtime.buildEngine.default],
                    ["Telemetry", d.runtime.telemetry.enabled ? "on" : "off"],
                  ]}
                />
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Adapters" span="span 5">
          <View of={s}>
            {(d) => (
              <div className="stack">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  Every outside system sits behind an adapter. When one can't be reached, a manual
                  adapter turns writes into steps a person does.
                </p>
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>System</th>
                      <th>Adapter</th>
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
                  Tests always use the mock. Atticus never connects to live databases, consoles or
                  monitoring.
                </p>
              </div>
            )}
          </View>
        </Panel>

        <ExecutorsPanel s={s} check={check} />

        <Panel title="Org pack" span="span 5">
          <View of={s}>
            {(d) => (
              <div className="stack">
                <Facts
                  rows={[
                    ["Platforms", d.orgPack.platforms.join(", ") || "none"],
                    ...Object.entries(d.orgPack.counts).map(
                      ([k, v]) =>
                        [k.replace(/([A-Z])/g, " $1").toLowerCase(), String(v)] as [string, string],
                    ),
                  ]}
                />
                {d.orgPack.defaulted.length > 0 && (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    Built-in defaults for: {d.orgPack.defaulted.join(", ")}.
                  </p>
                )}
                {d.orgPack.problems.map((p) => (
                  <p key={`${p.file}${p.path}${p.message}`} className="run-note bad">
                    {p.file}
                    {p.path ? ` ${p.path}` : ""}: {p.message}
                  </p>
                ))}
                <a href="#/orgpack" style={{ fontSize: 12.5 }}>
                  Open the org pack
                </a>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Gates" meta="gates.yaml" span="span 12">
          <View of={s} empty={(d) => d.gates.length === 0} emptyText="No gates.">
            {(d) => (
              <div className="stack">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  The critic runs at every gate; the org pack can add checks, never remove lenses.
                  Constitution rules can't be waived.
                </p>
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>Gate</th>
                      <th>Phase</th>
                      <th>Approvers</th>
                      <th>Checklists</th>
                      <th>Checks</th>
                      <th>Author rounds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.gates.map((g) => (
                      <tr key={g.id}>
                        <td className="mono">{g.id}</td>
                        <td>{g.phase}</td>
                        <td>
                          {g.minApprovals} of {g.approvers.join(", ")}
                        </td>
                        <td>{g.checklists.join(", ") || "-"}</td>
                        <td>{g.checks.join(", ") || "-"}</td>
                        <td>{g.maxAuthorRounds}</td>
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
      title="Executors allow-list"
      meta={s.state === "ready" ? `${s.data.executors.configured.length} set up` : undefined}
      span="span 7"
    >
      <View of={s}>
        {(d) => (
          <div className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Procedures call local automation tools through one step spec. A tool the org pack
              doesn't allow doesn't run, and no credentials are passed to a tool. Tools are set up
              per machine in .atticus/executors.yaml.
            </p>
            {d.executors.configured.length === 0 ? (
              <p className="state">No tools are set up on this machine.</p>
            ) : (
              <table className="run-table">
                <thead>
                  <tr>
                    <th>Executor</th>
                    <th>Kind</th>
                    <th>Allowed for</th>
                    <th>Approval</th>
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
                          <span className="chip dim">NOTHING (OFF)</span>
                        )}
                      </td>
                      <td>each write</td>
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
                Procedure {m.procedure} allows {m.executor}, which isn't set up here.
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
                Check they answer
              </button>
            </div>
            <Note note={check.note} />
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Adding a tool to the allow-list is an org-pack PR that its owners review.
            </p>
          </div>
        )}
      </View>
    </Panel>
  );
}
