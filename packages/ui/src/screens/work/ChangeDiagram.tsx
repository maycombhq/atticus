import { useMemo } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { ArchitectureCanvas } from "../architecture/Canvas.js";
import type { CanvasGraph } from "../architecture/model.js";
import { queryParam } from "../know/common.js";
import { targetHref } from "../flows/Flows.js";
import { CopyButton } from "../run/shared.js";
import type { ChangeRow } from "./next.js";
import { Command } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";

/**
 * The Change diagram (ADR 0108): what a change touches, from its target flows, each part marked
 * + new, ◇ changed or ✕ retired. The picture, a table of the same parts and lines for keyboards
 * and screen readers, and the same picture as Mermaid to paste anywhere. It reads; it runs
 * nothing.
 */

const D = COPY.changeDiagram;

/** The canvas's boxes and links for a change's picture: groups hold their parts. */
export function diagramGraph(m: Api.ChangeMapT): CanvasGraph {
  const used = new Set(m.nodes.map((n) => n.group).filter(Boolean));
  return {
    boxes: [
      ...m.groups
        .filter((g) => used.has(g.id))
        .map((g) => ({
          id: g.id,
          label: g.label,
          kind: g.kind,
          gaps: [],
          childCount: 0,
          outside: false,
          group: true,
          inside: 0,
        })),
      ...m.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        kind: n.kind,
        gaps: [],
        childCount: 0,
        outside: false,
        group: false,
        inside: 0,
        ...(n.group ? { parent: n.group } : {}),
        ...(n.legend ? { mark: n.legend } : {}),
      })),
    ],
    links: m.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      type: "change",
      count: 1,
      label: e.label,
      async: e.async,
      gaps: [],
      ...(e.legend ? { mark: e.legend } : {}),
    })),
  };
}

const markOf = (l: string | undefined) => D.mark[l ?? "none"] ?? D.mark.none!;

function Legend() {
  return (
    <ul className="cd-legend" aria-label={D.legend}>
      <li className="cd-key m-new">{D.legendNew}</li>
      <li className="cd-key m-modify">{D.legendModify}</li>
      <li className="cd-key m-retire">{D.legendRetire}</li>
      <li className="cd-key">{D.legendContext}</li>
    </ul>
  );
}

/** One change's picture, its parts and lines as tables, and its Mermaid. */
export function ChangeDiagramView({ map }: { map: Api.ChangeMapT }) {
  const graph = useMemo(() => diagramGraph(map), [map]);
  const groupOf = new Map(map.groups.map((g) => [g.id, g.label]));
  const label = new Map(map.nodes.map((n) => [n.id, n.label]));
  if (!map.flows)
    return (
      <>
        <p>{D.noTargets(map.change)}</p>
        <Command text={`atticus change architecture ${map.change}`} label={COPY.runNext.copy} />
      </>
    );
  return (
    <>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {D.from(map.flows, map.source)} <a href={targetHref(map.change)}>{D.flows(map.change)}</a>
      </p>
      <Legend />
      <div className="cd-canvas">
        <ArchitectureCanvas
          graph={graph}
          direction="RIGHT"
          pinned={{}}
          tidy={0}
          onSelect={() => undefined}
          onToggle={() => undefined}
          onMoved={() => undefined}
          onLaid={() => undefined}
          height={460}
        />
      </div>
      {map.problems.length > 0 && (
        <div role="note" className="cd-problems">
          <h3 className="hud">{D.problems}</h3>
          <ul>
            {map.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <h3 className="hud">{D.parts}</h3>
      <table className="run-table">
        <caption className="sr">{D.caption(map.change)}</caption>
        <thead>
          <tr>
            <th scope="col">{D.col.part}</th>
            <th scope="col">{D.col.kind}</th>
            <th scope="col">{D.col.in}</th>
            <th scope="col">{D.col.mark}</th>
          </tr>
        </thead>
        <tbody>
          {map.nodes.map((n) => (
            <tr key={n.id} className={n.legend ? `m-${n.legend}` : ""}>
              <td className="mono">{n.id}</td>
              <td>{n.kind}</td>
              <td>{n.group ? (groupOf.get(n.group) ?? n.group) : ""}</td>
              <td>{markOf(n.legend)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="hud">{D.lines}</h3>
      <table className="run-table">
        <thead>
          <tr>
            <th scope="col">{D.col.from}</th>
            <th scope="col">{D.col.what}</th>
            <th scope="col">{D.col.to}</th>
            <th scope="col">{D.col.mark}</th>
          </tr>
        </thead>
        <tbody>
          {map.edges.map((e) => (
            <tr key={e.id} className={e.legend ? `m-${e.legend}` : ""}>
              <td className="mono">{label.get(e.from) ?? e.from}</td>
              <td className="mono">{e.label}</td>
              <td className="mono">{label.get(e.to) ?? e.to}</td>
              <td>{markOf(e.legend)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="hud">{D.mermaid}</h3>
      <p className="muted">{D.mermaidHint}</p>
      <div className="cd-mermaid">
        <pre tabIndex={0} aria-label={D.mermaid}>
          {map.mermaid}
        </pre>
        <CopyButton text={map.mermaid} label={D.copyMermaid} />
      </div>
    </>
  );
}

/** #/change-diagram?change=<id>: the picker, then the picture. */
export function ChangeDiagram({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const asked = queryParam(hash, "change");
  const current = asked ?? (list.state === "ready" ? list.data[0]?.id : undefined) ?? undefined;
  const map = useApi<Api.ChangeMapT>(
    current ? `/api/changes/${encodeURIComponent(current)}/map` : undefined,
  );
  useLiveEvents(() => map.reload());
  return (
    <Panel title={D.title}>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {D.intro}
      </p>
      <View of={list} empty={(l) => l.length === 0} emptyText={D.none}>
        {(l) => (
          <>
            <ChangePicker list={l} current={current} screen="change-diagram" />
            {current && <View of={map}>{(m) => <ChangeDiagramView map={m} />}</View>}
          </>
        )}
      </View>
    </Panel>
  );
}
