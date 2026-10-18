import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createOpenSpec,
  extractJson,
  isSupportedVersion,
  openspecEnv,
  OpenSpecError,
} from "../src/index.js";

/** A stand-in OpenSpec CLI that prints fixed output, for error paths the real CLI can't produce on demand. */
async function fakeBin(script: string): Promise<{ bin: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-fake-openspec-"));
  const bin = join(dir, "openspec.js");
  await writeFile(bin, script, "utf8");
  return { bin, root: dir };
}

describe("openspecEnv", () => {
  it("turns off telemetry, update checks, colour and prompts", () => {
    const env = openspecEnv({ PATH: "/bin", DO_NOT_TRACK: "0" });
    expect(env).toMatchObject({
      PATH: "/bin",
      DO_NOT_TRACK: "1",
      OPENSPEC_TELEMETRY: "0",
      OPENSPEC_NO_UPDATE_CHECK: "1",
      OPENSPEC_NO_AUTO_CONFIG: "1",
      OPENSPEC_NO_COMPLETIONS: "1",
      NO_COLOR: "1",
    });
  });
});

describe("version checks", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("1.14.0", "1.13.2")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(compareVersions("v1.14.0", "1.14.0")).toBe(0);
  });

  it("accepts the supported range only", () => {
    for (const v of ["1.13.0", "1.14.0", "1.99.3"]) expect(isSupportedVersion(v), v).toBe(true);
    for (const v of ["1.12.9", "2.0.0", "2.0.0-beta.1", "garbage", ""])
      expect(isSupportedVersion(v), v).toBe(false);
  });

  it("refuses an unsupported installed version", async () => {
    const { bin, root } = await fakeBin(`process.stdout.write("2.1.0\\n");`);
    const os = createOpenSpec({ root, bin });
    await expect(os.assertSupported()).rejects.toMatchObject({ code: "unsupported_version" });
  });
});

describe("extractJson", () => {
  it("skips a notice line before the JSON", () => {
    expect(extractJson('Note: Schema commands are experimental.\n{"a":1}\n')).toEqual({ a: 1 });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
    expect(() => extractJson("nothing here")).toThrow();
  });
});

describe("error handling", () => {
  it("raises OpenSpec's own error code from its error envelope", async () => {
    const { bin, root } = await fakeBin(
      `process.stdout.write(JSON.stringify({status:[{severity:"error",code:"change_error",message:"Change 'x' not found"}]}));process.exit(1);`,
    );
    const err = await createOpenSpec({ root, bin })
      .status("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenSpecError);
    expect(err).toMatchObject({
      code: "change_error",
      message: "Change 'x' not found",
      exitCode: 1,
    });
  });

  it("reports output that breaks the adapter contract", async () => {
    const { bin, root } = await fakeBin(
      `process.stdout.write(JSON.stringify({changes:[{name:"x"}]}));`,
    );
    await expect(createOpenSpec({ root, bin }).listChanges()).rejects.toMatchObject({
      code: "contract_mismatch",
    });
  });

  it("reports output with no JSON", async () => {
    const { bin, root } = await fakeBin(`process.stderr.write("boom");process.exit(3);`);
    await expect(createOpenSpec({ root, bin }).listSpecs()).rejects.toMatchObject({
      code: "bad_output",
      exitCode: 3,
    });
  });

  it("refuses a result from a different OpenSpec root", async () => {
    const { bin, root } = await fakeBin(
      `process.stdout.write(JSON.stringify({specs:[],root:{path:"/somewhere/else",source:"nearest"}}));`,
    );
    await expect(createOpenSpec({ root, bin }).listSpecs()).rejects.toMatchObject({
      code: "root_mismatch",
    });
  });

  it("refuses ids that are not slugs before running anything", async () => {
    const { bin, root } = await fakeBin(`process.exit(9);`);
    const os = createOpenSpec({ root, bin });
    await expect(os.status("../etc")).rejects.toMatchObject({ code: "bad_id" });
    await expect(os.newChange("Add Thing")).rejects.toMatchObject({ code: "bad_id" });
  });

  it("passes the safe environment to OpenSpec", async () => {
    const { bin, root } = await fakeBin(
      `process.stdout.write(JSON.stringify({specs:[{id:process.env.DO_NOT_TRACK+process.env.OPENSPEC_TELEMETRY,requirementCount:0}]}));`,
    );
    const specs = await createOpenSpec({ root, bin, env: { DO_NOT_TRACK: "0" } }).listSpecs();
    expect(specs[0]!.id).toBe("10");
  });
});
