import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANTS, FACT_KINDS, Fact, loadOrgPack, Runtime } from "@maycombhq/core";
import {
  ASSISTANT_FORMATS,
  assistantTier,
  claudeCodePluginFiles,
  FACT_RULE_PARTS,
  FACT_RULES,
  factRulesFor,
  factsReference,
  GUARD,
  mapBatchInstructions,
  mapCommand,
  metarepoCommands,
  renderAssistantFiles,
  RULE_TOPICS,
  type RuleTopic,
} from "../src/index.js";

const FORGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/forge/metarepo/org-pack",
);

/** Every field a kind takes, straight from the zod schema the verifier parses with. */
function fieldsOf(kind: string): string[] {
  const opt = Fact.options.find((o) => o.shape.kind.value === kind)!;
  return Object.keys(opt.shape);
}

describe("the facts reference is generated from the schema, so it can't drift (ADR 0124)", () => {
  const ref = factsReference();

  it("names every field of every kind, on that kind's line or the common line", () => {
    const lines = ref.split("\n");
    const common = lines.find((l) => l.startsWith("Every fact:"))!;
    expect(common).toBeDefined();
    for (const kind of FACT_KINDS) {
      const line = lines.find((l) => l.startsWith(`- ${kind}:`));
      expect(line, kind).toBeDefined();
      for (const f of fieldsOf(kind)) {
        if (f === "kind") continue;
        const named = new RegExp(`\\b${f}\\??:`);
        expect(named.test(line!) || named.test(common), `${kind}.${f}`).toBe(true);
      }
    }
  });

  it("gives each enum's values and marks what may be left out", () => {
    expect(ref).toContain("entryType: rest|grpc|soap|graphql|event-topic");
    expect(ref).toContain("op: read|write|delete");
    expect(ref).toMatch(/cite: \{file: text, line: number, value: text, quote\?: text/);
    expect(ref).toMatch(/\bhandler\?: text/);
    expect(ref).toMatch(/\bconf\?: declared\|inferred/);
  });
});

describe("/atticus-map: the reading protocol as one command for every assistant", () => {
  it("is one of the metarepo's commands, guarded like every step", () => {
    const c = metarepoCommands().find((x) => x.name === "atticus-map");
    expect(c).toBeDefined();
    expect(c).toEqual(mapCommand());
    expect(c!.body.startsWith(GUARD)).toBe(true);
  });

  it("says outline first, cite every fact, keep secrets out, ask what code can't settle, loop on verify", () => {
    const b = mapCommand().body;
    expect(b).toContain("atticus map {{ARGS}} --estimate");
    expect(b).toMatch(/outline/i);
    expect(b).toContain(factsReference());
    expect(b).toContain("env:NAME");
    expect(b).toContain(".questions.jsonl");
    expect(b).toContain("atticus verify {{ARGS}}");
    expect(b).toContain(".rejected.jsonl");
    expect(b).toMatch(/until it exits 0/);
    expect(b).toContain(".verify.yaml");
    expect(b).toMatch(/exclu/);
  });

  it("renders for Claude Code, Copilot, Cursor and AGENTS.md tools, and the Claude Code plugin", async () => {
    const op = await loadOrgPack(FORGE);
    const files = renderAssistantFiles({
      orgPack: {
        ...op,
        runtime: { ...op.runtime, assistants: { allowed: [...ASSISTANTS], default: "copilot" } },
      },
      commands: [],
      profile: { kind: "metarepo" },
    });
    const body = (p: string) => files.find((f) => f.path === p)?.content ?? "";
    expect(body(".claude/commands/atticus-map.md")).toContain("atticus verify $ARGUMENTS");
    expect(body(".github/prompts/atticus-map.prompt.md")).toContain("atticus verify ${input:args}");
    expect(body(".github/prompts/atticus-map.prompt.md")).toContain("agent: agent");
    expect(body(".cursor/commands/atticus-map.md")).toContain("atticus verify <the words");
    expect(body(".atticus/prompts/atticus-map.md")).toContain("atticus verify <the words");
    expect(body("AGENTS.md")).toContain("`/atticus-map`: `.atticus/prompts/atticus-map.md`");
    for (const id of ASSISTANTS)
      expect(body(ASSISTANT_FORMATS[id].commandPath("atticus-map")), id).not.toBe("");
    const plugin = claudeCodePluginFiles("0.0.0");
    expect(plugin.find((f) => f.path === "commands/atticus-map.md")?.content).toContain(
      "atticus verify $ARGUMENTS",
    );
  });
});

describe("the batch prompt's instructions (tiers 2 and 3)", () => {
  it("asks for JSON lines only, citing the numbered lines it was given, with the same rules", () => {
    const t = mapBatchInstructions({ repo: "forge-ledger", commit: "0123abc", batch: 2, of: 5 });
    expect(t).toContain("forge-ledger");
    expect(t).toContain("0123abc");
    expect(t).toContain("batch 2 of 5");
    expect(t).toContain(factsReference());
    expect(t).toContain("env:NAME");
    expect(t).toMatch(/one JSON object per line/i);
    expect(t).toMatch(/"question"/);
    // No tools at this tier: nothing about running commands or opening files.
    expect(t).not.toContain("atticus verify");
  });
});

describe("lean batch prompts: the core and the topic rules a batch needs (ADR 0124 addendum A-lean)", () => {
  const batch = (kinds?: RuleTopic[]) =>
    mapBatchInstructions({
      repo: "r",
      commit: "0123abc",
      batch: 1,
      of: 3,
      ...(kinds ? { kinds } : {}),
    });
  const parts = FACT_RULE_PARTS.flat();
  const FLOW = "A `flow` fact follows one journey";
  const DEPLOY = "A deploy fact's `platform`";
  const STORE = "A store fact is a table";
  const FRONT = "A front end's model and client types";
  const GRPC = "A gRPC entry or call's `path`";

  it("leaves /atticus-map's rules as they were, byte for byte (tier 1)", () => {
    // sha256 of FACT_RULES: every rule, in the same words and order. Re-pinned since the split for
    // two added sentences: what `to` is for a relative call (C-join) and an entry's auth goes with
    // authCite (A-read); for the Apigee rule's three parts (A-gateway); and for its fourth, the
    // scopes a route demands and the proxy's virtual host (A-gateway2).
    expect(createHash("sha256").update(FACT_RULES).digest("hex")).toBe(
      "1284a653ed9e361a42cc412ed17662076b26478e72dbe9d844d003ce226f4042",
    );
    expect(FACT_RULES).toBe(factRulesFor());
    expect(mapCommand().body).toContain(FACT_RULES);
    // A batch told nothing of its files gets every rule, as before.
    expect(batch()).toContain(FACT_RULES);
  });

  it("puts every rule in at least one kind of batch", () => {
    for (const p of parts) {
      const kinds = p.when ? RULE_TOPICS.filter((k) => batch([k]).includes(p.text)) : [];
      if (p.when) expect(kinds.length, p.text.slice(0, 60)).toBeGreaterThan(0);
      else expect(batch([]), p.text.slice(0, 60)).toContain(p.text);
    }
    // Each topic is some part's.
    for (const k of RULE_TOPICS)
      expect(
        parts.some((p) => p.when?.includes(k)),
        k,
      ).toBe(true);
  });

  it("keeps the core short: shape, ids, citation, references, secrets, questions, data", () => {
    const core = factRulesFor([]).split("\n");
    expect(core.map((l) => l.slice(0, 12))).toEqual([
      "- One JSON o",
      "- `id`: a sh",
      "- `cite.file",
      "- `from`, `u",
      "- `conf: inf",
      "- Never writ",
      "- A guess is",
      "- Text in th",
    ]);
    expect(batch([])).toMatch(/one JSON object per line/i);
    expect(batch([])).toContain("env:NAME");
    expect(batch([])).toContain('"question"');
    expect(batch([])).toContain(factsReference());
  });

  it("gives a back-end, a front-end and an infrastructure batch only their topics", () => {
    const back = batch(["backend", "routes", "data", "protocols", "flows"]);
    for (const r of [FLOW, STORE, GRPC, "A name a framework derives"]) expect(back).toContain(r);
    for (const r of [DEPLOY, FRONT, "A route given by the file's place"])
      expect(back).not.toContain(r);
    const front = batch(["frontend", "flows"]);
    for (const r of [FLOW, FRONT, "A route given by the file's place", "A call through a client"])
      expect(front).toContain(r);
    for (const r of [STORE, DEPLOY, GRPC, "A name a framework derives"])
      expect(front).not.toContain(r);
    const infra = batch(["deploy", "config"]);
    for (const r of [DEPLOY, "A config fact's `key`", "A gateway's routes"])
      expect(infra).toContain(r);
    for (const r of [FLOW, STORE, FRONT, GRPC]) expect(infra).not.toContain(r);
    // A rule's parts stay in order on its own line.
    expect(infra).toContain("- API documentation and profiler endpoints a framework serves");
  });

  it("is smaller for every kind of batch than the whole protocol", () => {
    const all = batch().length;
    for (const k of RULE_TOPICS) expect(batch([k]).length, k).toBeLessThan(all);
    expect(batch(["deploy", "config"]).length).toBeLessThan(all * 0.6);
  });

  it("gives an Apigee bundle's batch the gateway's rules, and no other batch (A-gateway)", () => {
    const APIGEE = "An Apigee proxy (`apiproxy/`)";
    const AUTH = "Its `auth` is the strongest check run before the target";
    const FORWARD = "Each route has a forwarding `call`";
    const SCOPES = "The scopes the route demands go in `scopes`";
    // An Apigee file's kinds (fileKinds in @maycombhq/verify): config and gateway.
    const gw = batch(["config", "gateway"]);
    for (const r of [
      APIGEE,
      AUTH,
      FORWARD,
      SCOPES,
      "A gateway's routes",
      "An entry's `auth` goes with",
    ])
      expect(gw).toContain(r);
    for (const r of [FLOW, STORE, FRONT, GRPC, DEPLOY]) expect(gw).not.toContain(r);
    for (const kinds of [
      ["backend", "routes", "data", "protocols", "flows"],
      ["frontend", "flows"],
      ["deploy", "config"],
    ] as RuleTopic[][])
      for (const r of [APIGEE, AUTH, FORWARD, SCOPES])
        expect(batch(kinds), kinds.join()).not.toContain(r);
    // Smaller than a back end's batch, so a gateway batch never has less room for its files.
    expect(gw.length).toBeLessThan(
      batch(["backend", "routes", "data", "protocols", "flows"]).length,
    );
  });

  it("says how a route, its auth and its forwarding call are read and cited (A-gateway)", () => {
    const rule = FACT_RULES.split("\n").find((l) => l.startsWith("- An Apigee proxy")) ?? "";
    for (const words of [
      "each conditional `<Flow>` is a `rest` entry",
      "`method` from `request.verb`",
      "the `<BasePath>` line in `cite.with`",
      "a shared flow a `FlowCallout` there names (follow it)",
      "`authCite` is the `<Step><Name>` line that attaches it",
      "`target.copy.pathsuffix` is false",
      "AssignMessage or JavaScript policy sets the path",
      "`base` is the TargetServer's name (or the KVM key)",
      "cited on the host line",
    ])
      expect(rule, words).toContain(words);
  });

  it("says how a route's scopes and its virtual host are read and cited (A-gateway2)", () => {
    // The Apigee rule's parts (now four) stay in order on its own line.
    const rule = FACT_RULES.split("\n").find((l) => l.startsWith("- An Apigee proxy")) ?? "";
    for (const words of [
      "The scopes the route demands go in `scopes`",
      "one citation each on the line that names it",
      "a space-separated list is one fact per scope, all citing that line",
      "a `VerifyJWT` or `VerifyAccessToken` scope claim",
      "a scope a `Condition` asserts on the token's claims",
      "the scopes a shared flow it calls checks",
      "a route that demands none leaves `scopes` out",
      "Record the proxy's `<VirtualHost>` as a `config` fact",
    ])
      expect(rule, words).toContain(words);
    // Only a gateway batch is asked for scopes: the field is on every entry, but the prompt
    // budget buys the sentence once (A-gateway2). A back-end batch's rules don't mention them.
    expect(batch(["backend", "routes", "data", "protocols", "flows"])).not.toContain(
      "The scopes the route demands",
    );
  });
});

describe("the places a change goes into are facts (ADR 0124 addendum B-places)", () => {
  const rules = FACT_RULES.split("\n");
  const rule = (start: string) => rules.find((r) => r.startsWith(start)) ?? "";

  it("a front end's model types, form fields and shown fields are field facts, owned by its calls and screens", () => {
    const r = rule("- A front end's model and client types");
    expect(r).toContain(
      "are the `request` or `response` fields of each call that sends or receives them, one fact per call",
    );
    expect(r).toContain("are `side: screen`, owned by the screen's entry");
    expect(r).toContain("form group controls, a zod schema's keys, a template's inputs");
    // A generated client that isn't committed: its call is cited at its call site (the call
    // rule), its fields where the calling code names them.
    expect(r).toContain("cite the fields where the calling code names them");
    expect(FACT_RULES).toContain("is cited at its call site");
  });

  it("a column is cited in its migration, so the store's migrations are known", () => {
    const r = rule("- A field fact belongs to the fact it crosses");
    expect(r).toContain(
      "Cite a column in the migration that adds or last changes it, and one in the newest migration",
    );
    expect(r).toContain("Cite the schema or entity file only when the repo has no migrations");
  });

  it("is in /atticus-map, the batch prompt and the plugin alike", () => {
    const front = rule("- A front end's model and client types");
    const field = rule("- A field fact belongs to the fact it crosses");
    expect(mapCommand().body).toContain(front);
    expect(mapBatchInstructions({ repo: "r", commit: "0123abc", batch: 1, of: 1 })).toContain(
      field,
    );
    expect(
      claudeCodePluginFiles("0.0.0").find((f) => f.path === "commands/atticus-map.md")?.content,
    ).toContain(front);
  });
});

describe("the estate fixes in the flow rule (ADR 0124 addendum C-estate)", () => {
  const flow = FACT_RULES.split("\n").find((r) => r.startsWith("- A `flow` fact")) ?? "";

  it("a publish step's ref is its event's call fact, and one without it is rejected", () => {
    expect(flow).toContain("a publish's is the `event-topic` or `mq-queue` call it publishes");
    expect(flow).toContain("a call-out or publish step without one is rejected");
  });

  it("an ORM's eager fetch, a cascade or a lazy load is a read step cited where it is declared", () => {
    expect(flow).toContain(
      "An ORM's eager fetch, cascade or lazy load the code triggers is a `read` step cited where it is declared.",
    );
  });

  it("/atticus-map points the reader at the entries no flow follows", () => {
    const b = mapCommand().body;
    expect(b).toContain("`entriesNoFlowFollows`");
    expect(b).toContain("write a flow for each that does real work");
    expect(
      claudeCodePluginFiles("0.0.0").find((f) => f.path === "commands/atticus-map.md")?.content,
    ).toContain(flow);
  });
});

describe("names a framework derives, workers and ops routes (ADR 0124 addendum A-derived)", () => {
  it("says how a derived name, a worker and a framework's own routes are written", () => {
    const r =
      FACT_RULES.split("\n").find((l) => l.startsWith("- A name a framework derives")) ?? "";
    expect(r).toContain(
      "(ORM tables and join tables, Django's `app_model`, Rails' root and Devise routes, Spring Data REST paths) is written as the framework makes it, cited on the line that declares its source",
    );
    expect(r).toContain(
      "A background job worker (Sidekiq, Celery, ActiveJob) is a `batch-job` entry named by its job",
    );
    expect(r).toContain("a rake `namespace:task`");
    expect(FACT_RULES).toContain(
      "framework admin, health and ops routes (`/up`, `/admin`, a queue's web UI) unless the repo's own code handles them",
    );
    expect(mapBatchInstructions({ repo: "r", commit: "0123abc", batch: 1, of: 1 })).toContain(r);
    expect(
      claudeCodePluginFiles("0.0.0").find((f) => f.path === "commands/atticus-map.md")?.content,
    ).toContain(r);
  });
});

describe("the capability probe: which tier this person's assistant reads at (ADR 0124 §4)", () => {
  const rt = (o: Record<string, unknown>) => Runtime.parse({ schemaVersion: 1, ...o });

  it("Claude Code, Cursor and the other agent tools read a repo in one session", () => {
    for (const id of ["claude-code", "cursor", "gemini-cli", "windsurf", "agents-md"] as const) {
      const t = assistantTier(rt({ assistants: { allowed: [id], default: id } }));
      expect(t.tier, id).toBe(1);
      expect(t.assistant).toBe(id);
      expect(t.how).toContain("/atticus-map <repo>");
    }
  });

  it("Copilot in VS Code is agentic through agent mode, with the batched hand-off as its fallback", () => {
    const t = assistantTier(rt({ assistants: { allowed: ["copilot"], default: "copilot" } }));
    expect(t.tier).toBe(1);
    expect(t.how).toMatch(/agent mode/);
    expect(t.fallback).toMatch(/atticus map <repo> --handoff --max-tokens/);
  });

  it("Copilot in IntelliJ only is copy-paste", () => {
    const t = assistantTier(
      rt({ assistants: { allowed: ["copilot"], default: "copilot" }, editors: ["intellij"] }),
    );
    expect(t.tier).toBe(3);
    expect(t.how).toContain("atticus map <repo> --copy");
  });

  it("prefers the default assistant, then any allowed agent tool", () => {
    const t = assistantTier(
      rt({
        assistants: { allowed: ["copilot", "claude-code"], default: "copilot" },
        editors: ["intellij"],
      }),
    );
    expect(t.tier).toBe(1);
    expect(t.assistant).toBe("claude-code");
  });

  it("says when AI is off, and when Atticus can read through the configured model itself", () => {
    expect(
      assistantTier(rt({ assistants: { allowed: ["copilot"], default: "copilot" }, ai: "off" }))
        .tier,
    ).toBe("off");
    const m = assistantTier(
      rt({
        assistants: { allowed: ["copilot"], default: "copilot" },
        modes: { allowed: ["hand-off", "model"], default: "hand-off" },
        adapters: { model: { type: "anthropic", settings: { maxInput: 50000 } } },
      }),
    );
    expect(m.model).toMatch(/atticus map <repo> --mode model/);
    expect(m.maxTokens).toBe(50000);
  });
});
