import { useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note } from "../know/common.js";
import { Command } from "../work/RunNext.js";
import { pageText } from "./shared.js";

/**
 * The org pack from the wikis (ADR 0102): each platform profile's systems drafted from the
 * products and vendors the knowledge names (`atticus orgpack draft`), each verified or not;
 * Accept puts the picked ones into profile.yaml (`atticus orgpack accept --only`). The verified
 * ones are picked to start with, as the plugin does.
 */

const O = COPY.knowledge.orgpack;

type Platform = Api.OrgPackDraftViewT["platforms"][number];
type Proposal = Api.OrgPackProposalViewT;

/** The ids picked to start with: the verified proposals. */
export const initialPick = (ps: Proposal[]) => ps.filter((p) => p.verified).map((p) => p.from);

function proposalWords(p: Proposal): string {
  if (p.action === "add")
    return `${p.system.boundary}${p.system.owner ? `, ${p.system.owner}` : ""}${p.system.aliases.length ? `, ${p.system.aliases.join(", ")}` : ""}`;
  const gains = [
    p.adds?.aliases?.length ? p.adds.aliases.join(", ") : "",
    p.adds?.owner ? p.adds.owner : "",
  ]
    .filter(Boolean)
    .join("; ");
  return O.gains(gains);
}

/** One platform's draft: each proposal with a checkbox, and Accept for the picked ones. */
export function PlatformDraft(p: {
  d: Platform;
  onDraft?: (platform: string) => void;
  onAccept?: (platform: string, only: string[]) => void;
  busy?: boolean;
}) {
  const d = p.d;
  const [picked, setPicked] = useState<string[]>(() => initialPick(d.proposals));
  const [err, setErr] = useState<string | undefined>();
  const toggle = (id: string, on: boolean) =>
    setPicked((x) => (on ? [...new Set([...x, id])] : x.filter((y) => y !== id)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          disabled={p.busy}
          onClick={() => p.onDraft?.(d.platform)}
        >
          {p.busy ? O.drafting : O.draft}
        </button>
        {d.at && <span className="hud">{O.at(d.at.slice(0, 10))}</span>}
      </div>
      <p className="work-say">{O.command}</p>
      <Command text={d.command} label={COPY.knowledge.ai.copy} />
      {!d.present ? (
        <div className="state">{O.noDraft}</div>
      ) : d.proposals.length === 0 ? (
        <div className="state">{O.nothing}</div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!picked.length) {
              setErr(O.pickOne);
              return;
            }
            setErr(undefined);
            p.onAccept?.(d.platform, picked);
          }}
        >
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr">{d.platform}</legend>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {d.proposals.map((x) => (
                <li key={x.from} className="list-row" style={{ alignItems: "flex-start" }}>
                  <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                    <input
                      type="checkbox"
                      aria-label={O.pick(x.system.name)}
                      checked={picked.includes(x.from)}
                      onChange={(e) => toggle(x.from, e.target.checked)}
                    />
                    <span className="stack" style={{ gap: 2 }}>
                      <span>
                        <span className="chip dim">{x.action === "add" ? O.add : O.update}</span>{" "}
                        <strong>{x.system.name}</strong>{" "}
                        <span className="muted mono" style={{ fontSize: 11 }}>
                          {x.system.id}
                        </span>
                      </span>
                      <span style={{ fontSize: 12 }}>{proposalWords(x)}</span>
                      {x.quote && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          "{x.quote}" ({x.page ? `${pageText(x.page)}, ` : ""}
                          <a href={`#/knowledge?item=${encodeURIComponent(x.from)}`}>{x.from}</a>)
                        </span>
                      )}
                      {x.notes.map((n) => (
                        <span key={n} className="muted" style={{ fontSize: 12 }}>
                          {n}
                        </span>
                      ))}
                    </span>
                  </label>
                  <span className={`chip ${x.verified ? "done" : "warn"}`}>
                    {x.verified ? O.verified(x.verifiedBy ?? "") : O.unverified}
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>
          <button type="submit" className="btn primary" disabled={p.busy} style={{ marginTop: 8 }}>
            {p.busy ? O.accepting : O.accept}
          </button>
          {err && (
            <p
              role="alert"
              style={{ margin: "6px 0 0", color: "var(--magenta-text)", fontSize: 12.5 }}
            >
              {err}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export function DraftPage(p: {
  of: Loaded<Api.OrgPackDraftViewT>;
  onDraft?: (platform: string) => void;
  onAccept?: (platform: string, only: string[]) => void;
  busy?: boolean;
}) {
  return (
    <View of={p.of} empty={(d) => d.platforms.length === 0} emptyText={O.empty}>
      {(d) => (
        <div className="bento">
          {d.platforms.map((x) => (
            <Panel key={x.platform} title={x.platform} span="1 / -1">
              <PlatformDraft
                key={`${x.platform}:${x.at ?? ""}:${x.proposals.length}`}
                d={x}
                onDraft={p.onDraft}
                onAccept={p.onAccept}
                busy={p.busy}
              />
            </Panel>
          ))}
        </div>
      )}
    </View>
  );
}

export function OrgPackDraft() {
  const view = useApi<Api.OrgPackDraftViewT>("/api/orgpack/draft");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; working?: boolean } | undefined>();
  // Draft and Accept redraw the list under the keyboard: it moves to what they did instead.
  const said = useRef<HTMLDivElement>(null);
  useLiveEvents((e) => {
    if (e.type === "file.changed") view.reload();
  });
  const act = (f: () => Promise<string>) => {
    setBusy(true);
    setNote({ ok: true, text: COPY.app.working, working: true });
    f()
      .then((text) => setNote({ ok: true, text }))
      .catch((e: unknown) => setNote({ ok: false, text: message(e) }))
      .finally(() => {
        setBusy(false);
        view.reload();
        said.current?.focus();
      });
  };
  return (
    <>
      <p className="work-say" style={{ marginTop: 0 }}>
        {O.intro}
      </p>
      <div ref={said} tabIndex={-1}>
        <Note note={note} />
      </div>
      <DraftPage
        of={view}
        busy={busy}
        onDraft={(platform) =>
          act(async () => {
            const r = await api<Api.OrgPackDraftViewT>("/api/orgpack/draft", {
              method: "POST",
              body: { platform },
            });
            const n = r.platforms.find((x) => x.platform === platform)?.proposals.length ?? 0;
            return n ? O.drafted(n) : O.nothing;
          })
        }
        onAccept={(platform, only) =>
          act(async () => {
            const r = await api<Api.AcceptedOrgPackT>(
              `/api/orgpack/draft/${encodeURIComponent(platform)}/accept`,
              { method: "POST", body: { only } },
            );
            return O.accepted(r.added.length, r.updated.length, r.file);
          })
        }
      />
    </>
  );
}
