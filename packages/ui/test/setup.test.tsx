import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0190: settings and setup in the app, "Edit, then Propose": create the metarepo, add repos
 * by pasting clone URLs, the outside systems, and every write previewed as lines before it is
 * written, then Propose for review. Everything is invented (CLAUDE.md rule 3).
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const sent: { path: string; body?: unknown }[] = [];
const EDIT = {
  path: "org-pack/runtime.yaml",
  changes: [{ was: "adapters: {}" }, { now: "adapters:" }, { now: "  gitHost: manual" }],
  written: false,
  note: "Nothing written yet.",
};
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string, o?: { body?: { preview?: boolean } }) => {
      sent.push({ path, body: o?.body });
      return { ...EDIT, written: o?.body?.preview !== true };
    },
  };
});
const { COPY } = await import("../src/copy.js");
const { DiffLines, EditPreview } = await import("../src/screens/setup/EditPreview.js");
const { Propose } = await import("../src/app/propose.js");
const { PlanTable, reposToAdd } = await import("../src/screens/setup/AddRepos.js");
const { adapterValue, settingsOf } = await import("../src/screens/setup/Adapters.js");
const { CreateMetarepoForm } = await import("../src/screens/setup/CreateMetarepo.js");
const S = COPY.setup;
const flush = () => new Promise((r) => setTimeout(r, 0));
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("the preview before a write, then Propose", () => {
  it("shows the lines removed and added, said for a screen reader too", () => {
    const out = html(<DiffLines edit={EDIT} />);
    expect(out).toContain(`aria-label="${S.diffLabel("org-pack/runtime.yaml")}"`);
    expect(out).toContain("- adapters: {}");
    expect(out).toContain("+   gitHost: manual");
    expect(out).toContain(`${S.removed}: `);
    expect(html(<DiffLines edit={{ ...EDIT, changes: [] }} />)).toContain(S.nothingChanges);
  });

  it("previews, then writes on Write it, then offers Propose for review", async () => {
    sent.length = 0;
    const props = {
      preview: () =>
        import("../src/api/client.js").then((c) => c.api<never>("/x", { body: { preview: true } })),
      write: () => import("../src/api/client.js").then((c) => c.api<never>("/x", { body: {} })),
    };
    const m = mount(EditPreview as never, props as never);
    const button = (label: string) =>
      all(m.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
    (button(S.preview).props.onClick as () => void)();
    await flush();
    await flush();
    m.render();
    expect(all(m.tree).find((e) => e.type === DiffLines)?.props.edit).toMatchObject({
      written: false,
    });
    (button(S.write).props.onClick as () => void)();
    await flush();
    await flush();
    m.render();
    expect(sent.map((s) => s.body)).toEqual([{ preview: true }, {}]);
    expect(text(m.tree)).toContain(S.written("org-pack/runtime.yaml"));
    expect(all(m.tree).find((e) => e.type === Propose)?.props.scope).toBe("org-pack");
  });
});

describe("adding repos by pasting clone URLs", () => {
  const plan = {
    platform: "forge",
    platforms: ["forge"],
    repos: [
      {
        id: "forge-ledger",
        url: "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
        given: "https://priya@dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger?path=/",
        type: "unknown",
      },
      {
        id: "forge-cards-2",
        url: "https://git.northwind.example/partners/forge-cards.git",
        type: "unknown",
        renamed: { from: "forge-cards", why: "another repo here is forge-cards too" },
      },
    ],
    listed: [
      {
        url: "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards",
        id: "forge-cards",
      },
    ],
    refused: [],
    skipped: [],
  };
  const rows = plan.repos.map((r) => ({ ...r, add: true, about: "" }));

  it("shows each URL as normalised, the id a clash got, and what is listed already", () => {
    const out = html(<PlanTable plan={plan} rows={rows} setRows={() => undefined} />);
    expect(out).toContain(esc(S.normalised(plan.repos[0]!.given!)));
    expect(out).toContain(esc(S.renamed("forge-cards", "another repo here is forge-cards too")));
    expect(out).toContain(esc(S.listed(plan.listed[0]!.url, "forge-cards")));
    expect(out).toContain(`aria-label="${S.addFor("forge-ledger")}"`);
    expect(out).toContain(esc(S.toAdd(2)));
  });

  it("sends the ticked repos with their ids as edited and what each is, if said", () => {
    const picked = reposToAdd([
      { ...rows[0]!, about: " The ledger every payment posts to. " },
      { ...rows[1]!, add: false },
    ]);
    expect(picked).toEqual([
      {
        id: "forge-ledger",
        url: plan.repos[0]!.url,
        type: "unknown",
        description: "The ledger every payment posts to.",
      },
    ]);
  });
});

describe("the outside systems", () => {
  const kind = {
    kind: "gitHost",
    types: ["manual", "github", "azure-repos", "gitlab", "bitbucket"],
    fields: [
      { name: "metarepo", list: false },
      { name: "protectedBranches", list: true },
      { name: "defaultBranch", list: false },
    ],
    current: null,
  };
  it("sends the type, the fields (a list one a line) and the other settings", () => {
    expect(
      adapterValue(
        kind,
        "manual",
        { metarepo: " forge-payments-metarepo ", protectedBranches: "main\nrelease" },
        "baseUrl: https://git.forge.example\n",
      ),
    ).toEqual({
      type: "manual",
      settings: {
        metarepo: "forge-payments-metarepo",
        protectedBranches: ["main", "release"],
        baseUrl: "https://git.forge.example",
      },
    });
    expect(adapterValue(kind, "", {}, "")).toBeNull();
    expect(settingsOf("owner: forge\nnot a setting\n")).toEqual({
      settings: { owner: "forge" },
      bad: ["not a setting"],
    });
  });
});

describe("Create the metarepo here", () => {
  it("is a form with each field labelled and the folder's names suggested", () => {
    const out = html(
      <CreateMetarepoForm
        view={{
          metarepo: false,
          root: "/work/forge-payments-metarepo",
          folder: "forge-payments-metarepo",
          suggested: { name: "forge-payments-metarepo", platform: "forge-payments" },
          metarepoId: "forge-payments-metarepo",
        }}
        onCreated={() => undefined}
      />,
    );
    for (const id of ["setup-name", "setup-platform", "setup-owner", "setup-metarepo"])
      expect(out).toContain(`for="${id}"`);
    expect(out).toContain('value="forge-payments"');
    expect(out).toContain(S.create);
    expect(out).toContain("atticus init . --platform forge-payments");
  });
});
