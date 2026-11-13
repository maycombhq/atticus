import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  AddBoxForm,
  CreatedNote,
  RemovedNote,
  CorrectionsList,
  declareBody,
  DeclarePanel,
} from "../src/screens/architecture/Declare.js";

/** G3 (ADR 0174): declare a link, a box's corrections with Undo, and Add to the picture. */

const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("declaring a link", () => {
  it("builds a topic with its side, or a route, and nothing without one", () => {
    expect(declareBody("harbor-audit", "publishes", " harbor.audit.events ")).toEqual({
      kind: "topic",
      system: "harbor-audit",
      topic: "harbor.audit.events",
      side: "publishes",
    });
    expect(declareBody("northwind-pay", "call", "POST /webhooks")).toEqual({
      kind: "call",
      system: "northwind-pay",
      route: "POST /webhooks",
    });
    expect(declareBody("x", "listens", "  ")).toBeUndefined();
  });

  it("says it is a person's word, with labelled choices and field", () => {
    const out = un(
      renderToStaticMarkup(
        <DeclarePanel system="harbor-audit" label="Harbor audit" onClose={() => undefined} />,
      ),
    );
    expect(out).toContain(COPY.declare.title("Harbor audit"));
    expect(out).toContain(COPY.declare.intro);
    expect(out).toContain("<legend");
    expect(out).toContain(COPY.declare.kinds.listens);
    expect(out).toMatch(/<label for="[^"]+" class="hud">Topic or queue/);
  });
});

describe("declaring from a box no System of the profiles is (beta.28.1, field report 4)", () => {
  const created = { system: "forge-instruments", file: "org-pack/profiles/forge/profile.yaml" };
  it("says the System is added first, before writing and once written, and nothing otherwise", () => {
    const before = un(renderToStaticMarkup(<CreatedNote created={created} written={false} />));
    expect(before).toContain(COPY.declare.willCreate(created.system, created.file));
    expect(before).toContain('role="note"');
    const after = un(renderToStaticMarkup(<CreatedNote created={created} written />));
    expect(after).toContain(COPY.declare.created(created.system, created.file));
    expect(after).toContain('role="status"');
    expect(renderToStaticMarkup(<CreatedNote written />)).toBe("");
    // Undo of its last declaration takes it away again, said (S3).
    expect(un(renderToStaticMarkup(<RemovedNote removed={created} />))).toContain(
      COPY.corrections.removedSystem(created.system, created.file),
    );
    expect(renderToStaticMarkup(<RemovedNote />)).toBe("");
  });
});

describe("a box's corrections", () => {
  it("lists each with who and Undo, and says when there are none, loading or failed", () => {
    const list = un(
      renderToStaticMarkup(
        <CorrectionsList
          of={{
            state: "ready",
            data: {
              items: [
                {
                  kind: "topic",
                  says: "publishes harbor.audit.events",
                  by: "pat",
                  at: "2026-11-06",
                  file: "org-pack/profiles/forge/profile.yaml",
                  undo: { kind: "topic", system: "harbor-audit", value: "harbor.audit.events" },
                },
              ],
            },
          }}
        />,
      ),
    );
    expect(list).toContain("publishes harbor.audit.events");
    expect(list).toContain(COPY.corrections.by("pat", "2026-11-06"));
    expect(list).toContain(COPY.corrections.undo);
    expect(
      un(renderToStaticMarkup(<CorrectionsList of={{ state: "ready", data: { items: [] } }} />)),
    ).toContain(COPY.corrections.none);
    expect(un(renderToStaticMarkup(<CorrectionsList of={{ state: "loading" }} />))).toContain(
      COPY.corrections.loading,
    );
    expect(
      un(renderToStaticMarkup(<CorrectionsList of={{ state: "error", error: "x" }} />)),
    ).toContain(COPY.corrections.failed("x"));
  });
});

describe("add to the picture", () => {
  it("lists the repos not read yet with their command, and the form for a new system", () => {
    const out = un(
      renderToStaticMarkup(
        <AddBoxForm
          onClose={() => undefined}
          of={{
            state: "ready",
            data: {
              repos: [
                { id: "forge-ledger", name: "forge-ledger", read: true },
                { id: "forge-teller", name: "forge-teller", read: false },
              ],
              systems: [],
              teams: [{ id: "team-harbor", name: "Harbor team" }],
            },
          }}
        />,
      ),
    );
    expect(out).toContain(COPY.addBox.notRead);
    expect(out).toContain("atticus map --all --repos forge-teller");
    expect(out).not.toContain("atticus map --all --repos forge-ledger");
    expect(out).toContain(COPY.addBox.newSystem);
    expect(out).toContain(COPY.addBox.boundaries.vendor);
  });
});
