import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManualGitHost, ManualServiceDesk, fileStepStore } from "@maycombhq/adapters";
import { loadOrgPack } from "@maycombhq/core";
import { REFERENCE_EXECUTOR, inputsSha256 } from "@maycombhq/executors";
import { executorsCheck, todoDone, todoList, todoRun, todoShow } from "../src/todo-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-10-21T09:00:00Z";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const PROCEDURE = `schemaVersion: 1
id: firewall-rule
name: Raise a network firewall rule request
system: service-desk
template: firewall-rule
steps:
  - id: submit-request
    name: Fill in and submit the request
    kind: submit-request
    writes: true
    inputs: { type: object, required: [sourceApp] }
    outputs: { type: object, required: [requestNumber] }
executors: { allowed: [ref] }
source: inputs/wiki/snow-firewall-request.md
status: active
`;

/** A metarepo with two manual steps: a firewall request and a hand-off PR. */
async function root() {
  const r = await mkdtemp(join(tmpdir(), "atticus-todo-cli-"));
  await mkdir(join(r, "org-pack/process/procedures"), { recursive: true });
  await cp(
    join(HERE, "../../../fixtures/forge/metarepo/org-pack/process/snow"),
    join(r, "org-pack/process/snow"),
    {
      recursive: true,
    },
  );
  await writeFile(join(r, "org-pack/process/procedures/firewall-rule.yaml"), PROCEDURE);
  await mkdir(join(r, "openspec/changes/add-transfer-limit"), { recursive: true });
  const pack = await loadOrgPack(join(r, "org-pack"));
  const store = fileStepStore(r);
  await new ManualServiceDesk({ store, procedures: pack.procedures, now: () => NOW }).submitRequest(
    {
      templateId: "firewall-rule",
      type: "Network firewall rule",
      changeId: "add-transfer-limit",
      fields: {
        "Source app": "gw-northwind-v2",
        "Destination host": "api.northwind.example",
        Port: "443",
      },
    },
    { by: "dana", at: NOW, ref: "snow" },
  );
  await new ManualGitHost({ store, now: () => "2026-10-21T09:30:00Z" }).createPullRequest(
    {
      repo: "forge/forge-metarepo",
      head: "handoff/add-transfer-limit/plan",
      base: "main",
      title: "Plan ready",
      body: "Hand-off",
    },
    { by: "bao", at: NOW, ref: "hand-off" },
  );
  return { r, store };
}

const executors = [
  {
    name: "ref",
    transport: "command" as const,
    command: process.execPath,
    args: [REFERENCE_EXECUTOR, "--transport", "command"],
    procedures: [],
    stepKinds: [],
    fillOnly: true,
    timeoutMs: 10_000,
    tools: {},
  },
];

