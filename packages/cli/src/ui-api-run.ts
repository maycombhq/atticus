import type { Router, ServerContext } from "@maycombhq/server";
import type { UiDeps } from "./ui-api.js";

/** Local API calls for the Release and Run screens (ADR 0043). */
export function uiRunRoutes(r: Router, _ctx: ServerContext, _deps: UiDeps = {}): Router {
  return r;
}
