import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Round 36 (UX review): a draft request's missing fields are filled on the Service desk page,
 * written into snow.md (PUT /api/service-desk/{change}/fields, with the sha256 the page read so
 * a file changed since is refused), then proposed for review. Filing stays the person's File.
 * Invented Forge names only.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; method?: string; body?: unknown }[] = [];
let answer: () => unknown = () => ({
  path: "openspec/changes/add-transfer-limit/snow.md",
  sha256: "b".repeat(64),
  missing: [],
  lines: ["Filled Target in openspec/changes/add-transfer-limit/snow.md."],
});
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o?: { method?: string; body?: unknown }) => {
    calls.push({
      path,
      ...(o?.method ? { method: o.method } : {}),
      ...(o?.body ? { body: o.body } : {}),
    });
    return answer();
  },
}));
const { COPY } = await import("../src/copy.js");
const { FillFields } = await import("../src/screens/run/ServiceDesk.js");
const { Propose } = await import("../src/app/propose.js");
const { Note } = await import("../src/screens/run/shared.js");
const T = COPY.serviceDesk;
const tick = () => new Promise((r) => setTimeout(r, 0));

const request = {
  change: "add-transfer-limit",
  heading: "Gateway proxy deployment",
  requestType: "Gateway proxy deployment",
  record: "",
  approvers: ["gateway team"],
  fields: [
    { name: "Proxy name", value: "gw-northwind-v2", required: true },
    { name: "Target", value: "", required: true },
  ],
  missing: ["Target"],
  state: "to-file" as const,
  file: "openspec/changes/add-transfer-limit/snow.md",
  sha256: "a".repeat(64),
};

it("fills the missing field in snow.md with the version it read, then offers Propose", async () => {
  let reloaded = 0;
  const m = mount(FillFields as never, { r: request, done: () => reloaded++ } as never);
  const inputs = all(m.tree).filter((e) => e.type === "input");
  expect(inputs).toHaveLength(1);
  const label = all(m.tree).find(
    (e) => e.type === "label" && e.props.htmlFor === inputs[0]!.props.id,
  )!;
  expect(text(label.props.children)).toContain("Target");
  (inputs[0]!.props.onChange as (e: unknown) => void)({ target: { value: "ledger-api:8443" } });
  m.render();
  expect(all(m.tree).some((e) => e.type === Propose)).toBe(false);
  const form = all(m.tree).find((e) => e.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  await tick();
  m.render();
  expect(calls).toEqual([
    {
      path: "/api/service-desk/add-transfer-limit/fields",
      method: "PUT",
      body: {
        heading: "Gateway proxy deployment",
        baseSha256: "a".repeat(64),
        values: { Target: "ledger-api:8443" },
      },
    },
  ]);
  expect(reloaded).toBe(1);
  const note = all(m.tree).find((e) => e.type === Note)!;
  expect(note.props.note).toMatchObject({
    ok: true,
    text: "Filled Target in openspec/changes/add-transfer-limit/snow.md.",
  });
  const propose = all(m.tree).find((e) => e.type === Propose)!;
  expect(propose.props.scope).toBe("service-desk");
});

it("says what to fill before it sends anything, and says a refusal (a file changed since)", async () => {
  calls.length = 0;
  const m = mount(FillFields as never, { r: request, done: () => undefined } as never);
  const form = () => all(m.tree).find((e) => e.type === "form")!;
  (form().props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  await tick();
  m.render();
  expect(calls).toEqual([]);
  expect(all(m.tree).find((e) => e.type === Note)!.props.note).toEqual({
    ok: false,
    text: T.fillSomething,
  });
  const { ApiError } = await import("../src/api/client.js");
  answer = () => {
    throw new ApiError({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "snow.md changed since you opened it: reload the page and fill the fields again.",
    });
  };
  const input = all(m.tree).find((e) => e.type === "input")!;
  (input.props.onChange as (e: unknown) => void)({ target: { value: "ledger-api:8443" } });
  m.render();
  (form().props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  await tick();
  m.render();
  const note = all(m.tree).find((e) => e.type === Note)!.props.note as {
    ok: boolean;
    text: string;
  };
  expect(note.ok).toBe(false);
  expect(note.text).toContain("changed since you opened it");
  expect(all(m.tree).some((e) => e.type === Propose)).toBe(false);
});

it("shows nothing for a request with nothing missing", () => {
  const m = mount(
    FillFields as never,
    {
      r: { ...request, missing: [], fields: [] },
      done: () => undefined,
    } as never,
  );
  expect(m.tree).toBeNull();
});
