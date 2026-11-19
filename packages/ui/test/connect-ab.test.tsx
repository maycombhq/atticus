import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ConnectAB } from "../src/screens/architecture/ConnectAB.js";
import { shownReason, shownStatus } from "../src/screens/architecture/Connect.js";
import { canvasGraph } from "../src/screens/architecture/model.js";

/**
 * ADR 0204 decisions 1, 3 and 5: the Connect <A> to <B> panel for each mechanism and need, its
 * loading, error and empty states, the two direction radios (labelled), the four status words and
 * the four reasons with the exact one kept, and a declared arrow's label. Invented Forge names.
 */

const W = COPY.connectAB;
const PROXY = { label: "repo: forge-edge-proxy", box: { repo: "forge-edge-proxy" } };
const LEDGER = { label: "repo: forge-ledger-svc", box: { repo: "forge-ledger-svc" } };
const base = (o: Partial<Api.ConnectViewT>): Api.ConnectViewT => ({
  from: PROXY.box,
  to: LEDGER.box,
  fromName: "forge-edge-proxy",
  toName: "forge-ledger-svc",
  mechanism: "declare",
  needs: [],
  existing: 0,
  ...o,
});
const html = (
  read: Api.ConnectViewT | "loading" | "error" | undefined,
  o: { b?: boolean } = { b: true },
) =>
  renderToStaticMarkup(
    <ConnectAB
      a={PROXY}
      {...(o.b ? { b: LEDGER } : {})}
      boxes={[PROXY, LEDGER]}
      onClose={() => undefined}
      io={{
        read: (path) =>
          !path
            ? { state: "loading" }
            : read === "loading"
              ? { state: "loading", line: "Reading the estate's facts" }
              : read === "error"
                ? { state: "error", error: "No repo of the manifest is forge-gone." }
                : { state: "ready", data: read! },
      }}
    />,
  );
const plain = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe("Connect <A> to <B> (ADR 0204 1.2, 1.3)", () => {
  it("titles the caller to the callee, with two labelled radios, the drawn start ticked", () => {
    const h = plain(html(base({})));
    expect(h).toContain(W.title("forge-edge-proxy", "forge-ledger-svc"));
    expect(h).toContain(`<legend class="hud">${W.direction}</legend>`);
    expect(h).toContain(W.calls("forge-edge-proxy", "forge-ledger-svc"));
    expect(h).toContain(W.calls("forge-ledger-svc", "forge-edge-proxy"));
    expect(h.match(/type="radio"/g)).toHaveLength(2);
    expect(h).toMatch(/<input type="radio"[^>]*checked=""/);
  });

  it("has its loading, error and empty states", () => {
    expect(html("loading")).toContain(W.loading);
    expect(html("error")).toContain('role="alert"');
    // No other box yet (Connect to… from a box): the picker, labelled, and nothing read.
    const empty = html(undefined, {});
    expect(empty).toMatch(
      /<label for="([^"]+)-to" class="hud">The other box<\/label><select id="\1-to"/,
    );
    expect(empty).not.toContain(W.loading);
  });

  it("says each mechanism in its words, with its one button", () => {
    const declare = plain(html(base({})));
    expect(declare).toContain(
      "Atticus found no call in forge-edge-proxy's code that goes to forge-ledger-svc.",
    );
    expect(declare).toContain(W.declare);
    expect(declare).toMatch(
      /<label for="([^"]+)-why" class="hud">[^<]+<\/label><textarea id="\1-why"/,
    );
    const connected = plain(html(base({ mechanism: "connected", existing: 3 })));
    expect(connected).toContain(W.mechanism.connected("forge-edge-proxy", "forge-ledger-svc", 3));
    expect(connected).not.toContain(W.declare);
    const d: Api.DeclaredArrowViewT = {
      from: PROXY.box,
      to: LEDGER.box,
      why: "The proxy's target is set at deploy time.",
      by: "Ada Example",
      at: "2026-11-18T10:02:00Z",
      file: "org-pack/profiles/forge/profile.yaml",
    };
    const declared = plain(html(base({ mechanism: "declared", declared: d })));
    expect(declared).toContain(
      W.declaredPanel("Ada Example", "2026-11-18", "forge-edge-proxy", "forge-ledger-svc", d.why),
    );
    expect(declared).toContain(W.remove);
    // The code now shows the call: the offer to retire it.
    const later = plain(
      html(base({ mechanism: "declared", declared: d, superseded: { calls: 2 } })),
    );
    expect(later).toContain(
      W.superseded("forge-edge-proxy", "forge-ledger-svc", 2, "Ada Example", "2026-11-18"),
    );
    expect(later).toContain(W.retire);
  });

  it("shows what is missing with the control that fixes it, and declare beside a read (3.2)", () => {
    const pick = plain(
      html(
        base({
          mechanism: "needs",
          to: { system: "ledger" },
          toName: "Ledger",
          needs: [
            {
              need: "pick-repo",
              end: "to",
              label: "Ledger",
              repos: ["forge-ledger-svc", "forge-ledger-batch"],
            },
          ],
        }),
      ),
    );
    expect(pick).toContain(W.need["pick-repo"]("Ledger", 2));
    expect(pick.match(/type="radio"/g)).toHaveLength(4);
    const add = plain(
      html(
        base({
          mechanism: "needs",
          needs: [{ need: "add-system", end: "to", label: "harbor-audit" }],
        }),
      ),
    );
    expect(add).toContain(W.addAndGo("harbor-audit"));
    const none = plain(
      html(
        base({
          mechanism: "needs",
          needs: [{ need: "no-repo", end: "to", label: "Forge Rewards" }],
        }),
      ),
    );
    expect(none).toContain(W.addRepo);
    // Connect to the system itself: the declare form, "Not built yet" ticked.
    expect(none).toMatch(/<input type="checkbox" checked=""\/>Not built yet/);
    const read = plain(
      html(
        base({
          needs: [
            {
              need: "read",
              end: "to",
              label: "forge-ledger-svc",
              repos: ["forge-ledger-svc"],
              command: "atticus map --all --repos forge-ledger-svc",
            },
          ],
        }),
      ),
    );
    expect(read).toContain(W.need.read("forge-ledger-svc"));
    expect(read).toContain(W.declare);
  });
});

