import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conformChange } from "../src/index.js";
import { CHANGE, git, sh, speckitRoot, worktree } from "./helpers.js";

/**
 * ADR 0206 point 2, built in the review: a deployment or a route of a repo may be declared in
 * another repo the operation names (a deploy repo's descriptor, its `exposes` naming the repo's
 * component). That repo is scanned at its branch's commit too, even when only this repo is
 * checked, and its verified facts count for this repo's claims, cited in their own repo. Real git
 * on local folders, no scan injected, no network; the Forge names are invented.
 */

const T = 300_000;
const CHANGES = `openspec/changes/${CHANGE}`;

const OPERATIONS = `schemaVersion: 1
change: ${CHANGE}
operations:
  - id: deploy-anvil
    kind: deployment
    repos: [forge-ledger, forge-infra]
    what: Deploy the ledger on Anvil, its descriptor in forge-infra.
    sets: { platform: anvil, env: prod }
  - id: route-anvil
    kind: route
    repos: [forge-ledger, forge-infra]
    what: Serve the ledger at its Anvil host.
    sets: { host: ledger.anvil.forge.example }
  - id: route-other
    kind: route
    repos: [forge-ledger]
    what: A route only forge-ledger is named for.
    sets: { host: ledger.anvil.forge.example }
`;

const DESCRIPTOR = [
  "apiVersion: anvil/v1",
  "kind: Service",
  "metadata:",
  "  name: ledger-anvil",
  "  platform: anvil",
  "  env: prod",
  "  host: ledger.anvil.forge.example",
  "  app: ledger-api",
  "",
].join("\n");

/** `link`: the fact cites the line that names what it exposes (line 8), as a link must. */
async function setup(link = true) {
  const { root } = await speckitRoot({ repos: ["forge-ledger", "forge-infra"] });
  await mkdir(join(root, CHANGES, "target-flows"), { recursive: true });
  await writeFile(join(root, CHANGES, "target-flows/_operations.yaml"), OPERATIONS);
  const wt = worktree(root, "forge-infra");
  await writeFile(join(wt, "k8s/ledger-anvil.yaml"), DESCRIPTOR);
  sh(wt, "add", "-A");
  sh(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "anvil");
  const commit = sh(wt, "rev-parse", "HEAD");
  await mkdir(join(root, CHANGES, "conform/facts"), { recursive: true });
  await writeFile(
    join(root, CHANGES, "conform/facts/forge-infra.jsonl"),
    JSON.stringify({
      repo: "forge-infra",
      commit,
      conf: "declared",
      kind: "deploy",
      id: "d-1",
      env: "prod",
      platform: "anvil",
      resourceName: "ledger-anvil",
      host: "ledger.anvil.forge.example",
      exposes: "ledger-api",
      cite: {
        file: "k8s/ledger-anvil.yaml",
        line: 4,
        value: "ledger-anvil",
        quote: "  name: ledger-anvil",
        with: [
          { file: "k8s/ledger-anvil.yaml", line: 5, value: "anvil" },
          { file: "k8s/ledger-anvil.yaml", line: 6, value: "prod" },
          { file: "k8s/ledger-anvil.yaml", line: 7, value: "ledger.anvil.forge.example" },
          ...(link ? [{ file: "k8s/ledger-anvil.yaml", line: 8, value: "ledger-api" }] : []),
        ],
      },
    }) + "\n",
  );
  return { root };
}

describe("a deployment declared in another repo the operation names (ADR 0206 point 2)", () => {
  it(
    "is present for the repo whose component it exposes, cited in the repo that declares it",
    async () => {
      const { root } = await setup();
      const run = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        git,
        now: "2026-11-22T09:00:00Z",
      });
      expect(run.results.map((r) => r.repo)).toEqual(["forge-ledger"]);
      const by = (op: string) => run.results[0]!.claims!.find((c) => c.from.operation === op)!;
      expect(by("deploy-anvil").outcome).toBe("present");
      expect(by("deploy-anvil").at).toEqual([
        { source: "code", repo: "forge-infra", path: "k8s/ledger-anvil.yaml", line: 4 },
      ]);
      expect(by("deploy-anvil").why).toBe("Written on the cited lines: platform anvil, env prod.");
      expect(by("route-anvil").outcome).toBe("present");
      // An operation that names only forge-ledger isn't read in forge-infra.
      expect(by("route-other").outcome).not.toBe("present");
    },
    T,
  );

  it(
    "is couldn't confirm when no line it cites names the link to the repo (the re-review's blocker)",
    async () => {
      const { root } = await setup(false);
      const run = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        git,
        now: "2026-11-22T09:00:00Z",
      });
      const deploy = run.results[0]!.claims!.find((c) => c.from.operation === "deploy-anvil")!;
      expect(deploy.outcome).toBe("unconfirmed");
      expect(deploy.what).toContain(
        "forge-infra:k8s/ledger-anvil.yaml:4 says it exposes ledger-api, but no line it cites names ledger-api or forge-ledger",
      );
    },
    T,
  );
});
