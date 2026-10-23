import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import type { ChangeRow } from "./next.js";
import { Command } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";

/**
 * The Estimate (ADR 0109): a change's size counted from its target flows, the org pack's ranges
 * summed, the calendar beside the release forecast's waiting, and every driver and unit with
 * where it comes from. It reads; it runs nothing, and it never shows a number nobody stands behind.
 */

const E = COPY.estimate;

/** One change's estimate. */
export function EstimateView({ e }: { e: Api.ChangeEstimateT }) {
  if (!e.units.length)
    return (
      <>
        <p>{E.noTargets(e.change)}</p>
        <Command text={`atticus change architecture ${e.change}`} label={COPY.runNext.copy} />
      </>
    );
  const classed = e.units.length - e.needsClass;
  return (
    <>
      <section aria-labelledby="est-effort" className="est-band">
        <h3 id="est-effort" className="hud">
          {E.effort}
        </h3>
        {e.effort ? (
          <p className="est-big">
            {E.effortRange(e.effort.p20, e.effort.p80, e.effort.p50)}{" "}
            <span className="muted">{E.from(classed, e.units.length)}</span>
          </p>
        ) : (
          <p className="est-big">
            {E.noDays(e.units.length)} {e.table ? E.noMatch : E.noTable}
          </p>
        )}
      </section>
      <section aria-labelledby="est-calendar" className="est-band">
        <h3 id="est-calendar" className="hud">
          {E.calendar}
        </h3>
        <p>
          {e.calendar.waitDays !== undefined ? E.waiting(e.calendar.waitDays) : E.noWait}
          {e.calendar.longer && <> {E.longer(e.calendar.longer)}</>}
        </p>
      </section>
      <section aria-labelledby="est-calibration" className="est-band">
        <h3 id="est-calibration" className="hud">
          {E.calibration}
        </h3>
        <p>{E.notCalibrated(e.calibration.source, e.table)}</p>
      </section>
      <h3 className="hud">{E.drivers}</h3>
      {e.drivers.length ? (
        <table className="run-table">
          <caption className="sr">{E.driversCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{E.col.what}</th>
              <th scope="col">{E.col.count}</th>
              <th scope="col">{E.col.effect}</th>
              <th scope="col">{E.col.source}</th>
            </tr>
          </thead>
          <tbody>
            {e.drivers.map((d) => (
              <tr key={d.id}>
                <td>{d.what}</td>
                <td>{d.count}</td>
                <td>{d.widens ? E.widens(d.widens) : ""}</td>
                <td className="mono">{d.source ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{E.noDrivers}</p>
      )}
      {e.perRepo.length > 1 && (
        <>
          <h3 className="hud">{E.perRepo}</h3>
          <table className="run-table">
            <thead>
              <tr>
                <th scope="col">{E.col.repo}</th>
                <th scope="col">{E.col.units}</th>
                <th scope="col">{E.col.days}</th>
              </tr>
            </thead>
            <tbody>
              {e.perRepo.map((r) => (
                <tr key={r.repo}>
                  <td className="mono">{r.repo}</td>
                  <td>{r.units}</td>
                  <td>{r.effort ? E.days(r.effort) : E.needsClass}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3 className="hud">{E.work}</h3>
      <table className="run-table">
        <caption className="sr">{E.workCaption(e.change)}</caption>
        <thead>
          <tr>
            <th scope="col">{E.col.repo}</th>
            <th scope="col">{E.col.flow}</th>
            <th scope="col">{E.col.step}</th>
            <th scope="col">{E.col.what}</th>
            <th scope="col">{E.col.cls}</th>
            <th scope="col">{E.col.days}</th>
          </tr>
        </thead>
        <tbody>
          {e.units.map((u, i) => (
            <tr key={`${u.flow}.${u.step ?? "flow"}.${i}`}>
              <td className="mono">{u.repo}</td>
              <td className="mono">{u.flow}</td>
              <td>{u.step ?? ""}</td>
              <td>{u.what}</td>
              <td className="mono">{u.class}</td>
              <td>{u.days ? E.days(u.days) : <strong>{E.needsClass}</strong>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.problems.length > 0 && (
        <div role="note" className="cd-problems">
          <h3 className="hud">{E.problems}</h3>
          <ul>
            {e.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** #/estimate?change=<id>: the picker, then the estimate. */
export function Estimate({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const asked = queryParam(hash, "change");
  const current = asked ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  const est = useApi<Api.ChangeEstimateT>(
    current ? `/api/changes/${encodeURIComponent(current)}/estimate` : undefined,
  );
  useLiveEvents(() => est.reload());
  return (
    <Panel title={E.title}>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {E.intro}
      </p>
      <View of={list} empty={(l) => l.length === 0} emptyText={E.none}>
        {(l) => (
          <>
            <ChangePicker list={l} current={current} screen="estimate" />
            {current && <View of={est}>{(e) => <EstimateView e={e} />}</View>}
          </>
        )}
      </View>
    </Panel>
  );
}
