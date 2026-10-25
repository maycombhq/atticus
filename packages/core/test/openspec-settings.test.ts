import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenSpecSettings, OpenSpecSettings, orgPackJsonSchemas } from "../src/index.js";

/**
 * ADR 0126: org-pack/openspec.yaml, the optional file that turns on Atticus's use of OpenSpec's
 * beta stores. A pack without it is as before: no store is read and hand-down adds no reference.
 */

describe("openspec.yaml (ADR 0126)", () => {
  it("defaults to nothing on", () => {
    expect(OpenSpecSettings.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
      stores: [],
      referenceInRepos: false,
    });
  });

  it("names stores by path, each with an optional label, and the hand-down switch", () => {
    const s = OpenSpecSettings.parse({
      schemaVersion: 1,
      stores: [
        { path: "../forge-payments-store", label: "payments" },
        { path: "~/openspec/forge-statements" },
      ],
      referenceInRepos: true,
    });
    expect(s.stores).toEqual([
      { path: "../forge-payments-store", label: "payments" },
      { path: "~/openspec/forge-statements" },
    ]);
    expect(s.referenceInRepos).toBe(true);
  });

  it("refuses a repeated path or label, an unknown key and another version", () => {
    const twice = OpenSpecSettings.safeParse({
      schemaVersion: 1,
      stores: [{ path: "../a" }, { path: "../a" }],
    });
    expect(twice.success).toBe(false);
    const labels = OpenSpecSettings.safeParse({
      schemaVersion: 1,
      stores: [
        { path: "../a", label: "pay" },
        { path: "../b", label: "pay" },
      ],
    });
    expect(labels.success).toBe(false);
    expect(OpenSpecSettings.safeParse({ schemaVersion: 1, write: true }).success).toBe(false);
    expect(OpenSpecSettings.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  it("loads from the org pack: the defaults without the file, a problem when it doesn't read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-openspec-settings-"));
    expect(await loadOpenSpecSettings(dir)).toEqual({
      settings: { schemaVersion: 1, stores: [], referenceInRepos: false },
    });
    await writeFile(
      join(dir, "openspec.yaml"),
      "schemaVersion: 1\nstores:\n  - path: ../forge-payments-store\nreferenceInRepos: true\n",
    );
    expect(await loadOpenSpecSettings(dir)).toEqual({
      settings: {
        schemaVersion: 1,
        stores: [{ path: "../forge-payments-store" }],
        referenceInRepos: true,
      },
    });
    await writeFile(join(dir, "openspec.yaml"), "schemaVersion: 1\nstores: forge\n");
    const bad = await loadOpenSpecSettings(dir);
    expect(bad.settings).toEqual({ schemaVersion: 1, stores: [], referenceInRepos: false });
    expect(bad.problem).toMatch(/^openspec\.yaml: stores: /);
    await writeFile(join(dir, "openspec.yaml"), "stores: [\n");
    expect((await loadOpenSpecSettings(dir)).problem).toMatch(/^openspec\.yaml isn't YAML/);
  });

  it("is published as a JSON Schema with the other org-pack files", () => {
    const s = orgPackJsonSchemas() as Record<string, Record<string, unknown>>;
    expect(s.OpenSpecSettings?.title).toBe("OpenSpecSettings");
  });
});
