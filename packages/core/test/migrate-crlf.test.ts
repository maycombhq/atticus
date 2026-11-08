import { describe, expect, it } from "vitest";
import { migrateChangeTypesText } from "../src/change-types-migrate.js";
import { migrateGatesText } from "../src/gates-migrate.js";
import { migrateSourcesText } from "../src/sources-migrate.js";

/** Review round 28: `atticus upgrade` keeps a Windows file's CRLF in the files it moves up. */
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

describe("an upgraded org-pack file on Windows", () => {
  it("keeps CRLF in gates.yaml, change-types.yaml and sources.yaml, and LF where it was LF", () => {
    const gates = migrateGatesText(crlf("schemaVersion: 1\n# our gates\ngates:\n  - id: plan\n"));
    expect(gates.changed).toBe(true);
    expect(gates.text).toContain("\r\n");
    expect(gates.text.replace(/\r\n/g, "")).not.toContain("\n");
    const types = migrateChangeTypesText(crlf("schemaVersion: 1\ntypes:\n  - id: feature\n"));
    expect(types.text.replace(/\r\n/g, "")).not.toContain("\n");
    const sources = migrateSourcesText(crlf("schemaVersion: 1\n# wikis\nwikis: []\n"));
    expect(sources.text).toBe(crlf("schemaVersion: 3\n# wikis\nwikis: []\n"));
    expect(migrateSourcesText("schemaVersion: 1\nwikis: []\n").text).toBe(
      "schemaVersion: 3\nwikis: []\n",
    );
  });
});
