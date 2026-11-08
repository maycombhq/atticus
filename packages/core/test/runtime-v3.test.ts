import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  copilotAcpOf,
  migrateRuntimeV3Text,
  Runtime,
  RUNTIME_SCHEMA_VERSION,
  RuntimeKind,
} from "../src/index.js";

/**
 * ADR 0171: runtime.yaml version 3 can let Atticus drive GitHub Copilot unattended through the
 * Copilot language server's Agent Client Protocol mode (`copilot-acp`), with an optional
 * `copilotAcp` section. Version 1 and 2 files read as before; one that names copilot-acp needs
 * version 3, which `atticus upgrade` writes (`runtime-v3`), changing nothing else.
 */
describe("runtime.yaml version 3 (ADR 0171)", () => {
  const base = { assistants: { allowed: ["copilot"], default: "copilot" } };

  it("is version 3, and copilot-acp is a runtime kind", () => {
    expect(RUNTIME_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(RuntimeKind.options).toContain("copilot-acp");
  });

  it("reads version 1 and 2 files as before, with no copilotAcp section", () => {
    for (const v of [1, 2]) {
      const r = Runtime.parse({ schemaVersion: v, ...base });
      expect(r.modes).toEqual({ allowed: ["hand-off"], default: "hand-off" });
      expect(r.copilotAcp).toBeUndefined();
      expect(copilotAcpOf(r)).toEqual({
        command: "npx --yes @github/copilot-language-server",
        maxTurns: 200,
        timeoutMs: 30 * 60_000,
      });
    }
  });

  it("takes copilot-acp mode and its section in version 3 only", () => {
    const acp = {
      modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
      copilotAcp: { command: "C:/tools/copilot-language-server.exe", model: "gpt-5", maxTurns: 80 },
    };
    const v2 = Runtime.safeParse({ schemaVersion: 2, ...base, ...acp });
    expect(v2.success).toBe(false);
    const said = JSON.stringify(v2.error?.issues);
    expect(said).toMatch(/copilot-acp needs schemaVersion 3 \(ADR 0171\): run atticus upgrade/);
    expect(said).toMatch(/copilotAcp needs schemaVersion 3/);
    const v3 = Runtime.parse({ schemaVersion: 3, ...base, ...acp });
    expect(v3.modes.default).toBe("copilot-acp");
    expect(copilotAcpOf(v3)).toEqual({
      command: "C:/tools/copilot-language-server.exe",
      model: "gpt-5",
      maxTurns: 80,
      timeoutMs: 30 * 60_000,
    });
  });

  it("refuses what would weaken the session's rules: there is nothing in it to allow more", () => {
    const bad = (copilotAcp: unknown) =>
      Runtime.safeParse({ schemaVersion: 3, ...base, copilotAcp }).success;
    expect(bad({ command: "" })).toBe(false);
    expect(bad({ maxTurns: 0 })).toBe(false);
    expect(bad({ timeoutMs: 500 })).toBe(false);
    // Safety rules are not configurable (rule 6): no allow list, no auto-approve.
    expect(bad({ allowCommands: ["git"] })).toBe(false);
    expect(bad({ autoApprove: true })).toBe(false);
    expect(bad({ model: "two words" })).toBe(false);
  });

  it("upgrades a file that names copilot-acp to version 3, the number only; any other file stays", () => {
    const v2 = [
      "schemaVersion: 2 # ADR 0121",
      "assistants: { allowed: [copilot], default: copilot }",
      "modes:",
      "  allowed: [hand-off, copilot-acp]",
      "  default: copilot-acp",
      "",
    ].join("\n");
    const r = migrateRuntimeV3Text(v2);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(v2.replace("schemaVersion: 2 #", "schemaVersion: 3 #"));
    expect(Runtime.safeParse(parse(r.text)).success).toBe(true);
    expect(migrateRuntimeV3Text(r.text)).toEqual({ text: r.text, changed: false });
    // A file that doesn't name it means the same at version 2: nothing to do.
    const plain = "schemaVersion: 2\nassistants: { allowed: [copilot], default: copilot }\n";
    expect(migrateRuntimeV3Text(plain)).toEqual({ text: plain, changed: false });
    // A version 1 file naming it goes straight to 3 (the version 2 step adds nothing it needs).
    const v1 =
      "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\ncopilotAcp: {}\n";
    expect(migrateRuntimeV3Text(v1).text).toMatch(/^schemaVersion: 3$/m);
    expect(migrateRuntimeV3Text("not: [yaml").changed).toBe(false);
  });
});
