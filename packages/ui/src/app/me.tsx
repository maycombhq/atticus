import { createContext, useContext, useState, type ReactNode } from "react";
import { api, useApi } from "../api/client.js";
import type { RoleDef } from "./roles.js";

export interface Me {
  user: string;
  /** What AI may do here (runtime.yaml ai, ADR 0046). */
  ai: "on" | "text-only" | "off";
  groups: string[];
  view: string | null;
  source: "chosen" | "group" | "pick";
  sourceGroup?: string;
  roles: RoleDef[];
  approvals: { action: string; because: string }[];
  owns: string[];
}

interface MeState {
  me?: Me;
  setView: (view: string) => Promise<void>;
  error?: string;
}

const Ctx = createContext<MeState>({ setView: async () => undefined });

/** Who is signed in and the view they work in, shared by the sidebar and every home. */
export function MeProvider({ children }: { children: ReactNode }) {
  const loaded = useApi<Me>("/api/me");
  const [saved, setSaved] = useState<Me | undefined>();
  const [error, setError] = useState<string | undefined>();
  const me = saved ?? (loaded.state === "ready" ? loaded.data : undefined);
  const setView = async (view: string) => {
    try {
      setSaved(await api<Me>("/api/me", { method: "PUT", body: { view } }));
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Ctx.Provider value={{ ...(me ? { me } : {}), setView, ...(error ? { error } : {}) }}>
      {children}
    </Ctx.Provider>
  );
}

export const useMe = () => useContext(Ctx);

/** Plain words for the approvals that happen outside Git. */
export const ACTION_LABEL: Record<string, string> = {
  "release-go-no-go": "Release go / no-go",
  waiver: "Waivers",
  "snow-submission": "Service-request submission",
  "org-pack-change": "Org-pack changes",
  "catalog-assert": "Catalog decisions",
};

/** The role picker: a labelled select, used in the sidebar and on a first launch. */
export function ViewPicker({ id, compact }: { id: string; compact?: boolean }) {
  const { me, setView } = useMe();
  if (!me) return null;
  return (
    <label htmlFor={id} className="stack" style={{ gap: 4 }}>
      <span className="hud" style={{ fontSize: compact ? 9.5 : 10 }}>
        {compact ? "View" : "Pick the view you work in"}
      </span>
      <select
        id={id}
        value={me.view ?? ""}
        onChange={(e) => void setView(e.target.value)}
        style={{
          height: 32,
          background: "#0B1016",
          color: "var(--text)",
          border: "1px solid var(--line-2)",
          borderRadius: 7,
          padding: "0 8px",
          font: "inherit",
          fontSize: 13,
        }}
      >
        {!me.view && <option value="">Choose…</option>}
        {me.roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** True when AI steps may start here; false when the org pack turns AI off. */
export const useAiOn = () => useMe().me?.ai !== "off";

/** What to do instead of an AI step when AI is off. */
export const AI_OFF_TEXT =
  "AI is off here, so write it yourself: the critic's rule checks still review it.";