describe("atticus todo", () => {
  it("lists open steps across changes, shows and exports one, and records results with checks", async () => {
    const { r, store } = await root();
    const a = io();
    expect(await todoList(r, {}, a.io)).toBe(0);
    expect(a.out).toEqual(
      [
        "3 open steps:",
        "STEP                                     CHANGE              STATE  WHAT",
        'request-firewall-rule                    add-transfer-limit  open   Raise a "Network firewall rule" request in the service desk',
        "open-pr-handoff-add-transfer-limit-plan  add-transfer-limit  open   Open a pull request from handoff/add-transfer-limit/plan into main",
        "report-pr-1                              add-transfer-limit  open   Record the reviews and checks on PR 1 (Plan ready) (after open-pr-handoff-add-transfer-limit-plan)",
        "Show a step with atticus todo show <step>; record it with atticus todo done <step> --result name=value --by <you>.",
      ].map((l) => l.replace(/ +$/, "")),
    );
    const csv = io();
    expect(await todoShow(r, "request-firewall-rule", { export: "csv" }, csv.io)).toBe(0);
    expect(csv.out).toEqual([
      "Field,Value",
      "Request type,Network firewall rule",
      "Source app,gw-northwind-v2",
      "Destination host,api.northwind.example",
      "Port,443",
    ]);
    const bad = io();
    expect(
      await todoDone(
        r,
        "open-pr-handoff-add-transfer-limit-plan",
        { by: "bao", result: ["url=nope", "number=7"] },
        bad.io,
      ),
    ).toBe(2);
    expect(bad.err).toEqual([
      "The result for step open-pr-handoff-add-transfer-limit-plan isn't valid.",
      "  Pull request link: nope isn't a link",
    ]);
    const early = io();
    expect(
      await todoDone(r, "report-pr-1", { by: "bao", result: ["checksPassing=yes"] }, early.io),
    ).toBe(1);
    expect(early.err).toEqual([
      "Do step open-pr-handoff-add-transfer-limit-plan first: step report-pr-1 depends on it.",
    ]);
    const ok = io();
    expect(
      await todoDone(
        r,
        "add-transfer-limit/open-pr-handoff-add-transfer-limit-plan",
        {
          by: "bao",
          result: ["url=https://git.example.com/forge/forge-metarepo/pull/7", "number=7"],
        },
        ok.io,
        { now: () => new Date(NOW) },
      ),
    ).toBe(0);
    expect(ok.out).toEqual([
      "Recorded step open-pr-handoff-add-transfer-limit-plan: url https://git.example.com/forge/forge-metarepo/pull/7, number 7.",
    ]);
    expect((await store.get("open-pr-handoff-add-transfer-limit-plan"))!.recorded?.at).toBe(NOW);
    expect(await todoDone(r, "nope", { by: "bao" }, io().io)).toBe(1);
    expect(await todoDone(r, "report-pr-1", {}, io().io)).toBe(2);
  });

  it("runs a step with an executor only with the person's approval of the exact inputs", async () => {
    const { r, store } = await root();
    const show = io();
    expect(await todoRun(r, "request-firewall-rule", { with: "ref" }, show.io, { executors })).toBe(
      1,
    );
    const step = (await store.get("request-firewall-rule"))!;
    const sha = inputsSha256(step.inputs);
    expect(show.out.at(-1)).toBe(
      `To approve exactly these inputs: atticus todo run request-firewall-rule --with ref --approve <you> --inputs ${sha}`,
    );
    expect(show.out).toContain("  sourceApp: gw-northwind-v2");
    const wrong = io();
    expect(
      await todoRun(
        r,
        "request-firewall-rule",
        { with: "ref", approve: "dana", inputs: "0".repeat(64) },
        wrong.io,
        { executors },
      ),
    ).toBe(1);
    expect(wrong.err[0]).toContain("The approval doesn't cover these inputs");
    const run = io();
    expect(
      await todoRun(
        r,
        "request-firewall-rule",
        { with: "ref", approve: "dana", inputs: sha },
        run.io,
        {
          executors,
          now: () => new Date(NOW),
        },
      ),
    ).toBe(0);
    expect(run.out).toEqual([
      "  Opening the form",
      "  Filling in the fields",
      "ref did step request-firewall-rule.",
      expect.stringMatching(/^ {2}requestNumber: SR-\d{4}$/),
    ]);
    expect((await store.get("request-firewall-rule"))!.recorded).toMatchObject({
      by: "dana",
      via: "executor",
      executor: "ref",
    });
  });

  it("checks the configured executors", async () => {
    const { r } = await root();
    const none = io();
    expect(await executorsCheck(r, {}, none.io)).toBe(0);
    expect(none.out).toEqual([
      "No executors are configured. A person declares theirs in .atticus/executors.yaml; the org pack allows them per procedure.",
    ]);
    const a = io();
    expect(await executorsCheck(r, {}, a.io, { executors })).toBe(0);
    expect(a.out).toEqual([
      "EXECUTOR  TRANSPORT  ANSWERS      COVERS          ALLOWED FOR",
      "ref       command    yes (0.1.0)  submit-request  firewall-rule",
    ]);
  });
});
