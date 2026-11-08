import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Review round 28: Edit opens with the branches the manifest has now (a reload may have brought
 * new ones), and Save sends what the form showed, so the server refuses a manifest changed since.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const sent: { path: string; body?: unknown }[] = [];
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string, o?: { body?: unknown }) => {
      sent.push({ path, body: o?.body });
      return { note: "saved" };
    },
  };
});
const { COPY } = await import("../src/copy.js");
const { RepoRow } = await import("../src/screens/run/Repos.js");
const R = COPY.repos;
const flush = () => new Promise((r) => setTimeout(r, 0));
const REPO = {
  id: "forge-notes",
  platform: "forge",
  url: "https://git.example.com/forge/forge-notes.git",
  type: "spring-boot",
  owner: "team-notes",
  defaultBranch: "main",
  branches: ["develop"],
  scans: [],
};

describe("editing a repo's branches after a reload", () => {
  it("opens with the manifest's branches now, and sends what it showed", async () => {
    const props = { r: REPO as never, onChanged: () => undefined };
    const m = mount(RepoRow as never, props as never);
    // A teammate's pull adds a branch; the row is shown again with it.
    props.r = { ...REPO, branches: ["develop", "release/2026.11"] } as never;
    m.render();
    const edit = all(m.tree).find((e) => e.type === "button" && text(e.props.children) === R.edit)!;
    (edit.props.onClick as () => void)();
    m.render();
    const area = all(m.tree).find((e) => e.props.id === "repo-forge-notes-branches")!;
    expect(area.props.value).toBe("develop\nrelease/2026.11");
    const form = all(m.tree).find((e) => e.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
    await flush();
    expect(sent.at(-1)).toMatchObject({
      path: "/api/repos/forge-notes/branches",
      body: { was: { defaultBranch: "main", branches: ["develop", "release/2026.11"] } },
    });
  });
});
