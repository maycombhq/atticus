import { describe, expect, it } from "vitest";
import { isSecretPath, notDeviceName, slugify } from "../src/index.js";

/**
 * Review round 46 (Windows): NTFS opens `.env::$DATA` as `.env`, and drops a name's trailing dots
 * and spaces, so a secret's file can't hide behind either; and Windows reserves the device names
 * (con, aux, nul, prn, com1-9, lpt1-9) whatever extension follows, so no id Atticus makes is one.
 */
describe("a secret's file, as NTFS opens it", () => {
  it.each([
    ".env::$DATA",
    ".env:stream",
    "config/.env.",
    "config/.env ",
    "certs/server.key::$DATA",
    "certs\\server.key::$DATA",
    "certs/server.key.",
    "certs/server.key . ",
    "secrets./db.txt",
    "credentials:x",
  ])("%s is a secret's file", (p) => expect(isSecretPath(p)).toBe(true));

  it.each(["src/app.ts", "docs/env.md", "src/keys.ts", "src/server.keyboard.ts"])(
    "%s is not",
    (p) => expect(isSecretPath(p)).toBe(false),
  );
});

describe("ids are never a Windows device name", () => {
  it.each([
    ["AUX", "aux-1"],
    ["con", "con-1"],
    ["Nul", "nul-1"],
    ["prn", "prn-1"],
    ["COM1", "com1-1"],
    ["lpt9", "lpt9-1"],
    ["con.v2", "con-1.v2"],
  ])("slugify(%s) is %s", (text, slug) => expect(slugify(text)).toBe(slug));

  it.each(["console", "com10", "com0", "auxiliary", "my-aux", "nul-1", "lpt"])(
    "%s stays as it is",
    (text) => expect(slugify(text)).toBe(text),
  );

  it("notDeviceName suffixes only the first dot-separated part", () => {
    expect(notDeviceName("aux")).toBe("aux-1");
    expect(notDeviceName("aux.v1.yaml")).toBe("aux-1.v1.yaml");
    expect(notDeviceName("ledger.aux")).toBe("ledger.aux");
    expect(notDeviceName("")).toBe("");
  });
});
