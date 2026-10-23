import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, setQueryParam, Table } from "../know/common.js";
import { Architecture } from "../architecture/Architecture.js";
import { NeedsPanel } from "../knowledge/Needs.js";
import {
  architectureStep,
  pickChange,
  stageOf,
  STAGE_SCREEN,
  stageStep,
  taskStep,
  type ChangeRow,
  type Stage,
  type TaskRow,
} from "./next.js";
import { Command, NoChangeYet, RunNextPanel } from "./RunNext.js";
import { RunsLink } from "../runs/Runs.js";

/**
 * Feature design, Stories and Tasks (plan 4.5): for now each shows the change's files and the
 * command for its stage, from the same calls the Changes, Breakdown and Task board pages make
 * (/api/changes, /api/changes/<id>, /api/changes/<id>/tasks).
 */

const W = COPY.work;
const R = COPY.runNext;

export interface ArtifactRow {
  artifact: string;
  path: string;
  status: string;
  openFindings: number;
}
export interface ChangeDetailView extends ChangeRow {
  artifacts: ArtifactRow[];
}

/** Which of a change's files each stage works on. */
const STAGE_FILES: Record<"feature" | "stories" | "tasks", string[]> = {
  feature: ["brief", "proposal", "specs", "interfaces", "ux"],
  stories: ["stories", "tasks", "snow"],
  tasks: ["tasks"],
};

export function ChangePicker(p: {
  list: ChangeRow[];
  current: string | undefined;
  screen: string;
}) {
  const id = `pick-${p.screen}`;
  return (
    <div className="row" style={{ gap: 8 }}>
      <label htmlFor={id} className="hud" style={{ fontSize: 10 }}>
        {W.pickChange}
      </label>
      <select
        id={id}
        className="run-select"
        value={p.current ?? ""}
        onChange={(e) => setQueryParam(p.screen, "change", e.target.value)}
      >
        {p.list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} · {c.state}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FilesTable({
  detail,
  stage,
}: {
  detail: ChangeDetailView;
  stage: "feature" | "stories" | "tasks";
}) {
  const wanted = STAGE_FILES[stage];
  const rows = detail.artifacts.filter((a) => wanted.includes(a.artifact));
  if (rows.length === 0) return <div className="state">{W.noFiles}</div>;
  return (
    <Table
      caption={W.files}
      rows={rows}
      rowKey={(a) => a.artifact}
      cols={[
        { label: W.fileCol, cell: (a) => a.path, mono: true },
        {
          label: W.statusCol,
          cell: (a) => (
            <span
              className={`chip ${a.status === "done" ? "done" : a.status === "ready" ? "warn" : "dim"}`}
            >
              {a.status.toUpperCase()}
            </span>
          ),
        },
      ]}
    />
  );
}

export function TaskList({ change, tasks }: { change: string; tasks: TaskRow[] }) {
  if (tasks.length === 0)
    return <div className="state">{W.noTasks.replace("<change>", change)}</div>;
  return (
    <Table
      caption={W.tasks}
      rows={tasks}
      rowKey={(t) => `${t.repo}:${t.id}`}
      cols={[
        {
          label: W.taskCol,
          cell: (t) => (
            <>
              <code className="mono">{t.id}</code> {t.description}
            </>
          ),
        },
        { label: W.repoTaskCol, cell: (t) => t.repo, mono: true },
        {
          label: W.statusCol,
          cell: (t) => (
            <span className={`chip ${t.done ? "done" : "dim"}`}>
              {t.done ? W.taskDone : W.taskOpen}
            </span>
          ),
        },
        {
          label: W.runCol,
          cell: (t) => {
            const s = taskStep(change, t);
            return (
              <div className="stack" style={{ gap: 4 }}>
                <Command text={s.command} label={R.copy} />
                <Command text={s.slash!.command} label={R.copySlash} />
              </div>
            );
          },
        },
      ]}
    />
  );
}

/** One stage page from loaded data, so tests can render every state. */
export function StagePage(p: {
  stage: "feature" | "stories" | "tasks";
  list: Loaded<ChangeRow[]>;
  wanted?: string | undefined;
  detail: Loaded<ChangeDetailView> | undefined;
  tasks: Loaded<TaskRow[]> | undefined;
}) {
  const screen = STAGE_SCREEN[p.stage]!.id;
  return (
    <View of={p.list} empty={(l) => l.length === 0} emptyContent={<NoChangeYet />}>
      {(list) => {
        const c = pickChange(list, p.wanted, p.stage as Stage);
        if (!c) return <NoChangeYet />;
        const ready = p.tasks?.state === "ready" ? p.tasks.data : undefined;
        return (
          <>
            <div className="row between" style={{ flexWrap: "wrap", marginBottom: 12 }}>
              <p style={{ margin: 0 }}>
                <span className="n" style={{ fontSize: 20 }}>
                  {c.title}
                </span>
              </p>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <RunsLink change={c.id} />
                {p.stage === "tasks" && (
                  <a href={`#/conformance?change=${encodeURIComponent(c.id)}`}>
                    {COPY.conformance.title}
                  </a>
                )}
                <ChangePicker list={list} current={c.id} screen={screen} />
              </div>
            </div>
            {p.stage === "tasks" && p.tasks?.state === "loading" ? (
              <View of={p.tasks}>{() => null}</View>
            ) : (
              <RunNextPanel step={stageStep(p.stage, c, ready)} />
            )}
            <div className="bento">
              <Panel title={W.files} span={p.stage === "tasks" ? "span 4" : "1 / -1"}>
                {p.detail ? (
                  <View of={p.detail}>{(d) => <FilesTable detail={d} stage={p.stage} />}</View>
                ) : (
                  <div className="state">{W.noFiles}</div>
                )}
              </Panel>
              {p.stage === "tasks" && (
                <Panel title={W.tasks} span="span 8">
                  {p.tasks ? (
                    <View of={p.tasks}>{(t) => <TaskList change={c.id} tasks={t} />}</View>
                  ) : (
                    <div className="state">{W.noTasks.replace("<change>", c.id)}</div>
                  )}
                </Panel>
              )}
              {/* ADR 0102: what the change needs from the organisation. */}
              <NeedsPanel change={c.id} />
            </div>
          </>
        );
      }}
    </View>
  );
}

function useStage(hash: string, stage: "feature" | "stories" | "tasks") {
  const list = useApi<ChangeRow[]>("/api/changes");
  const wanted = queryParam(hash, "change");
  const c = list.state === "ready" ? pickChange(list.data, wanted, stage) : undefined;
  const detail = useApi<ChangeDetailView>(c ? `/api/changes/${c.id}` : undefined);
  const tasks = useApi<TaskRow[]>(
    c && stage === "tasks" ? `/api/changes/${c.id}/tasks` : undefined,
  );
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      list.reload();
      detail.reload();
      tasks.reload();
    }
  });
  return (
    <StagePage
      stage={stage}
      list={list}
      wanted={wanted}
      detail={c ? detail : undefined}
      tasks={c && stage === "tasks" ? tasks : undefined}
    />
  );
}

