import type { ReactNode } from "react";
import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { View } from "../../app/ui.js";
import { queryParam } from "../know/common.js";
import { RunsLink } from "../runs/Runs.js";
import { ChangeKnowledgePanel } from "./Knowledge.js";
import { pickChange, type ChangeRow } from "./next.js";
import { NoChangeYet, PickAChange } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";
import "./work.css";

/**
 * Change › Knowledge (2026-10-27): the knowledge attached to a change, on a page of its own beside
 * Feature design. It was only at the foot of the Feature page, where the product owner couldn't
 * find it. Every page attached to the change, ranked, with its source and authority, the tasks
 * that picked it, the near-misses and the pages that disagree; a person confirms or excludes each.
 */

/** The page from loaded data, so tests can render every state; `panel` draws the change's knowledge. */
export function ChangeKnowledgePageView(p: {
  list: Loaded<ChangeRow[]> & { reload?: () => void };
  wanted: string | undefined;
  panel: (change: string) => ReactNode;
}) {
  return (
    <View of={p.list} empty={(l) => l.length === 0} emptyContent={<NoChangeYet />}>
      {(list) => {
        const c = pickChange(list, p.wanted);
        if (!c) return <PickAChange />;
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
                <ChangePicker list={list} current={c.id} screen="change-knowledge" />
              </div>
            </div>
            <div className="bento">{p.panel(c.id)}</div>
          </>
        );
      }}
    </View>
  );
}

/** #/change-knowledge?change=<id>. */
export function ChangeKnowledgePage({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  return (
    <ChangeKnowledgePageView
      list={list}
      wanted={queryParam(hash, "change")}
      panel={(c) => <ChangeKnowledgePanel change={c} />}
    />
  );
}
