import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * J1 (ADR 0143): `atticus verify <deploy repo>` checks each Route's host and base path on its
 * lines and the component it names against the manifest; `--write` joins them with the manifest's
 * hosts and base paths, and a conflict between the two is a finding in its output and in the
 * verify report, never a silent override. On the bank-shaped estate of fixtures/link-estate.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const REPO = "forge-deploy-config";
const MANIFEST = join("org-pack", "profiles", "forge", "repos.manifest.yaml");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

function metarepo(edit?: { manifest?: (s: string) => string; facts?: (s: string) => string }) {
  const root = mkdtempSync(join(tmpdir(), "atticus-exposure-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  cpSync(join(FIX, "repos", REPO), join(root, "workspace", REPO), { recursive: true });
  if (edit?.manifest) {
    const p = join(root, MANIFEST);
    writeFileSync(p, edit.manifest(readFileSync(p, "utf8")));
  }
  if (edit?.facts) {
    const p = join(root, "facts", `${REPO}.jsonl`);
    writeFileSync(p, edit.facts(readFileSync(p, "utf8")));
  }
  return root;
}
const verify = (root: string, write: boolean, c = capture()) =>
  verifyCommand(root, REPO, { commit: "e5e0010", dir: join(root, "workspace", REPO), write }, c.io);

describe("atticus verify: exposure facts in a deploy repo", () => {
  it("keeps every Route, the templated one cited on its values file", async () => {
    const c = capture();
    expect(await verify(metarepo(), false, c)).toBe(0);
    expect(c.err).toEqual([]);
  });

  it("rejects a Route naming no component the manifest lists", async () => {
    const root = metarepo({
      facts: (s) => s.replace('"exposes":"cards-api"', '"exposes":"ghost-api"'),
    });
    const c = capture();
    expect(await verify(root, false, c)).toBe(1);
    const rejected = readFileSync(join(root, "facts", `${REPO}.rejected.jsonl`), "utf8");
    expect(rejected).toContain('"code":"exposure-component"');
    expect(rejected).toContain(
      'exposes \\"ghost-api\\", which is no component or repo of the estate',
    );
  });

  it("checks <repo>/<module> against the components the repo's facts name", async () => {
    const ok = metarepo({
      facts: (s) => s.replace('"exposes":"cards-api"', '"exposes":"forge-cards/cards-api"'),
    });
    expect(await verify(ok, false)).toBe(0);
    const root = metarepo({
      facts: (s) => s.replace('"exposes":"cards-api"', '"exposes":"forge-cards/ghost"'),
    });
    expect(await verify(root, false)).toBe(1);
    const rejected = readFileSync(join(root, "facts", `${REPO}.rejected.jsonl`), "utf8");
    expect(rejected).toContain("forge-cards's facts name no component ghost (they name cards-api)");
  });

  it("--write reports a Route that disagrees with the manifest, in its output and its verify report", async () => {
    // The manifest says the accounts service sits under /forge/accounts; its Route says otherwise.
    const root = metarepo({
      manifest: (s) =>
        s.replace(
          "    component: accounts-api\n",
          "    component: accounts-api\n    hosts: [apps.forge.internal]\n    basePath: /forge/accounts\n",
        ),
    });
    const c = capture();
    expect(await verify(root, true, c)).toBe(0);
    const msg =
      "accounts-api is reached under /forge-svc/accounts by forge-deploy-config's deploy.route.accounts-api (apps/accounts/route.yaml:4), and repos.manifest.yaml gives /forge/accounts for forge-accounts: both are joined; set the manifest's basePath to it, or correct the one that is wrong";
    expect(c.out).toContain(`Exposure: ${msg}.`);
    const report = parse(readFileSync(join(root, "facts", `${REPO}.verify.yaml`), "utf8")) as {
      exposure?: unknown;
    };
    expect(report.exposure).toEqual([
      {
        reason: "base-path-conflict",
        fact: "deploy.route.accounts-api",
        at: "apps/accounts/route.yaml:4",
        message: msg,
      },
    ]);
  });

  it("--write with the manifest and the Routes agreeing reports nothing", async () => {
    const root = metarepo();
    const c = capture();
    expect(await verify(root, true, c)).toBe(0);
    expect(c.out.filter((l) => l.startsWith("Exposure:"))).toEqual([]);
    const report = parse(readFileSync(join(root, "facts", `${REPO}.verify.yaml`), "utf8")) as {
      exposure?: unknown;
    };
    expect(report.exposure).toBeUndefined();
  });
});
