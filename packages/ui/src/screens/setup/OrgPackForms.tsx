import { useState } from "react";
import { api } from "../../api/client.js";
import { Panel } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { EditPreview, type FileEdit } from "./EditPreview.js";
import { RawFilePicker } from "./RawFile.js";

/**
 * ADR 0190: Set up › Org pack in the app. An integration pattern (patterns/<code>.yaml) and a
 * wiki (sources.yaml, atticus sources add's code) each have a form, as their schemas are simple;
 * anything else is the raw editor. Each is previewed, written and proposed for review.
 */

const S = COPY.setup;

// The values the schemas take (IntegrationPattern, Sources' wiki types): codes, not words.
const INTERACTIONS = ["sync", "async", "data-access"];
const ROUTES = ["gateway", "direct", "event-bus", "pubsub", "sftp", "mq", "jdbc", "other"];
const TARGETS = ["product", "internal", "vendor", "data-store"];
const STATUSES = ["to-review", "confirmed", "deprecated"];
const WIKI_TYPES = [
  "markdown-folder",
  "git",
  "ado-wiki",
  "confluence",
  "sharepoint",
  "confluence-export",
  "sharepoint-export",
];

function Field(p: {
  id: string;
  label: string;
  value: string;
  set: (v: string) => void;
  hint?: string;
  options?: string[];
  long?: boolean;
}) {
  const described = p.hint ? `${p.id}-hint` : undefined;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor={p.id}>{p.label}</label>
      {p.options ? (
        <select
          id={p.id}
          className="field"
          value={p.value}
          aria-describedby={described}
          onChange={(e) => p.set(e.target.value)}
        >
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : p.long ? (
        <textarea
          id={p.id}
          className="field"
          rows={2}
          value={p.value}
          aria-describedby={described}
          onChange={(e) => p.set(e.target.value)}
        />
      ) : (
        <input
          id={p.id}
          className="field mono"
          value={p.value}
          aria-describedby={described}
          onChange={(e) => p.set(e.target.value)}
        />
      )}
      {p.hint && (
        <span id={described} className="muted" style={{ fontSize: 12 }}>
          {p.hint}
        </span>
      )}
    </div>
  );
}

export function PatternForm() {
  const [f, setF] = useState({
    code: "",
    name: "",
    definition: "",
    interaction: "sync",
    route: "gateway",
    targetType: "internal",
    controls: "",
    source: "",
    status: "to-review",
  });
  const [round, setRound] = useState(0);
  const set = (k: keyof typeof f) => (v: string) => {
    setF({ ...f, [k]: v });
    setRound(round + 1);
  };
  const body = (preview: boolean) => ({
    ...f,
    controls: f.controls
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    ...(preview ? { preview: true } : {}),
  });
  const ready = !!(f.code.trim() && f.name.trim() && f.definition.trim() && f.source.trim());
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Field id="pattern-code" label={S.code} hint={S.codeHint} value={f.code} set={set("code")} />
      <Field id="pattern-name" label={S.patternName} value={f.name} set={set("name")} />
      <Field
        id="pattern-definition"
        label={S.definition}
        value={f.definition}
        set={set("definition")}
        long
      />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Field
          id="pattern-interaction"
          label={S.interaction}
          value={f.interaction}
          set={set("interaction")}
          options={INTERACTIONS}
        />
        <Field
          id="pattern-route"
          label={S.route}
          value={f.route}
          set={set("route")}
          options={ROUTES}
        />
        <Field
          id="pattern-target"
          label={S.targetType}
          value={f.targetType}
          set={set("targetType")}
          options={TARGETS}
        />
        <Field
          id="pattern-status"
          label={S.status}
          value={f.status}
          set={set("status")}
          options={STATUSES}
        />
      </div>
      <Field id="pattern-controls" label={S.controls} value={f.controls} set={set("controls")} />
      <Field
        id="pattern-source"
        label={S.source}
        hint={S.sourceHint}
        value={f.source}
        set={set("source")}
      />
      <EditPreview
        key={round}
        disabled={!ready}
        preview={() => api<FileEdit>("/api/setup/patterns", { method: "POST", body: body(true) })}
        write={() => api<FileEdit>("/api/setup/patterns", { method: "POST", body: body(false) })}
      />
    </div>
  );
}

export function WikiForm() {
  const [f, setF] = useState({ type: "markdown-folder", location: "", path: "", ref: "" });
  const [round, setRound] = useState(0);
  const set = (k: keyof typeof f) => (v: string) => {
    setF({ ...f, [k]: v });
    setRound(round + 1);
  };
  const body = (preview: boolean) => ({
    type: f.type,
    location: f.location.trim(),
    ...(f.type === "git" && f.path.trim() ? { path: f.path.trim() } : {}),
    ...(f.type === "git" && f.ref.trim() ? { ref: f.ref.trim() } : {}),
    ...(preview ? { preview: true } : {}),
  });
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Field
        id="wiki-type"
        label={S.wikiType}
        value={f.type}
        set={set("type")}
        options={WIKI_TYPES}
      />
      <Field
        id="wiki-location"
        label={S.location}
        hint={S.locationHint}
        value={f.location}
        set={set("location")}
      />
      {f.type === "git" && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Field id="wiki-path" label={S.wikiPath} value={f.path} set={set("path")} />
          <Field id="wiki-ref" label={S.wikiRef} value={f.ref} set={set("ref")} />
        </div>
      )}
      <EditPreview
        key={round}
        disabled={!f.location.trim()}
        preview={() => api<FileEdit>("/api/setup/sources", { method: "POST", body: body(true) })}
        write={() => api<FileEdit>("/api/setup/sources", { method: "POST", body: body(false) })}
      />
    </div>
  );
}

/** The panels Set up › Org pack adds: a pattern, a wiki, and any file in the raw editor. */
export function OrgPackEditors() {
  return (
    <>
      <Panel title={S.patternTitle} span="span 6">
        <PatternForm />
      </Panel>
      <Panel title={S.wikiTitle} span="span 6">
        <WikiForm />
      </Panel>
      <Panel title={S.rawPickTitle} span="span 12">
        <RawFilePicker />
      </Panel>
    </>
  );
}
