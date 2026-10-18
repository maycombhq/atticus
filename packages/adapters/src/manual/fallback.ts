import type { Procedure } from "@maycombhq/core";
import { AdapterError } from "../common.js";
import type { DesignTool, Notifier, Wiki } from "../read-only.js";
import type { GitHost } from "../git-host.js";
import type { ServiceDesk } from "../service-desk.js";
import type { WorkTracker } from "../work-tracker.js";
import type { ManualBase, ManualOptions } from "./base.js";
import { ManualGitHost } from "./git-host.js";
import { ManualDesignTool, ManualNotifier, ManualWiki } from "./read-only.js";
import { ManualServiceDesk, type RequestExportReader } from "./service-desk.js";
import type { StepStore } from "./steps.js";
import { ManualWorkTracker, type WorkItemExportReader } from "./work-tracker.js";

export type AdapterKind = "workTracker" | "serviceDesk" | "gitHost" | "wiki" | "notify" | "design";

type Settings = Record<string, string | number | boolean | string[]>;

/** What manual adapters need: where steps go, and where to read exports from. */
export interface ManualContext {
  store: StepStore;
  /** The metarepo root (export folders are relative to it). */
  root?: string;
  change?: string;
  procedures?: Procedure[];
  readers?: { workItems?: WorkItemExportReader; requests?: RequestExportReader };
  now?: () => string;
  /**
   * Fall back to the manual adapter when a live one can't be reached or has no credentials.
   * Default true. The fallback is recorded on every step it creates and in `fallbacks`.
   */
  fallback?: boolean;
  /** Called on every fallback, so the CLI can say so. */
  onFallback?: (e: FallbackEvent) => void;
}

export interface FallbackEvent {
  kind: AdapterKind;
  method: string;
  code: string;
  message: string;
}

/** A manual adapter of one kind. */
export function manualAdapter(kind: AdapterKind, ctx: ManualContext, settings: Settings = {}) {
  const opts: ManualOptions = {
    store: ctx.store,
    settings,
    ...(ctx.root ? { root: ctx.root } : {}),
    ...(ctx.change ? { change: ctx.change } : {}),
    ...(ctx.procedures ? { procedures: ctx.procedures } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  };
  switch (kind) {
    case "workTracker":
      return new ManualWorkTracker(opts, ctx.readers?.workItems);
    case "serviceDesk":
      return new ManualServiceDesk(opts, ctx.readers?.requests);
    case "gitHost":
      return new ManualGitHost(opts);
    case "wiki":
      return new ManualWiki(opts);
    case "notify":
      return new ManualNotifier(opts);
    case "design":
      return new ManualDesignTool(opts);
  }
}

/** The error codes that mean "can't reach it" or "no credentials", where a person can step in. */
export const FALLBACK_CODES = new Set(["unavailable", "unauthorized"]);

/**
 * Wrap a live adapter so a call it can't make (unreachable, or no credentials) goes to the
 * manual adapter instead, with the reason on the step it creates. Any other error (not found,
 * conflict, invalid, not approved) is the live system's answer and is passed through.
 */
export function withManualFallback<T extends object>(
  kind: AdapterKind,
  live: T,
  manual: T & ManualBase,
  onFallback?: (e: FallbackEvent) => void,
): T {
  return new Proxy(live, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (!(e instanceof AdapterError) || !FALLBACK_CODES.has(e.code)) throw e;
          const m = (manual as unknown as Record<PropertyKey, unknown>)[prop];
          if (typeof m !== "function") throw e;
          const reason = `the ${kind} adapter failed (${e.code}): ${e.message}`;
          onFallback?.({ kind, method: String(prop), code: e.code, message: e.message });
          manual.reason = reason;
          try {
            return await (m as (...a: unknown[]) => Promise<unknown>).apply(manual, args);
          } finally {
            manual.reason = undefined;
          }
        }
      };
    },
  });
}

export type ManualAdapters = {
  workTracker: WorkTracker;
  serviceDesk: ServiceDesk;
  gitHost: GitHost;
  wiki: Wiki;
  notify: Notifier;
  design: DesignTool;
};

/** Every external system as a manual adapter: Atticus with no integrations at all. */
export function allManual(
  ctx: ManualContext,
  settings: Partial<Record<AdapterKind, Settings>> = {},
) {
  return {
    workTracker: manualAdapter("workTracker", ctx, settings.workTracker) as ManualWorkTracker,
    serviceDesk: manualAdapter("serviceDesk", ctx, settings.serviceDesk) as ManualServiceDesk,
    gitHost: manualAdapter("gitHost", ctx, settings.gitHost) as ManualGitHost,
    wiki: manualAdapter("wiki", ctx, settings.wiki) as ManualWiki,
    notify: manualAdapter("notify", ctx, settings.notify) as ManualNotifier,
    design: manualAdapter("design", ctx, settings.design) as ManualDesignTool,
  };
}
