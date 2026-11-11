import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Pages whose state must follow what changes under them (review round 18): the bulk bar's
 * action as the selection changes, the AI form when runtime.yaml changes on disk or after a save,
 * a lens change keeping the change, and Reset asking first. Clicked with the tiny hooks runtime,
 * no DOM; the local API is a stub.
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
      return {};
    },
  };
});

const { COPY } = await import("../src/copy.js");
const { BulkBar } = await import("../src/screens/CommandCenter.js");
const { AiSettingsForm } = await import("../src/screens/run/AiSettings.js");
const { ArrangementBar } = await import("../src/screens/architecture/Architecture.js");
const { setQueryParam } = await import("../src/screens/know/common.js");
const { WORDS } = await import("../src/screens/architecture/words.js");
type AiSettings = Parameters<typeof AiSettingsForm>[0]["data"];

const flush = () => new Promise((r) => setTimeout(r, 0));
// A button by its name: its words, or (beta.26, the map's icon buttons) the label it is named by.
const byLabel = (tree: unknown, label: string) =>
  all(tree).find(
    (e) =>
      (e.type === "button" && text(e.props.children) === label) ||
      (typeof e.props.onClick === "function" && e.props.label === label),
  );

describe("the bulk bar follows the selection", () => {
  const need = { kind: "need", title: "n", detail: "", href: "#", id: "n1", change: "c" } as const;
  const step = { kind: "step", title: "s", detail: "", href: "#", id: "s1" } as const;

  it("swaps an action with nothing to do, and settles when nothing selected is left", () => {
    const props = {
      selected: [need] as unknown[],
      onApply: async () => undefined,
      onClear: () => undefined,
    };
    const m = mount(BulkBar as never, props as never);
    const select = () => all(m.tree).find((e) => e.type === "select")!;
    expect(select().props.value).toBe("need-done");
    props.selected = [step];
    m.render();
    expect(select().props.value).toBe("step-skip");
    // Nothing selected left (another window resolved them): no loop, the action stays.
    props.selected = [];
    m.render();
    expect(select().props.value).toBe("step-skip");
  });
});

