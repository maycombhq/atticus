import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Runtime } from "../src/index.js";

/**
 * Review round 49 (end to end): `adapters: { gitHost: manual }`, as the admin guide words it,
 * is shorthand for `{ type: manual }`: a loosening of C6, every file valid before stays valid
 * and reads the same. A name no adapter has is still refused.
 */
const FORGE = join(__dirname, "..", "..", "..", "fixtures", "forge", "metarepo", "org-pack");
const base = parse(readFileSync(join(FORGE, "runtime.yaml"), "utf8")) as object;
const runtime = (adapters: unknown) => Runtime.safeParse({ ...base, adapters });

describe("an adapter named by its type alone", () => {
  it("reads as { type, settings: {} }", () => {
    const r = runtime({ gitHost: "manual", workTracker: "jira" });
    expect(r.success).toBe(true);
    expect(r.data!.adapters.gitHost).toEqual({ type: "manual", settings: {} });
    expect(r.data!.adapters.workTracker).toEqual({ type: "jira", settings: {} });
  });

  it("reads the full form as before", () => {
    const r = runtime({ gitHost: { type: "github", settings: { metarepo: "forge/forge-meta" } } });
    expect(r.data!.adapters.gitHost).toEqual({
      type: "github",
      settings: { metarepo: "forge/forge-meta" },
    });
  });

  it("refuses a name that is no adapter's", () => {
    const r = runtime({ gitHost: "carrier-pigeon" });
    expect(r.success).toBe(false);
  });
});
