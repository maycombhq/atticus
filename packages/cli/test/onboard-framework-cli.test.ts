import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRuntime } from "@maycombhq/ai";
import { FrameworkModel } from "@maycombhq/core";
import { baseClonePath } from "@maycombhq/workspace";
import { main } from "../src/main.js";
import {
  onboardAccept,
  onboardFramework,
  onboardFrameworkAccept,
  onboardFrameworkCheck,
} from "../src/onboard-commands.js";

const CASE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/onboard-eval/harbor-kit",
);
const KIT = join(CASE, "repos/harbor-kit");
const NOW = new Date("2026-10-20T12:00:00Z");
const T = 180_000;
const reply = () => readFile(join(CASE, "assistant-reply.yaml"), "utf8");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

/** A metarepo for the invented Harbor estate, its two services cloned (as git repos). */
async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-onboard-fw-"));
  const op = join(root, "org-pack");
  await mkdir(join(op, "profiles/harbor"), { recursive: true });
  await writeFile(
    join(op, "pack.yaml"),
    "schemaVersion: 1\nname: harbor\nversion: 0.1.0\nowner: team-platform\n",
  );
  await writeFile(
    join(op, "profiles/harbor/repos.manifest.yaml"),
    [
      "schemaVersion: 1",
      "platform: harbor",
      "repos:",
      ...["harbor-orders", "harbor-billing"].flatMap((id) => [
        `  - id: ${id}`,
        `    url: https://git.example.com/harbor/${id}.git`,
        "    type: spring-boot",
        "    owner: team-harbor",
      ]),
      "",
    ].join("\n"),
  );
  for (const id of ["harbor-orders", "harbor-billing"]) {
    const dir = baseClonePath(root, id);
    await cp(join(CASE, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return root;
}

describe("atticus onboard framework (ADR 0066)", () => {
  it(
    "the scan names the house framework; onboarding learns it, the assistant completes it, a person accepts it",
    async () => {
      const root = await estate();
      const before = capture();
      await main(["scan", "--root", root, "--dry-run"], before.io);
      expect(before.out).toContain(
        "House framework harbor.kit is imported by 2 repos and no framework model covers it: harbor-billing, harbor-orders. Onboard it: atticus onboard framework harbor-kit --from <its source, JAR or package> --users harbor-billing,harbor-orders",
      );

      const good = await reply();
      // The first answer claims code as the source of a URL it read in a properties file.
      const bad = good.replace(
        'source: { kind: document, ref: "harbor-kit:src/main/resources/harbor-systems.properties" }\n  Systems.NOTIFY',
        "source: { kind: code }\n  Systems.NOTIFY",
      );
      const replies = [bad, good];
      let n = 0;
      const runtime = new MockRuntime(() => replies[n++]!, { now: () => NOW });
      const c = capture();
      expect(
        await onboardFramework(
          root,
          "harbor-kit",
          { from: KIT, users: ["harbor-orders", "harbor-billing"] },
          { runtime, now: NOW },
          c.io,
        ),
      ).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out).toEqual([
        "Learned from its source: 2 annotations, 1 call, 0 routes, 2 constants (verified: no draft changes them).",
        "Attempt 1: 1 problem, handed back:",
        "  - service Systems.LEDGER: source code is only for what Atticus read itself; cite the document or person its meaning came from (kind: document or person, with a ref)",
        "Drafted proposals/frameworks/harbor-kit.yaml in 2 attempts: 4 entries drafted by your assistant over what was learned; its tests pass.",
        "On harbor-orders it reads 4 records the repo doesn't give without it:",
        "  endpoint GET /orders/{id} verified",
        "  http-call POST https://ledger.harbor.internal/ledger/entries  (drafted)",
        "  http-call POST https://notify.harbor.internal/notifications/orders  (drafted)",
        "  pipeline harbor-orders.pipeline.jenkinsfile: stages Smoke tests; environments prod; deployTargets helm; testSteps smoke tests  (drafted)",
        "On harbor-billing it reads 3 records the repo doesn't give without it:",
        "  endpoint GET /invoices/{number} verified",
        "  http-call POST https://ledger.harbor.internal/ledger/invoices  (drafted)",
        "  pipeline harbor-billing.pipeline.jenkinsfile: stages Smoke tests; environments uat; deployTargets helm; testSteps smoke tests  (drafted)",
        "Review the drafted entries first (inferred until a person confirms them): client Dock.relay (document harbor-kit:src/main/java/harbor/kit/http/Dock.java); service Systems.LEDGER (document harbor-kit:src/main/resources/harbor-systems.properties); service Systems.NOTIFY (document harbor-kit:src/main/resources/harbor-systems.properties); pipeline step harborDeploy (document harbor-kit:vars/harborDeploy.groovy).",
        "It is a proposal: nothing scans with it yet. Review it, then: atticus onboard accept framework harbor-kit",
      ]);
      // A proposal isn't used: the scan still names the framework.
      const still = capture();
      await main(["scan", "--root", root, "--dry-run"], still.io);
      expect(still.out.some((l) => l.startsWith("House framework harbor.kit"))).toBe(true);

      const ok = capture();
      expect(await onboardFrameworkAccept(root, "harbor-kit", {}, ok.io)).toBe(0);
      expect(ok.out).toEqual([
        "Accepted: org-pack/frameworks/harbor-kit.yaml. Scans read every repo that imports harbor.kit through it. Commit the org pack for review, as with any change to it.",
      ]);
      const model = FrameworkModel.parse(
        parse(await readFile(join(root, "org-pack/frameworks/harbor-kit.yaml"), "utf8")),
      );
      expect(model.constants["Systems.LEDGER"]!.source.kind).toBe("code");
      expect(model.services["Systems.LEDGER"]!.source.kind).toBe("document");

      const after = capture();
      await main(["scan", "--root", root, "--json", "--dry-run"], after.io);
      const json = JSON.parse(after.out.join("\n")) as {
        unmodelled: unknown[];
        problems: unknown[];
      };
      expect([json.unmodelled, json.problems]).toEqual([[], []]);
    },
    T,
  );

  it(
    "finds the repos that use it when --users is left out, and with AI off proposes what was learned",
    async () => {
      const root = await estate();
      const c = capture();
      expect(await onboardFramework(root, "harbor-kit", { from: KIT }, {}, c.io)).toBe(0);
      expect(c.out[1]).toBe(
        "Wrote proposals/frameworks/harbor-kit.yaml from the learner alone (AI off): it reads the repos that use it.",
      );
      expect(c.out).toContain(
        "On harbor-orders it reads 2 records the repo doesn't give without it:",
      );
      const text = await readFile(join(root, "proposals/frameworks/harbor-kit.yaml"), "utf8");
      expect(text).toMatch(/and 0 drafted/);
    },
    T,
  );

  it(
    "hands off: the learned model waits in proposals/, the assistant adds to it, check confirms code entries with --from",
    async () => {
      const root = await estate();
      const waiting = {
        kind: "hand-off",
        prepare: async () => ({ runId: "run-1" }),
        run: async () => ({ runId: "run-1", state: "waiting", errors: [] }),
      } as unknown as AiRuntime;
      const c = capture();
      expect(
        await onboardFramework(
          root,
          "harbor-kit",
          { from: KIT, users: ["harbor-orders", "harbor-billing"] },
          { runtime: waiting, now: NOW },
          c.io,
        ),
      ).toBe(0);
      expect(c.out.at(-1)).toBe(
        `Handed to your assistant (run run-1). proposals/frameworks/harbor-kit.yaml holds what was learned; the assistant adds to it, then check it: atticus onboard check framework harbor-kit --from ${KIT} --users harbor-orders,harbor-billing`,
      );
      // The assistant adds its entries to the file (here: the whole reference model).
      const file = join(root, "proposals/frameworks/harbor-kit.yaml");
      await writeFile(file, await readFile(join(CASE, "reference.yaml"), "utf8"));
      const noFrom = capture();
      expect(
        await onboardFrameworkCheck(root, "harbor-kit", { users: ["harbor-orders"] }, noFrom.io),
      ).toBe(1);
      expect(noFrom.err.at(-1)).toBe(
        "Entries citing code or bytecode are confirmed by reading the framework again: give --from <its source, JAR or package>.",
      );
      const ok = capture();
      expect(
        await onboardFrameworkCheck(
          root,
          "harbor-kit",
          { from: KIT, users: ["harbor-orders", "harbor-billing"] },
          ok.io,
        ),
      ).toBe(0);
      expect(ok.out[0]).toBe(
        "proposals/frameworks/harbor-kit.yaml passes (rewritten with what the learner read): its tests pass, and it reads the repos that use it.",
      );
      expect(await readFile(file, "utf8")).toMatch(/^# A proposal \(ADR 0066\): 5 entries/);
    },
    T,
  );

  it(
    "accepting needs --replace over a model already there; onboard accept finds a framework proposal",
    async () => {
      const root = await estate();
      await onboardFramework(root, "harbor-kit", { from: KIT }, {}, capture().io);
      await mkdir(join(root, "org-pack/frameworks"), { recursive: true });
      await writeFile(
        join(root, "org-pack/frameworks/harbor-kit.yaml"),
        "schemaVersion: 1\nname: harbor-kit\npackages: [harbor.kit]\n",
      );
      const no = capture();
      expect(await onboardAccept(root, "harbor-kit", {}, no.io)).toBe(1);
      expect(no.err).toEqual([
        "org-pack/frameworks/harbor-kit.yaml exists; use --replace to replace it.",
      ]);
      expect(await onboardAccept(root, "harbor-kit", { replace: true }, capture().io)).toBe(0);
      expect(
        await stat(join(root, "proposals/frameworks/harbor-kit.yaml")).catch(() => undefined),
      ).toBeUndefined();
      expect(await onboardFrameworkAccept(root, "nope", {}, capture().io)).toBe(2);
    },
    T,
  );

  it(
    "refuses a bad name, a source that isn't there, and repos that aren't cloned",
    async () => {
      const root = await estate();
      const r = new MockRuntime(() => "", { now: () => NOW });
      expect(
        await onboardFramework(root, "Bad Name", { from: KIT }, { runtime: r }, capture().io),
      ).toBe(2);
      expect(
        await onboardFramework(
          root,
          "harbor-kit",
          { from: join(root, "nowhere") },
          { runtime: r },
          capture().io,
        ),
      ).toBe(2);
      const c = capture();
      expect(
        await onboardFramework(
          root,
          "harbor-kit",
          { from: KIT, users: ["nope"] },
          { runtime: r },
          c.io,
        ),
      ).toBe(2);
      expect(c.err[0]).toMatch(/^nope isn't a cloned repo of the manifest or a folder/);
    },
    T,
  );

  it(
    "the scan lists a model for re-drafting where it reads nothing any more",
    async () => {
      const root = await estate();
      await mkdir(join(root, "org-pack/frameworks"), { recursive: true });
      await writeFile(
        join(root, "org-pack/frameworks/harbor-kit.yaml"),
        "schemaVersion: 1\nname: harbor-kit\npackages: [harbor.kit]\nannotations:\n  - { name: HarborService, means: [RestController], source: { kind: person, ref: '@harbor-platform' } }\n",
      );
      const c = capture();
      await main(["scan", "--root", root, "--dry-run"], c.io);
      expect(c.out).toContain(
        "Framework model harbor-kit read nothing in harbor-orders, harbor-billing, which import it; the framework may have changed. Have your assistant re-draft it: atticus onboard framework harbor-kit --from <its source, JAR or package> --users harbor-orders,harbor-billing (then onboard accept framework harbor-kit --replace)",
      );
    },
    T,
  );
});
