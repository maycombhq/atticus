import { createContext, useContext, useState, type ReactNode } from "react";
import { api, useApi } from "../api/client.js";

/** Who is using the app: the metarepo's Git user (ADR 0073). There are no roles or views. */
export interface Me {
  /** The handle Atticus records as `by`. */
  user: string;
  /** git config user.name and user.email, when set. */
  name?: string;
  email?: string;
  /** git: from git config; os: Git has no user, so the OS user stands in; given: named at start. */
  source: "git" | "os" | "given";
  /** Set when the OS user stood in: how to set the Git user. */
  warning?: string;
  /** What AI may do here (runtime.yaml ai, ADR 0046). */
  ai: "on" | "text-only" | "off";
  /** The person's digest settings (.atticus/me.yaml, ADR 0048). */
  notify?: { digest: "off" | "daily" | "weekly"; channel?: string };
}

interface MeState {
  me?: Me;
  /** Save digest settings; throws the API's words when refused. */
  saveNotify: (n: { digest: string; channel?: string }) => Promise<void>;
}

const Ctx = createContext<MeState>({ saveNotify: async () => undefined });

/** Who is using the app, shared by the top bar, Home and Settings. */
export function MeProvider({ children }: { children: ReactNode }) {
  const loaded = useApi<Me>("/api/me");
  const [saved, setSaved] = useState<Me | undefined>();
  const me = saved ?? (loaded.state === "ready" ? loaded.data : undefined);
  const saveNotify = async (n: { digest: string; channel?: string }) => {
    setSaved(await api<Me>("/api/me/notify", { method: "PUT", body: n }));
  };
  return <Ctx.Provider value={{ ...(me ? { me } : {}), saveNotify }}>{children}</Ctx.Provider>;
}

export const useMe = () => useContext(Ctx);

/** True when AI steps may start here; false when the org pack turns AI off. */
export const useAiOn = () => useMe().me?.ai !== "off";

/** What to do instead of an AI step when AI is off. */
export const AI_OFF_TEXT =
  "AI is off here, so write it yourself: the critic's rule checks still review it.";
