import { describe, expect, it } from "vitest";
import type { OrgPack } from "@maycombhq/core";
import { systemToCreate } from "../src/ui-api-declared.js";

/**
 * The review of beta.28.1 (N4): the System a declaration from a repo's box adds first, when no
 * profile has it, is picked the same way whatever order the profiles load in: a platform with a
 * profile first, then by platform and repo id; its owner only when that platform's repos agree.
 * Invented Forge and Harbor platforms.
 */

type Repo = { id: string; system?: string; owner?: string };
const pack = (
  ps: { platform: string; profile?: boolean; systems?: string[]; repos: Repo[] }[],
): OrgPack =>
  ({
    profiles: ps.map((p) => ({
      platform: p.platform,
      ...(p.profile === false
        ? {}
        : {
            profile: {
              schemaVersion: 1,
              platform: p.platform,
              name: p.platform,
              systems: (p.systems ?? []).map((id) => ({ id, name: id, boundary: "product" })),
            },
          }),
      repos: {
        schemaVersion: 3,
        platform: p.platform,
        repos: p.repos.map((r) => ({
          url: `https://git.example/${r.id}.git`,
          type: "service",
          ...r,
        })),
      },
    })),
  }) as unknown as OrgPack;

describe("the System a declaration adds first (N4)", () => {
  const forge = {
    platform: "forge",
    repos: [{ id: "forge-ledger-api", system: "ledger", owner: "team-ledger" }],
  };
  const harbor = {
    platform: "harbor",
    repos: [{ id: "harbor-ledger", system: "ledger", owner: "team-harbor" }],
  };

  it("picks the same platform whatever the order, the first by name", () => {
    expect(systemToCreate(pack([forge, harbor]), "ledger")).toEqual({
      platform: "forge",
      owner: "team-ledger",
    });
    expect(systemToCreate(pack([harbor, forge]), "ledger")).toEqual({
      platform: "forge",
      owner: "team-ledger",
    });
  });

  it("prefers a platform that has a profile to add it to", () => {
    expect(systemToCreate(pack([{ ...forge, profile: false }, harbor]), "ledger")).toEqual({
      platform: "harbor",
      owner: "team-harbor",
    });
  });

  it("names no owner when the platform's repos drawn in it have different teams", () => {
    const two = {
      platform: "forge",
      repos: [
        { id: "forge-ledger-api", system: "ledger", owner: "team-ledger" },
        { id: "forge-ledger-jobs", system: "ledger", owner: "team-batch" },
      ],
    };
    expect(systemToCreate(pack([two]), "ledger")).toEqual({ platform: "forge" });
  });

  it("adds nothing for a system a profile has, and none no repo is drawn in", () => {
    expect(systemToCreate(pack([{ ...forge, systems: ["ledger"] }]), "ledger")).toBeUndefined();
    expect(systemToCreate(pack([forge]), "nowhere")).toBeUndefined();
  });
});
