import { useId } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, type Loaded } from "../api/client.js";
import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";

/**
 * After any correction the app writes (Correct this, This link is wrong; plan item C4, ADR 0149):
 * one panel with the commands to run, each with a copy button, the correction file's change as
 * written, and what the next `atticus verify <repo> --write` will change in the facts and the
 * catalog, worked out by the server with that command's own functions and nothing written. The
 * app runs none of the commands (build-status B1).
 */

const N = COPY.correctionNext;
type Preview = Api.VerifyPreviewViewT;
type Link = Api.PreviewLinkViewT;

const what = (l: { from: string; to: string; method?: string | undefined; path: string }) =>
  N.linkWhat(l.from, l.to, l.method, l.path);

/** One command with its copy button. */
function Cmd({ text, label }: { text: string; label: string }) {
  return (
    <div className="work-cmd">
      <code className="mono">{text}</code>
      <CopyButton text={text} label={N.copy(`${label}: ${text}`)} />
    </div>
  );
}

function PreviewBody({ v }: { v: Preview }) {
  if (!v.preview) return <p className="ev-say">{N.unavailable[v.unavailable ?? "no-checkout"]}</p>;
  const p = v.preview;
  const l = p.links;
  const linkItems: string[] = l
    ? [
        ...l.moved.map((m) => N.moved(what({ ...m, to: m.was }), m.was, m.to)),
        ...l.added.map((x: Link) => N.added(what(x))),
        ...l.removed.map((x: Link) => N.removed(what(x))),
        ...l.changed.map((x: Link) => N.changed(what(x), x.was?.confidence ?? "", x.confidence)),
        ...l.unmade.map((x: Link) => N.unmade(what(x))),
      ]
    : [];
  const factItems = [
    ...p.facts.dropped.map(
      (f) =>
        `${N.dropped}: ${f.label} (${N.droppedWhy[f.why]}${f.message ? `: ${f.message}` : ""})`,
    ),
    ...p.facts.edited.map(
      (f) =>
        `${N.edited}: ${f.label} (${f.fields.map((x) => N.field(x.name, x.was, x.now)).join("; ")})`,
    ),
  ];
  return (
    <div className="stack" style={{ gap: 4 }}>
      {p.headMoved && <p className="ev-say">{N.headMoved(p.headMoved.head, p.headMoved.commit)}</p>}
      {p.blocked && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {N.blocked(p.blocked.rejected)}
        </p>
      )}
      <h5 className="hud">{N.facts}</h5>
      {factItems.length ? (
        <ul className="ev-list">
          {factItems.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="ev-say">{N.noFactChange}</p>
      )}
      <p className="ev-say">{N.kept(p.facts.kept)}</p>
      {l && (
        <>
          <h5 className="hud">{N.links}</h5>
          {linkItems.length ? (
            <ul className="ev-list">
              {linkItems.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p className="ev-say">{N.noLinkChange}</p>
          )}
        </>
      )}
      {p.catalog && (
        <p className="ev-say">
          {N.catalog(p.catalog.added, p.catalog.changed, p.catalog.removed, p.catalog.evidenceOnly)}
        </p>
      )}
      {p.staleCorrections.length > 0 && <p className="ev-say">{N.stale(p.staleCorrections)}</p>}
    </div>
  );
}

/** The panel from its state, so tests can render each one. */
export function CorrectionNextPanel(p: {
  /** The file the app wrote and the line it appended, from the correction's result. */
  file: string;
  line?: string | undefined;
  preview: Loaded<Preview>;
}) {
  const id = useId();
  const v = p.preview.state === "ready" ? p.preview.data : undefined;
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby={`${id}-t`}>
      <h4 id={`${id}-t`} className="h" style={{ fontSize: 14 }}>
        {N.title}
      </h4>
      <p className="ev-say">{N.onlyWrote(p.file)}</p>
      {p.line && (
        <figure style={{ margin: 0 }}>
          <figcaption className="hud">{N.fileDiff(p.file)}</figcaption>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            <code>{`+ ${p.line}`}</code>
          </pre>
        </figure>
      )}
      <h5 className="hud">{N.stepsTitle}</h5>
      {p.preview.state === "loading" && (
        <p role="status" aria-busy="true" className="ev-say">
          {N.loading}
        </p>
      )}
      {p.preview.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {N.failed(p.preview.error)}
        </p>
      )}
      {v && (
        <>
          <ol className="stack" style={{ gap: 4, paddingLeft: 18, margin: 0 }}>
            {v.steps.map((s) => (
              <li key={s.step}>
                <span className="ev-say">{N.step[s.step]}</span>
                {s.command ? (
                  <Cmd text={s.command} label={N.step[s.step]!} />
                ) : (
                  <p className="ev-say" style={{ margin: 0 }}>
                    {N.prByHand(v.branch)}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <h5 className="hud">{N.previewTitle}</h5>
          <p className="ev-say">{N.previewIntro}</p>
          <PreviewBody v={v} />
        </>
      )}
    </section>
  );
}

/** The panel for a correction just written: reads the preview from the local API. */
export function CorrectionNext(p: { repo: string; result: Api.FactCorrectionResultT }) {
  const preview = useApi<Preview>(
    `/api/facts/${encodeURIComponent(p.repo)}/preview?fact=${encodeURIComponent(p.result.correction.fact)}`,
  );
  return <CorrectionNextPanel file={p.result.file} line={p.result.line} preview={preview} />;
}
