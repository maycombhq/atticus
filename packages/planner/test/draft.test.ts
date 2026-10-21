import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { draftChange, relevantMap } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot } from "./helpers.js";

/** The Forge change with only its brief: what `atticus change draft` starts from. */
async function briefOnly(): Promise<string> {
  const root = await forgeChangeRoot();
  const dir = changeDir(root);
  for (const f of [
    "proposal.md",
    "specs",
    "interfaces.md",
    "data.md",
    "design.md",
    "mappings.md",
    "ux.md",
  ])
    await rm(join(dir, f), { recursive: true, force: true });
  return root;
}

const GOOD = `=== proposal.md
# Proposal

## Why

Portal customers can send any amount in a day; two accounts were drained last month.

## What Changes

- ledger-api refuses a transfer over the account's daily limit on POST /transfers.
- ledger-api answers GET /accounts/{id}/limit with what is left today.

## Capabilities

### New Capabilities
- \`transfer-limits\`: a daily transfer limit per account

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| ledger | modified | checks and stores the limit |
| portal | modified | shows the remaining limit |

## Impact

POST /transfers gains an error; one new call from portal-bff to ledger-api.

## Open questions

- Does the limit reset at midnight in the account's time zone? (product owner)
=== specs/transfer-limits/spec.md
## ADDED Requirements

### Requirement: Daily transfer limit
The system SHALL refuse a transfer that would take an account over its daily limit.

#### Scenario: Transfer over the limit
- **WHEN** an account with a limit of 1000 has sent 900 today and asks to send 200
- **THEN** the transfer is refused with error LIMIT_EXCEEDED
=== interfaces.md
# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| if-d99f508a2ac9b6e0 | portal-bff | ledger-api | S.GW.SOR | POST /transfers | none | planned-modify |
| new | portal-bff | ledger-api | S.GW.SRO | GET /accounts/{id}/limit | none | planned-new |
`;

/** A first draft with mistakes the checks catch: an unknown service, an untested requirement. */
const BAD = GOOD.replace(
  "| new | portal-bff | ledger-api | S.GW.SRO | GET /accounts/{id}/limit | none | planned-new |",
  "| new | portal-bff | limits-svc | S.GW.SRO | GET /limits/{id} | none | planned-new |\n| if-0000000000000000 | portal-bff | ledger-api | S.GW.SOR | GET /x | none | planned-modify |",
).replace(
  "#### Scenario: Transfer over the limit\n- **WHEN** an account with a limit of 1000 has sent 900 today and asks to send 200\n- **THEN** the transfer is refused with error LIMIT_EXCEEDED",
  "",
);

describe("relevantMap", () => {
  it("finds the part of the catalog a brief is about: endpoints, callers, tables and systems", async () => {
    const root = await briefOnly();
    const brief = await readFile(join(changeDir(root), "brief.md"), "utf8");
    const { records } = await (await import("@maycombhq/changes")).loadChangeContext(root);
    const text = relevantMap(records, brief).text;
    // Hand-written: the transfer endpoint and its caller, and the store that holds accounts.
    expect(text).toContain("POST /transfers");
    expect(text).toContain("ledger-api");
    expect(text).toContain("portal-bff");
    expect(text).toMatch(/table ledger-db\.account\b/);
    expect(text).toMatch(/system ledger\b/);
  });
});

describe("draftChange", () => {
  it("drafts the proposal, spec and interfaces from the brief and the map, checked before they are written", async () => {
    const root = await briefOnly();
    const prompts: string[] = [];
    let n = 0;
    const mock = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return n++ === 0 ? BAD : GOOD;
      },
      { now: () => new Date(NOW) },
    );
    const r = await draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW) });
    expect(r.state).toBe("written");
    expect(r.attempts).toBe(2);
    // The first draft's problems went back to the assistant, in plain words.
    expect(prompts[1]).toContain("limits-svc isn't in the catalog");
    expect(prompts[1]).toContain("if-0000000000000000 isn't an interface in the catalog");
    expect(prompts[1]).toContain('Requirement "Daily transfer limit" has no scenario');
    // The brief and the map went in as data.
    expect(prompts[0]).toContain("POST /transfers");
    expect(r.files.sort()).toEqual([
      "interfaces.md",
      "proposal.md",
      "specs/transfer-limits/spec.md",
    ]);
    const proposal = await readFile(join(changeDir(root), "proposal.md"), "utf8");
    expect(proposal).toMatch(/^<!-- Drafted by atticus change draft/);
    expect(proposal).toContain("## What Changes");
    expect(r.problems).toEqual([]);
  });

  it("keeps what a person wrote, and writes nothing outside the change's design files", async () => {
    const root = await briefOnly();
    await writeFile(join(changeDir(root), "proposal.md"), "# Proposal\n\nMine.\n");
    const mock = new MockRuntime(() => GOOD, { now: () => new Date(NOW) });
    await expect(draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW) })).rejects.toThrow(
      /a person wrote: proposal\.md.*--force/,
    );
    const sneaky = new MockRuntime(() => `${GOOD}=== ../../org-pack/runtime.yaml\nai: off\n`, {
      now: () => new Date(NOW),
    });
    const r = await draftChange(root, CHANGE, { runtime: sneaky, now: new Date(NOW), force: true });
    expect(r.state).toBe("written");
    expect(r.discarded).toEqual(["../../org-pack/runtime.yaml"]);
    expect(await readFile(join(root, "org-pack/runtime.yaml"), "utf8")).not.toBe("ai: off\n");
  });

  it("gives up after the attempts with the last problems, and writes nothing", async () => {
    const root = await briefOnly();
    const mock = new MockRuntime(() => BAD, { now: () => new Date(NOW) });
    const r = await draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW), attempts: 2 });
    expect(r.state).toBe("failed");
    expect(r.attempts).toBe(2);
    expect(r.problems.length).toBeGreaterThan(0);
    await expect(readFile(join(changeDir(root), "proposal.md"), "utf8")).rejects.toThrow();
  });

  it("refuses a brief that is still the template", async () => {
    const root = await briefOnly();
    await writeFile(
      join(changeDir(root), "brief.md"),
      "# X\n\n## Problem\n\n<!-- Who has the problem -->\n",
    );
    const mock = new MockRuntime(() => GOOD, { now: () => new Date(NOW) });
    await expect(draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW) })).rejects.toThrow(
      /brief\.md/,
    );
  });
});