describe("four words for nine statuses and ten reasons (ADR 0204 5.2, 5.3)", () => {
  const call = (o: Partial<Api.CandidateCallViewT>): Api.CandidateCallViewT => ({
    fact: "call.get.holds-id",
    callType: "rest",
    path: "/holds/{id}",
    at: "src/Holds.java:8",
    status: "asked",
    ...o,
  });
  it("shows the status as one of four", () => {
    for (const s of ["asked", "missed", "left", "outside", "unresolved", "undrawn"] as const)
      expect(shownStatus(call({ status: s })), s).toBe(W.shown.loose);
    expect(shownStatus(call({ status: "joined", joins: "forge-billing" }))).toBe(
      "goes to forge-billing",
    );
    expect(shownStatus(call({ status: "here" }))).toBe(W.shown.here);
    expect(shownStatus(call({ status: "paired", pairedBy: "pat" }))).toBe("connected by pat");
    expect(shownStatus(call({ status: "paired", pairedBy: "run-1", pairedAi: true }))).toBe(
      W.shown.ai,
    );
  });
  it("shows the reason as one of four, every reason in the table", () => {
    const table: Record<string, string> = {
      "no-host": W.reason.address,
      "unresolved-placeholder": W.reason.address,
      "topic-unresolved": W.reason.address,
      "host-no-route": W.reason.nothing,
      "label-no-route": W.reason.nothing,
      "target-no-route": W.reason.nothing,
      "topic-unheard": W.reason.nothing,
      "generic-path": W.reason.kind,
      "type-not-joined": W.reason.kind,
      "answered-none": W.reason.none,
    };
    for (const [why, shown] of Object.entries(table)) {
      expect(shownReason(why), why).toBe(shown);
      expect(COPY.connect.leftWhy[why], why).toBeDefined();
    }
    expect(shownReason(undefined)).toBeUndefined();
  });
});

describe("a declared arrow on the map (ADR 0204 1.6)", () => {
  const node = (id: string, kind: string) =>
    ({
      id,
      kind,
      label: id.split(":")[1],
      state: "current",
      gaps: [],
      evidence: [],
      childCount: 0,
      properties: {},
    }) as unknown as Api.HierNodeT;
  it("is dashed, in the declared layer, and labelled declared by its person", () => {
    const join = {
      interface: "if-0123456789abcdef",
      from: "edge-proxy",
      to: "ledger-svc",
      how: "declared",
      gateway: false,
      verified: false,
      path: "/**",
      caller: [],
      callee: [],
      hops: [],
      other: [{ source: "manual", at: "profiles/forge/profile.yaml" }],
      declaredBy: "Ada Example",
    } as Api.HierJoinT;
    const views = new Map([
      [
        "estate",
        {
          lens: "architecture",
          node: node("estate", "estate"),
          path: [],
          children: [node("repo:forge-edge-proxy", "repo"), node("repo:forge-ledger-svc", "repo")],
          outside: [],
          edges: [
            {
              id: "e1",
              from: "repo:forge-edge-proxy",
              to: "repo:forge-ledger-svc",
              type: "calls",
              via: "other",
              count: 1,
              state: "current",
              gaps: [],
              evidence: [],
              joins: [join],
            },
          ],
          reduced: true,
          hiddenEdges: 0,
        } as Api.GraphNodeViewT,
      ],
    ]);
    const g = canvasGraph(views, "estate", new Set());
    expect(g.links).toHaveLength(1);
    expect(g.links[0]).toMatchObject({
      declared: true,
      label: expect.stringContaining("declared by Ada Example"),
    });
  });
});
