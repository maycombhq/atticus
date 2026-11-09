import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";
import { CopyButton } from "../run/shared.js";

/**
 * ADR 0190: `atticus ui` started in a folder that isn't a metarepo. The app offers Create the
 * metarepo here (init's own code, on the server) or Open another folder (the app for that folder,
 * at its own address). Once created, Home continues with Onboarding.
 */

const S = COPY.setup;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function CreateMetarepoForm(p: { view: Api.SetupMetarepoViewT; onCreated: () => void }) {
  const [name, setName] = useState(p.view.suggested.name);
  const [platform, setPlatform] = useState(p.view.suggested.platform);
  const [owner, setOwner] = useState("");
  const [metarepo, setMetarepo] = useState(p.view.metarepoId ?? "");
  const act = useAction();
  const bad = !SLUG.test(name) || !SLUG.test(platform);
  const command = `atticus init . --platform ${platform || "<platform>"}${owner.trim() ? ` --owner ${owner.trim()}` : ""}`;
  return (
    <form
      className="stack"
      style={{ gap: 10 }}
      aria-describedby="create-what"
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        void act.run(async () => {
          const r = await api<{ lines: string[] }>("/api/setup/metarepo", {
            method: "POST",
            body: {
              name,
              platform,
              ...(owner.trim() ? { owner: owner.trim() } : {}),
              ...(metarepo.trim() ? { metarepo: metarepo.trim() } : {}),
            },
          });
          p.onCreated();
          return r;
        }, S.created);
      }}
    >
      <p id="create-what" className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
        {S.createWhat}
      </p>
      {(
        [
          ["setup-name", S.name, S.nameHint, name, setName, true],
          ["setup-platform", S.platform, S.platformHint, platform, setPlatform, true],
          ["setup-owner", S.owner, S.ownerHint, owner, setOwner, false],
          ["setup-metarepo", S.metarepoId, S.metarepoIdHint, metarepo, setMetarepo, false],
        ] as const
      ).map(([id, label, hint, value, set, slug]) => (
        <div key={id} className="stack" style={{ gap: 4, maxWidth: 520 }}>
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            className="field mono"
            value={value}
            required={slug}
            aria-invalid={slug && !SLUG.test(value) ? true : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(e) => set(e.target.value)}
          />
          <span id={`${id}-hint`} className="muted" style={{ fontSize: 12 }}>
            {slug && value && !SLUG.test(value) ? S.badSlug : hint}
          </span>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn primary" disabled={act.busy || bad}>
          {act.busy ? S.creating : S.create}
        </button>
      </div>
      <Note note={act.note} />
      <details>
        <summary className="hud">{S.terminal}</summary>
        <div className="work-cmd">
          <code className="mono">{command}</code>
          <CopyButton text={command} label={COPY.decisions.copy(command)} />
        </div>
      </details>
    </form>
  );
}

export function OpenFolderForm() {
  const [path, setPath] = useState("");
  const act = useAction();
  return (
    <form
      className="stack"
      style={{ gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!path.trim()) return;
        void act.run(
          async () => {
            const r = await api<Api.OpenFolderViewT>("/api/setup/open", {
              method: "POST",
              body: { path: path.trim() },
            });
            location.assign(r.url);
            return r;
          },
          (r) => S.openedAt(r.url),
        );
      }}
    >
      <div className="stack" style={{ gap: 4, maxWidth: 520 }}>
        <label htmlFor="setup-open-path">{S.path}</label>
        <input
          id="setup-open-path"
          className="field mono"
          value={path}
          aria-describedby="setup-open-hint"
          onChange={(e) => setPath(e.target.value)}
        />
        <span id="setup-open-hint" className="muted" style={{ fontSize: 12 }}>
          {S.pathHint}
        </span>
      </div>
      <div className="row">
        <button type="submit" className="btn" disabled={act.busy || !path.trim()}>
          {act.busy ? S.opening : S.open}
        </button>
      </div>
      <Note note={act.note} />
    </form>
  );
}

/** The whole page for a folder that isn't a metarepo. */
export function CreateMetarepo({ onCreated }: { onCreated: () => void }) {
  const v = useApi<Api.SetupMetarepoViewT>("/api/setup/metarepo");
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h2 className="n" style={{ margin: 0, fontSize: 24 }}>
        {S.title}
      </h2>
      <div className="bento">
        <Panel title={S.createTitle} span="span 7">
          <View of={v}>
            {(d) => (
              <div className="stack" style={{ gap: 8 }}>
                <p style={{ margin: 0 }}>{S.intro(d.root)}</p>
                <CreateMetarepoForm view={d} onCreated={onCreated} />
              </div>
            )}
          </View>
        </Panel>
        <Panel title={S.openTitle} span="span 5">
          <OpenFolderForm />
        </Panel>
      </div>
    </div>
  );
}
