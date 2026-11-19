import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles, type Loaded } from "../api/client.js";
import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";
import { UPGRADE_HREF } from "./ways-on.js";

const W = COPY.standing;

/**
 * ADR 0202 point 8: Home's top line, where the metarepo stands (GET /api/status, the line
 * `atticus status` prints), with one button: the upgrade panel when the metarepo is behind, the
 * install command to copy when this Atticus is, none when up to date. It only reads.
 */
export function StandingLineView({ load }: { load: Loaded<Api.StandingViewT> }) {
  if (load.state === "loading")
    return (
      <p className="muted" role="status" style={{ margin: 0, fontSize: 12 }}>
        {W.loading}
      </p>
    );
  if (load.state === "error") {
    // A server from before 3.19.0 has no such route: Home is what it was.
    if (load.status === 404) return null;
    return (
      <p role="alert" style={{ margin: 0, fontSize: 12 }}>
        {W.failed}
      </p>
    );
  }
  const v = load.data;
  const install = v.state === "catalog-newer" || v.state === "atticus-behind";
  return (
    <section className="work-cmd" aria-label={W.label}>
      <span>{v.line}</span>
      {v.state === "metarepo-behind" && (
        <a className="btn primary" href={UPGRADE_HREF}>
          {W.upgrade}
        </a>
      )}
      {install && v.do && <CopyButton text={v.do} say={W.copy} label={W.copyLabel(v.do)} />}
    </section>
  );
}

export function StandingLine() {
  const s = useApi<Api.StandingViewT>("/api/status");
  useReloadOnFiles(s);
  return <StandingLineView load={s} />;
}
