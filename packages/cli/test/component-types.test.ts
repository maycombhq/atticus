import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import {
  typesAddCommand,
  typesListCommand,
  typesNotesCommand,
  uiComponentTypeRoutes,
} from "../src/component-type-commands.js";
import {
  componentTypeRulesText,
  componentTypesAt,
  componentTypesText,
} from "../src/component-types.js";

/**
 * Component types the organisation owns (ADR 0180): listed, added and read from the command line
 * and the app; the text a read and a stage are handed. On the invented Forge fixture pack.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/component-types");
let root: string;
let srv: RunningServer;
const io = () => {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`! ${l}`) } };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-types-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiComponentTypeRoutes(r, ctx) });
});
afterAll(() => srv?.close());

describe("the organisation's component types", () => {
  it("lists the built-ins with the pack's own, reworded and switched off applied, with notes", async () => {
    const r = await fetch(`${srv.url}/api/component-types`, {
      headers: { "X-Atticus-Token": srv.token },
    });
    expect(r.status).toBe(200);
    const v = Api.ComponentTypesView.parse(await r.json());
    expect(v.folder).toBe("org-pack/component-types");
    expect(v.types.some((t) => t.id === "ml-model")).toBe(false);
    const xp = v.types.find((t) => t.id === "forge-experience-api")!;
    expect(xp).toMatchObject({
      source: "org-pack",
      draws: { shape: "rounded", badge: "xp" },
      file: "org-pack/component-types/forge-experience-api/type.yaml",
    });
    expect(xp.notes).toContain("# Experience APIs at Forge");
    expect(xp.mustNot).toHaveLength(2);
    expect(v.types.find((t) => t.id === "gateway")).toMatchObject({
      name: "Forge gateway proxy",
      source: "org-pack",
      draws: { shape: "diamond", badge: "gw" },
    });
    expect(v.types.find((t) => t.id === "service")).toMatchObject({ source: "builtin" });
    const l = io();
    expect(await typesListCommand(root, {}, l.io)).toBe(0);
    expect(l.out[0]).toContain("component types (2 the organisation's own or reworded");
    expect(l.out.join("\n")).toContain("forge-experience-api [xp]");
  });

  it("hands a read the types as data with their signals, and a stage what each must and must not do", async () => {
    const types = await componentTypesAt(root);
    const text = componentTypesText(types);
    expect(text).toContain('<atticus-data id="component-types"');
    expect(text).toContain('forge-experience-api: "A Forge channel-facing API');
    expect(text).toContain('dependency "@forge/experience-kit"');
    expect(text).not.toContain("ml-model:");
    const rules = componentTypeRulesText(types, "org-pack");
    expect(rules).toContain(
      'forge-experience-api ("Experience API"): notes in "org-pack/component-types/forge-experience-api/notes.md"',
    );
    expect(rules).toContain(
      '  must not: "An experience API never writes a system-of-record table."',
    );
    expect(rules).toContain('gateway ("Forge gateway proxy")');
  });

  it("adds a type with its notes file, refuses a second with the same id, and shows notes", async () => {
    const a = io();
    expect(
      await typesAddCommand(
        root,
        "forge-rules-engine",
        {
          name: "Rules engine",
          description: "Evaluates Forge decision tables.",
          badge: "rul",
          shape: "hexagon",
        },
        a.io,
      ),
    ).toBe(0);
    const text = await readFile(
      join(root, "org-pack/component-types/forge-rules-engine/type.yaml"),
      "utf8",
    );
    expect(text).toContain("id: forge-rules-engine");
    expect(text).toContain("badge: rul");
    expect(
      await readFile(join(root, "org-pack/component-types/forge-rules-engine/notes.md"), "utf8"),
    ).toContain("# Rules engine");
    expect((await componentTypesAt(root)).some((t) => t.id === "forge-rules-engine")).toBe(true);
    expect(
      await typesAddCommand(root, "forge-rules-engine", { name: "x", description: "y" }, io().io),
    ).toBe(2);
    expect(await typesAddCommand(root, "Bad Id", { name: "x", description: "y" }, io().io)).toBe(2);
    // Any record id the schema takes: dots and underscores too.
    expect(
      await typesAddCommand(
        root,
        "forge.rules_v2",
        { name: "Rules v2", description: "z" },
        io().io,
      ),
    ).toBe(0);
    expect((await componentTypesAt(root)).some((t) => t.id === "forge.rules_v2")).toBe(true);
    expect(
      await typesAddCommand(root, "ok", { name: "x", description: "y", shape: "blob" }, io().io),
    ).toBe(2);
    const n = io();
    expect(await typesNotesCommand(root, "forge-experience-api", n.io)).toBe(0);
    expect(n.out[0]).toContain("# Experience APIs at Forge");
    const b = io();
    expect(await typesNotesCommand(root, "service", b.io)).toBe(0);
    expect(b.out[0]).toContain("an Atticus built-in");
    expect(await typesNotesCommand(root, "nope", io().io)).toBe(2);
  });
});