describe("the AI form and runtime.yaml on disk", () => {
  const DATA: AiSettings = {
    ai: "on",
    modes: { allowed: ["hand-off"], default: "hand-off" },
    assistants: [{ id: "copilot", name: "GitHub Copilot", allowed: true, default: true }],
    providers: [{ type: "anthropic", settings: ["model", "keyEnv"] }],
    model: null,
    keySet: false,
    models: { allowed: [], recommended: {} },
    budgets: { defaultTokens: 200000, perAgent: {} },
    path: "org-pack/runtime.yaml",
  };
  const models = (tree: unknown) => all(tree).find((e) => e.props.id === "ai-models")!;
  const alert = (tree: unknown) =>
    all(tree).some(
      (e) => e.props.role === "alert" && text(e).includes(COPY.aiSettings.changedOnDisk),
    );

  beforeEach(() => {
    sent.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("takes a change on disk quietly when nothing is edited here", () => {
    const props = { data: DATA };
    const m = mount(AiSettingsForm as never, props as never);
    props.data = { ...DATA, models: { allowed: ["model-a"], recommended: {} } };
    m.render();
    expect(models(m.tree).props.value).toBe("model-a");
    expect(alert(m.tree)).toBe(false);
  });

  it("keeps edits and says so when the file changes under them; Take the file's values takes it", () => {
    const props = { data: DATA };
    const m = mount(AiSettingsForm as never, props as never);
    (models(m.tree).props.onChange as (e: unknown) => void)({ target: { value: "mine" } });
    m.render();
    props.data = { ...DATA, models: { allowed: ["theirs"], recommended: {} } };
    m.render();
    expect(models(m.tree).props.value).toBe("mine");
    expect(alert(m.tree)).toBe(true);
    (byLabel(m.tree, COPY.aiSettings.takeDisk)!.props.onClick as () => void)();
    m.render();
    expect(models(m.tree).props.value).toBe("theirs");
    expect(alert(m.tree)).toBe(false);
  });

  it("after a save, takes what the server stored (trimmed) without calling it a change on disk", async () => {
    const props = { data: DATA, onSaved: () => undefined };
    const m = mount(AiSettingsForm as never, props as never);
    (models(m.tree).props.onChange as (e: unknown) => void)({ target: { value: "  model-b  " } });
    m.render();
    const form = all(m.tree).find((e) => e.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
    await flush();
    m.render();
    expect(sent.some((x) => x.path === "/api/settings/ai")).toBe(true);
    props.data = { ...DATA, models: { allowed: ["model-b"], recommended: {} } };
    m.render();
    expect(models(m.tree).props.value).toBe("model-b");
    expect(alert(m.tree)).toBe(false);
  });
});

describe("the AI form after a save, with an edit typed meanwhile", () => {
  it("keeps the later edit and says the file changed, rather than taking the reload over it", async () => {
    const DATA = {
      ai: "on",
      modes: { allowed: ["hand-off"], default: "hand-off" },
      assistants: [{ id: "copilot", name: "GitHub Copilot", allowed: true, default: true }],
      providers: [{ type: "anthropic", settings: ["model"] }],
      model: null,
      keySet: false,
      models: { allowed: [], recommended: {} },
      budgets: { defaultTokens: 200000, perAgent: {} },
      path: "org-pack/runtime.yaml",
    } as never as Parameters<typeof AiSettingsForm>[0]["data"];
    const props = { data: DATA, onSaved: () => undefined };
    const m = mount(AiSettingsForm as never, props as never);
    const models = () => all(m.tree).find((e) => e.props.id === "ai-models")!;
    (models().props.onChange as (e: unknown) => void)({ target: { value: "model-b" } });
    m.render();
    (all(m.tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
      preventDefault: () => undefined,
    });
    await flush();
    m.render();
    // Typed after the save went, before its reload landed.
    (models().props.onChange as (e: unknown) => void)({ target: { value: "model-c" } });
    m.render();
    props.data = { ...DATA, models: { allowed: ["model-b"], recommended: {} } } as never;
    m.render();
    expect(models().props.value).toBe("model-c");
  });
});

describe("Reset asks first", () => {
  it("takes two clicks, and Keep it changes nothing", () => {
    let reset = 0;
    const props = {
      ready: true,
      saving: false,
      moved: 0,
      onKeep: () => undefined,
      onTidy: () => undefined,
      onReset: () => reset++,
    };
    const m = mount(ArrangementBar as never, props as never);
    (byLabel(m.tree, WORDS.reset)!.props.onClick as () => void)();
    m.render();
    expect(reset).toBe(0);
    expect(text(m.tree)).toContain(WORDS.resetAsk);
    (byLabel(m.tree, WORDS.resetNo)!.props.onClick as () => void)();
    m.render();
    expect(byLabel(m.tree, WORDS.resetYes)).toBeUndefined();
    (byLabel(m.tree, WORDS.reset)!.props.onClick as () => void)();
    m.render();
    (byLabel(m.tree, WORDS.resetYes)!.props.onClick as () => void)();
    expect(reset).toBe(1);
  });
});

describe("a query parameter set keeps the others", () => {
  it("keeps the change when the lens changes, and drops what it is told to", () => {
    const g = globalThis as { location?: { hash: string } };
    const was = g.location;
    g.location = { hash: "#/architecture?change=add-fraud-check&lens=architecture&node=estate" };
    setQueryParam("architecture", "lens", "data", { drop: ["node"] });
    expect(g.location.hash).toBe("#/architecture?change=add-fraud-check&lens=data");
    setQueryParam("architecture", "change", "add-transfer-limit");
    expect(g.location.hash).toBe("#/architecture?change=add-transfer-limit&lens=data");
    g.location = was;
  });
});
