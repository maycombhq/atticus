import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";

/**
 * Map › Mismatches (plan item F7, ADR 0164): the contract check on every link, estate-wide. Each
 * link with a finding, and under it each mismatch (or a difference a mapping nobody traced
 * leaves unconfirmed) with what each side says and its line, and the mappings it went through.
 * `GET /api/contracts` reads files only; the app runs nothing.
 */

const M = COPY.mismatches;
type View_ = Api.ContractsViewT;
type Finding = Api.ContractMismatchViewT;
const FILTERS = ["all", "mismatch", "unconfirmed"] as const;

const endText = (e: Finding["sender"]) =>
  [e.what, e.value ? `: ${e.value}` : "", e.at ? ` (${e.at})` : ""].join("");

function LinkFindings({ link, list }: { link: Api.ContractLinkViewT; list: readonly Finding[] }) {
  const id = useId();
  const what = [link.method, link.path].filter(Boolean).join(" ");
  const to = link.entry?.repo ?? link.system ?? "";
  const title = M.link(link.call.repo, what, to, link.through.join(", "));
  return (
    <section className="stack" style={{ gap: 4 }} aria-labelledby={id}>
      <h3 className="hud" id={id} style={{ margin: 0 }}>
        <code className="mono">{title}</code>
      </h3>
      {link.specs.length > 0 && <p className="work-say">{M.specs(link.specs.join(", "))}</p>}
      <table className="run-table">
        <caption className="sr">{title}</caption>
        <thead>
          <tr>
            <th scope="col">{M.cols.kind}</th>
            <th scope="col">{M.cols.says}</th>
            <th scope="col">{M.cols.sender}</th>
            <th scope="col">{M.cols.receiver}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.id}>
              <td>
                <span className={`chip ${f.status === "mismatch" ? "warn" : ""}`}>
                  {f.status === "mismatch" && <span aria-hidden="true">⚠ </span>}
                  {M.status[f.status]}
                </span>{" "}
                {M.kinds[f.kind] ?? f.kind}
              </td>
              <td>
                {f.message}
                {f.via?.length ? <div className="work-say">{M.via(f.via.join(", "))}</div> : null}
              </td>
              <td>
                <code className="mono">{endText(f.sender)}</code>
              </td>
              <td>
                <code className="mono">{endText(f.receiver)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The page from its view, so tests can render it. */
export function MismatchesPanels({ view }: { view: View_ }) {
  const [show, setShow] = useState<(typeof FILTERS)[number]>("all");
  const pick = useId();
  const shown = view.findings.filter((f) => show === "all" || f.status === show);
  const links = view.links
    .map((l) => ({ l, list: shown.filter((f) => f.id.startsWith(`${l.key}#`)) }))
    .filter((x) => x.list.length);
  const c = view.counts;
  return (
    <>
      <p className="work-say">{M.counts(c.mismatches, c.unconfirmed, c.links, c.compared)}</p>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <label htmlFor={pick}>{M.filter}</label>
        <select
          id={pick}
          value={show}
          onChange={(e) => setShow(e.target.value as (typeof FILTERS)[number])}
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {M.filters[f]}
            </option>
          ))}
        </select>
        <code className="mono">{M.command}</code>
        <CopyButton text={M.command} label={M.commandLabel} />
      </div>
      <div className="stack" style={{ gap: 12 }}>
        {links.map(({ l, list }) => (
          <LinkFindings key={l.key} link={l} list={list} />
        ))}
      </div>
      {view.notes.length > 0 && (
        <details>
          <summary>{M.notes}</summary>
          <ul className="ev-list">
            {view.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function Mismatches() {
  const view = useApi<View_>("/api/contracts");
  useReloadOnFiles(view);
  return (
    <div className="bento">
      <Panel title={M.title} span="1 / -1">
        <p className="work-say">{M.intro}</p>
        <View of={view} empty={(d) => d.counts.compared === 0} emptyText={M.empty}>
          {(d) => <MismatchesPanels view={d} />}
        </View>
      </Panel>
    </div>
  );
}
