import type { Runtime } from "@maycombhq/core";
import { AdapterError } from "./common.js";
import { MockGitHost, type GitHost } from "./git-host.js";
import {
  MockDesignTool,
  MockNotifier,
  MockWiki,
  type DesignTool,
  type Notifier,
  type Wiki,
} from "./read-only.js";
import { MockServiceDesk, type ServiceDesk } from "./service-desk.js";
import { MockWorkTracker, type WorkTracker } from "./work-tracker.js";

export interface Adapters {
  workTracker?: WorkTracker;
  serviceDesk?: ServiceDesk;
  gitHost?: GitHost;
  wiki?: Wiki;
  notify?: Notifier;
  design?: DesignTool;
}

type Settings = Record<string, string | number | boolean | string[]>;

/** Makes an adapter of one type from its runtime.yaml settings. Real adapters register here. */
export interface AdapterFactories {
  workTracker?: Record<string, (s: Settings) => WorkTracker>;
  serviceDesk?: Record<string, (s: Settings) => ServiceDesk>;
  gitHost?: Record<string, (s: Settings) => GitHost>;
  wiki?: Record<string, (s: Settings) => Wiki>;
  notify?: Record<string, (s: Settings) => Notifier>;
  design?: Record<string, (s: Settings) => DesignTool>;
}

const MOCKS: Required<AdapterFactories> = {
  workTracker: { mock: () => new MockWorkTracker() },
  serviceDesk: { mock: () => new MockServiceDesk() },
  gitHost: { mock: () => new MockGitHost() },
  wiki: { mock: () => new MockWiki() },
  notify: { mock: () => new MockNotifier() },
  design: { mock: () => new MockDesignTool() },
};

/**
 * Build the adapters runtime.yaml asks for. An adapter that isn't configured is left out
 * (the screen shows "not connected"); Atticus never silently falls back to a mock. A type
 * with no installed factory is an error naming what to install.
 */
export function createAdapters(
  runtime: Pick<Runtime, "adapters">,
  factories: AdapterFactories = {},
): Adapters {
  const out: Adapters = {};
  const kinds = ["workTracker", "serviceDesk", "gitHost", "wiki", "notify", "design"] as const;
  for (const kind of kinds) {
    const cfg = runtime.adapters[kind];
    if (!cfg) continue;
    const make =
      (factories[kind] as Record<string, (s: Settings) => unknown> | undefined)?.[cfg.type] ??
      (MOCKS[kind] as Record<string, (s: Settings) => unknown>)[cfg.type];
    if (!make) {
      throw new AdapterError(
        kind,
        "invalid",
        `no ${cfg.type} adapter is installed; add its plugin or set type: mock for tests`,
      );
    }
    (out as Record<string, unknown>)[kind] = make(cfg.settings);
  }
  return out;
}
