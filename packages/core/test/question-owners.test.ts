import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  isPersonsQuestion,
  peopleOfChange,
  routeOfQuestion,
  migrateRolesText,
  ownerOfQuestion,
  ownerWords,
  readTeams,
  Roles,
  teamsOfPerson,
} from "../src/index.js";

/** Route each question to its owner (ADR 0140, Q4): roles.yaml version 2's teams. */

const ROLES_V2 = `schemaVersion: 2
teams:
  - { id: team-ledger, name: Ledger team, people: [ari, "@Bo.Chen"] }
  - { id: team-portal, people: [cy] }
`;

async function pack(text?: string) {
  const root = await mkdtemp(join(tmpdir(), "atticus-owners-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  if (text !== undefined) await writeFile(join(root, "org-pack/roles.yaml"), text);
  return root;
}

describe("roles.yaml version 2: the teams (ADR 0140)", () => {
  it("reads the teams and who is on each", async () => {
    const r = await readTeams(await pack(ROLES_V2));
    expect(r.problem).toBeUndefined();
    expect(r.teams.map((t) => [t.id, t.name, t.people])).toEqual([
      ["team-ledger", "Ledger team", ["ari", "@Bo.Chen"]],
      ["team-portal", undefined, ["cy"]],
    ]);
  });

  it("reads a version-1 file as it is, and refuses teams in one", () => {
    expect(Roles.safeParse({ schemaVersion: 1 }).success).toBe(true);
    const r = Roles.safeParse({ schemaVersion: 1, teams: [{ id: "team-ledger" }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("teams needs schemaVersion 2: run atticus upgrade");
    expect(
      Roles.safeParse({ schemaVersion: 2, teams: [{ id: "team-a" }, { id: "team-a" }] }).success,
    ).toBe(false);
  });

  it("says why when roles.yaml isn't valid, and names no team when there is none", async () => {
    expect((await readTeams(await pack())).teams).toEqual([]);
    const bad = await readTeams(await pack("schemaVersion: 1\nteams: [{ id: team-ledger }]\n"));
    expect(bad.teams).toEqual([]);
    expect(bad.problem).toBe(
      "org-pack/roles.yaml isn't valid: teams: teams needs schemaVersion 2: run atticus upgrade",
    );
  });

  it("moves a version-1 file to the current version (3 since ADR 0191), changing only the number", () => {
    const v1 = "# Forge roles\nschemaVersion: 1 # was 1\nenabledOptional: [sre]\n";
    expect(migrateRolesText(v1)).toEqual({
      text: "# Forge roles\nschemaVersion: 3 # was 1\nenabledOptional: [sre]\n",
      changed: true,
    });
    expect(migrateRolesText(ROLES_V2).changed).toBe(true);
    expect(migrateRolesText(migrateRolesText(ROLES_V2).text).changed).toBe(false);
  });
});

describe("who a question goes to (ADR 0140)", () => {
  const owners = new Map([
    ["forge-ledger", "team-ledger"],
    ["forge-portal-bff", "team-portal"],
  ]);
  const teams = Roles.parse(parseYaml(ROLES_V2)).teams;

  it("names the team that owns its repo, with the name roles.yaml gives it", () => {
    expect(ownerOfQuestion({ repo: "forge-ledger" }, { owners, teams })).toEqual({
      team: "team-ledger",
      name: "Ledger team",
    });
    expect(ownerWords(ownerOfQuestion({ repo: "forge-portal-bff" }, { owners, teams }))).toBe(
      "team-portal",
    );
  });

  it("says so when its repo has no owner", () => {
    expect(ownerWords(ownerOfQuestion({ repo: "forge-docs" }, { owners, teams }))).toBe(
      "no owner: no repos.manifest.yaml lists forge-docs, so no team owns it",
    );
    expect(
      ownerOfQuestion(
        { repo: "add-transfer-limit" },
        { owners, teams, changes: new Set(["add-transfer-limit"]) },
      ),
    ).toEqual({ none: "add-transfer-limit is a change, not a repo: no team owns its questions" });
  });

  it("finds a person's teams by their Git handle, @ and case aside", () => {
    expect(teamsOfPerson("bo.chen", teams).map((t) => t.id)).toEqual(["team-ledger"]);
    expect(teamsOfPerson("cy", teams).map((t) => t.id)).toEqual(["team-portal"]);
    expect(teamsOfPerson("dee", teams)).toEqual([]);
  });
});

describe("a change's own questions go to its people (ADR 0153, Q4)", () => {
  const teams = Roles.parse(parseYaml(ROLES_V2)).teams;
  const owners = new Map([["forge-ledger", "team-ledger"]]);
  const changes = new Set(["add-pins", "fix-dates"]);
  const changePeople = new Map([
    ["add-pins", peopleOfChange({ architect: ["ari"], developer: ["@Bo.Chen", "ari"] })],
    ["fix-dates", []],
  ]);

  it("names everyone change.yaml's owners lists, once each", () => {
    expect(changePeople.get("add-pins")).toEqual(["ari", "Bo.Chen"]);
  });

  it("routes a change's question to its people, a repo's to its team", () => {
    const o = { owners, teams, changes, changePeople };
    expect(routeOfQuestion({ repo: "add-pins" }, o)).toEqual({
      change: "add-pins",
      people: ["ari", "Bo.Chen"],
    });
    expect(routeOfQuestion({ repo: "fix-dates" }, o)).toEqual({
      none: "fix-dates is a change, and its change.yaml names no owners",
    });
    expect(routeOfQuestion({ repo: "forge-ledger" }, o)).toEqual({
      team: "team-ledger",
      name: "Ledger team",
    });
    expect(ownerWords(routeOfQuestion({ repo: "add-pins" }, o))).toBe(
      "add-pins's people: ari, Bo.Chen",
    );
  });

  it("a question is the person's by their team or by their change", () => {
    const pins = { change: "add-pins", people: ["ari", "Bo.Chen"] };
    expect(isPersonsQuestion("@bo.chen", pins, teams)).toBe(true);
    expect(isPersonsQuestion("cy", pins, teams)).toBe(false);
    expect(isPersonsQuestion("cy", { team: "team-portal" }, teams)).toBe(true);
    expect(isPersonsQuestion("cy", { none: "x" }, teams)).toBe(false);
  });
});