export function FeatureDesign({ hash }: { hash: string }) {
  return useStage(hash, "feature");
}
export function Stories({ hash }: { hash: string }) {
  return useStage(hash, "stories");
}
export function TaskListScreen({ hash }: { hash: string }) {
  return useStage(hash, "tasks");
}

/** The Architecture screen: Run next for a change at the design stage, then the workspace. */
export function ArchitectureStep({ list }: { list: Loaded<ChangeRow[]> }) {
  return (
    <>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {W.architectureIntro}
      </p>
      <View of={list}>
        {(l) => (
          <>
            <RunNextPanel step={architectureStep(l)} />
            <p className="work-say" style={{ margin: "0 0 8px" }}>
              <RunsLink
                {...(l.find((c) => stageOf(c.state) === "architecture")
                  ? { change: l.find((c) => stageOf(c.state) === "architecture")!.id }
                  : {})}
              />
            </p>
            {l.length > 0 && (
              <p className="row" style={{ gap: 12, flexWrap: "wrap", margin: "8px 0 0" }}>
                {l.map((c) => (
                  <span key={c.id} className="row" style={{ gap: 12 }}>
                    <a href={`#/flows?change=${encodeURIComponent(c.id)}`}>
                      {COPY.flows.openTargets}: {c.title}
                    </a>
                    <a href={`#/change-diagram?change=${encodeURIComponent(c.id)}`}>
                      {COPY.changeDiagram.title}: {c.title}
                    </a>
                    <a href={`#/estimate?change=${encodeURIComponent(c.id)}`}>
                      {COPY.estimate.title}: {c.title}
                    </a>
                  </span>
                ))}
              </p>
            )}
          </>
        )}
      </View>
    </>
  );
}

export function ArchitecturePage({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  return (
    <>
      <ArchitectureStep list={list} />
      <Architecture hash={hash} />
    </>
  );
}
