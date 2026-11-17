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
let planReply: unknown;
/** Set to hold a folder's read open (its job running) until the test ends it. */
let held: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined | true;
const followed: { onLine?: (l: string) => void; write?: boolean }[] = [];
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
      if (path === "/api/setup/repos/plan") return planReply;
      return { ...EDIT, written: o?.body?.preview !== true };
    },
    stopJob: async (id: string) => {
      sent.push({ path: `/api/jobs/${id}/cancel` });
    },
    // A folder is read as a job (beta.28.3's field report): the page hears the job's id and
    // each line it says, and its answer is the plan (or JobStopped, once Stop ended it).
    callAsJob: async (
      path: string,
      body: Record<string, unknown>,
      o: { onJob?: (id: string) => void; onLine?: (l: string) => void; write?: boolean },
    ) => {
      sent.push({ path, body: { ...body, job: true } });
      followed.push(o);
      o.onJob?.("job-7");
      if (!held) return planReply;
      return new Promise((resolve, reject) => {
        held = { resolve, reject };
      });
    },
  };
});
const { COPY } = await import("../src/copy.js");
const { DiffLines, EditPreview } = await import("../src/screens/setup/EditPreview.js");
const { Propose } = await import("../src/app/propose.js");
const { AddRepos, PlanTable, reposToAdd } = await import("../src/screens/setup/AddRepos.js");
const { JobWait } = await import("../src/app/job-wait.js");
const { Note } = await import("../src/screens/know/common.js");
const { AdapterForm, adapterValue, settingsOf, shown } =
  await import("../src/screens/setup/Adapters.js");
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

  it("reads other settings as YAML values, and shows them so they read back the same", () => {
    expect(
      settingsOf('strictSsl: false\nretries: 3\norgs: [forge, forge-labs]\nlabel: "3"\n').settings,
    ).toEqual({ strictSsl: false, retries: 3, orgs: ["forge", "forge-labs"], label: "3" });
    const values = {
      strictSsl: false,
      retries: 3,
      orgs: ["forge", "forge, labs"],
      label: "3",
      apiBase: "https://ghe.forge.example/api/v3",
      note: "yes",
    };
    const text = Object.entries(values)
      .map(([k, v]) => `${k}: ${shown(v)}`)
      .join("\n");
    expect(settingsOf(text).settings).toEqual(values);
  });

  it("sends a known field's value as the file had it while it is unchanged", () => {
    const k = { ...kind, current: { type: "github", settings: { defaultBranch: "main" } } };
    const was = { metarepo: "forge/metarepo", defaultBranch: "main" };
    const withNumber = { ...k, current: { type: "github", settings: { ...was, idPattern: 7 } } };
    expect(
      adapterValue(
        { ...withNumber, fields: [...kind.fields, { name: "idPattern", list: false }] },
        "github",
        { metarepo: "forge/metarepo", defaultBranch: "main", idPattern: "7" },
        "",
        { ...was, idPattern: 7 },
      )?.settings,
    ).toEqual({ ...was, idPattern: 7 });
  });

  const gitHost = (settings: Record<string, string | string[]>) => ({
    ...kind,
    current: { type: "manual", settings },
  });
  const field = (m: { tree: unknown }, name: string) =>
    all(m.tree).find((e) => e.props.id === `adapter-gitHost-${name}`)!;

  it("follows the file when it is read again, unless the person has edited the form", () => {
    const props = {
      kind: gitHost({ metarepo: "forge-metarepo" }),
      sha256: "a".repeat(64),
      onWritten: () => undefined,
    };
    const m = mount(AdapterForm as never, props as never);
    expect(field(m, "metarepo").props.value).toBe("forge-metarepo");
    // Another window wrote it: the untouched form shows the file as it is now.
    props.kind = gitHost({ metarepo: "forge-payments-metarepo" });
    props.sha256 = "b".repeat(64);
    m.render();
    expect(field(m, "metarepo").props.value).toBe("forge-payments-metarepo");
    expect(text(m.tree)).not.toContain(S.adapterChanged(S.kinds.gitHost!));
    // Edited here, then changed elsewhere: the edit stays, and the page says the write would be
    // refused, with a way to start again from the file.
    (field(m, "metarepo").props.onChange as (e: unknown) => void)({
      target: { value: "forge-mine" },
    });
    m.render();
    props.kind = gitHost({ metarepo: "forge-theirs" });
    props.sha256 = "c".repeat(64);
    m.render();
    expect(field(m, "metarepo").props.value).toBe("forge-mine");
    expect(text(m.tree)).toContain(S.adapterChanged(S.kinds.gitHost!));
    const again = all(m.tree).find(
      (e) => e.type === "button" && text(e.props.children) === S.adapterReload,
    )!;
    (again.props.onClick as () => void)();
    m.render();
    expect(field(m, "metarepo").props.value).toBe("forge-theirs");
  });

  it("sends the file's sha256 as the form read it, so a stale write is refused", async () => {
    sent.length = 0;
    const props = {
      kind: gitHost({ metarepo: "forge-metarepo" }),
      sha256: "d".repeat(64),
      onWritten: () => undefined,
    };
    const m = mount(AdapterForm as never, props as never);
    const preview = all(m.tree).find((e) => e.type === EditPreview)!;
    await (preview.props.preview as () => Promise<unknown>)();
    expect(sent[0]).toMatchObject({
      path: "/api/setup/adapters/gitHost",
      body: { baseSha256: "d".repeat(64), preview: true },
    });
  });
});

