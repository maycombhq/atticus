import { useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, useView } from "./common.js";
import { SystemGuide } from "./Know.js";

/**
 * A system's page (WP7.7, Estate › Systems): one place a new joiner or a reviewer reads about a
 * system. Its guide, generated from the catalog with every fact citing code and what it doesn't
 * know yet; the open questions about it; and the changes in flight in its repos. The ecosystem
 * map links here. It reads; it changes nothing.
 */

const Y = COPY.systems;

interface SystemRecord {
  id: string;
  name?: string;
  repos?: string[];
  boundary?: string;
}
interface ChangeRow {
  id: string;
  title: string;
  state: string;
  repos: string[];
}

/** The changes in flight in a system's repos, newest work first by title. */
export function changesIn(system: SystemRecord, changes: ChangeRow[]): ChangeRow[] {
  const repos = new Set(system.repos ?? []);
  return changes
    .filter((c) => !["released", "archived"].includes(c.state))
    .filter((c) => c.repos.some((r) => repos.has(r)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export const systemHash = (id: string) => `#/systems?system=${encodeURIComponent(id)}`;

export function SystemPicker(p: { systems: SystemRecord[]; current: string | undefined }) {
  return (
    <nav aria-label={Y.pick}>
      <ul
        className="row"
        style={{ gap: 6, flexWrap: "wrap", listStyle: "none", padding: 0, margin: 0 }}
      >
        {p.systems.map((s) => (
          <li key={s.id}>
            <a
              className="chip"
              href={systemHash(s.id)}
              aria-current={s.id === p.current ? "page" : undefined}
            >
              {s.name ?? s.id}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Systems({ hash }: { hash: string }) {
  const list = useApi<{ items: SystemRecord[] }>("/api/catalog/System?limit=500");
  const changes = useApi<ChangeRow[]>("/api/changes");
  const questions = useView<{ questions?: { id: string; system?: string; question: string }[] }>(
    "questions",
  );
  useReloadOnFiles(list, changes, questions);
  const asked = queryParam(hash, "system");
  const systems = list.state === "ready" ? list.data.items : [];
  const current = asked ?? systems[0]?.id;
  const system = systems.find((s) => s.id === current);
  const open =
    questions.state === "ready"
      ? (questions.data.questions ?? []).filter((q) => q.system === current)
      : [];
  return (
    <div className="bento">
      <Panel title={Y.title} span="1 / -1">
        <View of={list} empty={(d) => d.items.length === 0} emptyText={Y.empty}>
          {() => <SystemPicker systems={systems} current={current} />}
        </View>
      </Panel>
      {current && <SystemGuide system={current} />}
      {system && (
        <Panel title={Y.inFlight} span="span 6">
          {changes.state !== "ready" ? (
            <View of={changes}>{() => null}</View>
          ) : changesIn(system, changes.data).length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {Y.noChanges}
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {changesIn(system, changes.data).map((c) => (
                <li key={c.id}>
                  <a href={`#/cockpit?change=${encodeURIComponent(c.id)}`}>{c.title}</a>
                  <span className="muted">{` · ${c.state}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {system && (
        <Panel title={Y.questions} span="span 6">
          {open.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {Y.noQuestions}
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {open.map((q) => (
                <li key={q.id}>{q.question}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