describe("checkDraft", () => {
  it("knows a system its components name, even with no System record", async () => {
    const { checkDraft } = await import("../src/index.js");
    const records = [
      { kind: "Component", id: "chat-api", system: "chatter" },
    ] as unknown as Parameters<typeof checkDraft>[1];
    const files = new Map([
      [
        "proposal.md",
        "# Proposal\n\n## Why\n\nx\n\n## What Changes\n\n- y\n\n## Systems\n\n| System (catalog id) | New, modified or retired | Why |\n| --- | --- | --- |\n| chatter | modified | z |\n",
      ],
      [
        "specs/a/spec.md",
        "## ADDED Requirements\n\n### Requirement: A\nThe system SHALL a.\n\n#### Scenario: B\n- **WHEN** c\n- **THEN** d\n",
      ],
      [
        "interfaces.md",
        "| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |\n| --- | --- | --- | --- | --- | --- | --- |\n| new | chatter | chat-api |  | GET /x | none | planned-new |\n",
      ],
    ]);
    expect(checkDraft(files, records)).toEqual([]);
  });
});

describe("planning a drafted design in a repo with modules", () => {
  it("links behaviour-level requirements to the call they need, and tasks name each module's part", async () => {
    const { planStories } = await import("../src/index.js");
    const root = await briefOnly();
    // ledger-api and portal-bff built in one repo, as modules are.
    for (const id of ["ledger-api", "portal-bff"]) {
      const p = join(root, "catalog/generated/component", `${id}.yaml`);
      await writeFile(p, (await readFile(p, "utf8")).replace(/^repo: .*$/m, "repo: forge-mono"));
    }
    const mock = new MockRuntime(() => GOOD, { now: () => new Date(NOW) });
    expect((await draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW) })).state).toBe(
      "written",
    );
    const r = await planStories(root, CHANGE, { draft: true, now: new Date(NOW) });
    const s1 = r.skeleton.stories.find((s) => s.requirement?.name === "Daily transfer limit")!;
    // The requirement never names a path, but it is the transfer call's behaviour.
    expect(s1.interfaces.map((i) => i.operation)).toContain("POST /transfers");
    expect(s1.repos).toEqual(["forge-mono"]);
    // The task says what each module in the repo does, not "update the screens".
    const t = r.skeleton.tasks.find((x) => x.story === s1.id)!;
    expect(t.title).toMatch(
      /^Change POST \/transfers in ledger-api; update the call to POST \/transfers from portal-bff/,
    );
    expect(r.skeleton.tasks.map((x) => x.title).join("\n")).not.toContain("ux.md");
  });

  it("names a task by its requirement when two stories share the same work", async () => {
    const { planStories } = await import("../src/index.js");
    const root = await briefOnly();
    const mock = new MockRuntime(() => GOOD, { now: () => new Date(NOW) });
    await draftChange(root, CHANGE, { runtime: mock, now: new Date(NOW) });
    const spec = join(changeDir(root), "specs/transfer-limits/spec.md");
    await writeFile(
      spec,
      `${await readFile(spec, "utf8")}\n### Requirement: Transfer limit per account\nThe system SHALL keep each account's own limit.\n\n#### Scenario: Two accounts\n- **WHEN** two accounts have limits of 100 and 200\n- **THEN** each transfer is checked against its own account's limit\n`,
    );
    const r = await planStories(root, CHANGE, { draft: true, now: new Date(NOW) });
    const titles = r.skeleton.tasks.map((t) => `${t.repo} ${t.title}`);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.some((t) => t.includes("Transfer limit per account: "))).toBe(true);
  });
});