describe("discovering a folder of clones", () => {
  it("asks which platform first when there are several, then sends it", async () => {
    sent.length = 0;
    const m = mount(AddRepos as never, {} as never);
    const els = () => all(m.tree);
    const radio = els().filter((e) => e.type === "input" && e.props.type === "radio")[1]!;
    (radio.props.onChange as () => void)();
    m.render();
    (els().find((e) => e.props.id === "add-repos-dir")!.props.onChange as (e: unknown) => void)({
      target: { value: "/work/clones" },
    });
    m.render();
    const submit = () =>
      (els().find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
        preventDefault: () => undefined,
      });
    planReply = {
      platforms: ["forge", "northwind"],
      repos: [],
      listed: [],
      refused: [],
      skipped: [],
    };
    submit();
    await flush();
    await flush();
    m.render();
    expect(text(m.tree)).toContain(S.choosePlatform(2));
    const select = els().find((e) => e.props.id === "add-repos-platform")!;
    (select.props.onChange as (e: unknown) => void)({ target: { value: "northwind" } });
    m.render();
    planReply = { ...(planReply as object), platform: "northwind" };
    submit();
    await flush();
    await flush();
    expect(sent.map((s) => s.body)).toEqual([
      { dir: "/work/clones", job: true },
      { dir: "/work/clones", platform: "northwind", job: true },
    ]);
  });

  /** The form in folder mode with a folder typed, and its submit. */
  const folderForm = () => {
    const m = mount(AddRepos as never, {} as never);
    const els = () => all(m.tree);
    (
      els().filter((e) => e.type === "input" && e.props.type === "radio")[1]!.props
        .onChange as () => void
    )();
    m.render();
    (els().find((e) => e.props.id === "add-repos-dir")!.props.onChange as (e: unknown) => void)({
      target: { value: "/work/clones" },
    });
    m.render();
    const submit = () =>
      (els().find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
        preventDefault: () => undefined,
      });
    return { m, els, submit };
  };

  // Field report (beta.28.3): the read of a folder of ~40 clones "took hours and did not
  // respond". It is a job: the page says the folder it is on, and offers Stop.
  it("says which folder it is reading while it reads, and stops on Stop", async () => {
    sent.length = 0;
    followed.length = 0;
    held = true;
    const { m, els, submit } = folderForm();
    submit();
    await flush();
    m.render();
    // A read: its end is no write (so Stop ends it as stopped, and no page reloads for it).
    expect(followed[0]!.write).toBe(false);
    const waitOf = () => els().find((x) => x.type === JobWait);
    expect(waitOf()!.props.what).toBe(S.readingFolder);
    followed[0]!.onLine!("Reading forge-ledger (4 of 40)… (0 s in)");
    m.render();
    expect(waitOf()!.props.line).toBe("Reading forge-ledger (4 of 40)… (0 s in)");
    // As the person sees it: the wait's words, the folder it is on, and Stop.
    const shown = html(<JobWait {...(waitOf()!.props as Parameters<typeof JobWait>[0])} />);
    expect(shown).toContain(esc(COPY.app.jobWait.now("Reading forge-ledger (4 of 40)… (0 s in)")));
    expect(shown).toContain(`aria-label="${COPY.app.jobWait.stopLabel(S.readingFolder)}"`);
    (waitOf()!.props.onStop as () => void)();
    await flush();
    expect(sent.at(-1)!.path).toBe("/api/jobs/job-7/cancel");
    m.render();
    expect(waitOf()!.props.stopping).toBe(true);
    const { JobStopped } = await import("../src/api/client.js");
    (held as unknown as { reject: (e: unknown) => void }).reject(new JobStopped());
    held = undefined;
    await flush();
    await flush();
    m.render();
    expect(waitOf()).toBeUndefined();
    const note = els().find((x) => x.type === Note)!.props.note as { ok: boolean; text: string };
    expect(note).toMatchObject({ ok: true, text: COPY.app.jobWait.stopped });
  });

  it("lists what the manifest has already and each folder skipped, with why", async () => {
    held = undefined;
    const { m, submit } = folderForm();
    planReply = {
      platform: "forge",
      platforms: ["forge"],
      repos: [
        {
          id: "forge-statements",
          url: "https://git.forge.example/forge/forge-statements.git",
          type: "frontend",
        },
      ],
      listed: [{ url: "https://git.forge.example/forge/forge-ledger.git", id: "forge-ledger" }],
      refused: [],
      skipped: [
        {
          path: "forge-monolith",
          reason: "took too long to read (over 60 seconds); add it by its clone URL",
        },
        { path: "notes", reason: "no build file, code or platform files" },
      ],
    };
    submit();
    await flush();
    await flush();
    m.render();
    const table = all(m.tree).find((x) => x.type === PlanTable)!;
    const out = html(<PlanTable {...(table.props as Parameters<typeof PlanTable>[0])} />);
    expect(out).toContain(S.toAdd(1));
    expect(out).toContain(
      esc(S.listed("https://git.forge.example/forge/forge-ledger.git", "forge-ledger")),
    );
    expect(out).toContain(`<summary>${esc(S.skipped(2))}</summary>`);
    expect(out).toContain(
      esc(
        S.skippedWhy(
          "forge-monolith",
          "took too long to read (over 60 seconds); add it by its clone URL",
        ),
      ),
    );
    expect(out).toContain(esc(S.skippedWhy("notes", "no build file, code or platform files")));
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
