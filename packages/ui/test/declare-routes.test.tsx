import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { declareBody, DeclarePanel, routesPath } from "../src/screens/architecture/Declare.js";

/**
 * ADR 0200 (a field report on 2.0.0-beta.28.4): a line drawn from an outside system to a repo
 * opens Declare a link with the system as the caller, "Calls a gateway route" chosen and the
 * repo's routes listed to pick from. On the invented Forge estate: forge-edge (a gateway),
 * forge-ledger (an ordinary service) and Harbor Audit, another team's system.
 */

const D = COPY.declare;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

type View = Api.DeclarableRoutesViewT;
type Route = NonNullable<View["target"]>["routes"][number];
const route = (n: number, o: Partial<Route> = {}): Route => ({
  id: `entry.get.r${n}`,
  method: "GET",
  path: `/edge/audit/v1/r${n}`,
  handler: `edge/R${n}`,
  at: `apiproxy/proxies/default.xml:${n}`,
  say: `GET /edge/audit/v1/r${n}`,
  ...o,
});
const many: Route[] = [
  ...Array.from({ length: 10 }, (_, k) => route(k + 1)),
  route(11, { declared: true }),
  route(12, { handler: undefined, also: ["forge-edge-partner"] }),
];
const view = (target?: View["target"], gateways = [{ repo: "forge-edge", routes: 12 }]): View => ({
  system: "harbor-audit",
  gateways,
  ...(target ? { target } : {}),
});
const edge = (routes: Route[] = many): View["target"] => ({
  repo: "forge-edge",
  gateway: true,
  routes,
  entries: routes.length,
});
const panel = (
  routes: { state: "loading" } | { state: "error"; error: string } | { state: "ready"; data: View },
  target: string | null = "forge-edge",
  seen?: (path: string | undefined) => void,
) =>
  un(
    renderToStaticMarkup(
      <DeclarePanel
        system="harbor-audit"
        label="Harbor Audit"
        {...(target ? { target } : {})}
        onClose={() => undefined}
        routesOf={(path) => {
          seen?.(path);
          return { ...routes, reload: () => undefined };
        }}
      />,
    ),
  );

describe("the request a declaration sends (declareBody)", () => {
  it("sends the ticked routes sorted, each once, with a typed one among them", () => {
    expect(declareBody("harbor-audit", "call", " ", new Set(["POST /b", "GET /a"]))).toEqual({
      kind: "call",
      system: "harbor-audit",
      routes: ["GET /a", "POST /b"],
    });
    expect(declareBody("harbor-audit", "call", " GET /a ", new Set(["POST /b", "GET /a"]))).toEqual(
      { kind: "call", system: "harbor-audit", routes: ["GET /a", "POST /b"] },
    );
    expect(declareBody("harbor-audit", "call", "edge/Typed", new Set(["GET /a"]))).toEqual({
      kind: "call",
      system: "harbor-audit",
      routes: ["GET /a", "edge/Typed"],
    });
  });

  it("sends a typed route alone as before, and nothing when none is ticked or typed", () => {
    expect(declareBody("harbor-audit", "call", "POST /webhooks", new Set())).toEqual({
      kind: "call",
      system: "harbor-audit",
      route: "POST /webhooks",
    });
    expect(declareBody("harbor-audit", "call", "  ", new Set())).toBeUndefined();
    // A topic never carries the routes ticked before the kind was changed.
    expect(declareBody("harbor-audit", "listens", "harbor.events", new Set(["GET /a"]))).toEqual({
      kind: "topic",
      system: "harbor-audit",
      topic: "harbor.events",
      side: "listens",
    });
  });

  it("asks for the gateways, and for a repo's routes once one is picked", () => {
    expect(routesPath("harbor audit", undefined)).toBe(
      "/api/declared-links/routes?system=harbor%20audit",
    );
    expect(routesPath("harbor-audit", "forge-edge")).toBe(
      "/api/declared-links/routes?system=harbor-audit&repo=forge-edge",
    );
  });
});

describe("Declare a link opened by a line drawn from an outside system to a repo", () => {
  it("names the ends as drawn, with the system as the caller, and has Calls a gateway route chosen", () => {
    const paths: (string | undefined)[] = [];
    const out = panel({ state: "ready", data: view(edge()) }, "forge-edge", (p) => paths.push(p));
    expect(out).toContain(D.title("Harbor Audit"));
    expect(out).toContain(D.ends("Harbor Audit", "forge-edge"));
    expect(out).toContain(D.callIntro("Harbor Audit"));
    expect(out).toMatch(new RegExp(`<input type="radio"[^>]*checked=""[^>]*/>${D.kinds.call}`));
    expect(paths).toEqual(["/api/declared-links/routes?system=harbor-audit&repo=forge-edge"]);
    // The gateway it was dropped on is the one picked.
    expect(out).toMatch(
      new RegExp(
        `<option value="forge-edge" selected="">${D.gatewayOption("forge-edge", 12).replace(/[()]/g, "\\$&")}`,
      ),
    );
  });

  it("lists the routes to tick, each with its method, path, handler and line, and a search when there are many", () => {
    const out = panel({ state: "ready", data: view(edge()) });
    // Eleven not declared yet, one declared already.
    expect(out).toContain(D.routesOf("forge-edge", 11));
    expect(out.match(/<input type="checkbox"/g)).toHaveLength(11);
    expect(out).toContain('<span class="box-method">GET</span>');
    expect(out).toContain('<code class="mono">/edge/audit/v1/r3</code>');
    expect(out).toContain(`${D.handler("edge/R3")} · apiproxy/proxies/default.xml:3`);
    expect(out).toMatch(/<input[^>]*type="search"/);
    expect(out).toContain(D.findRoute);
    expect(out).toContain(D.picked(0));
    // The same words name another repo's route: said on its row.
    expect(out).toContain(D.also(["forge-edge-partner"]));
    // Typing a route is still there, for one not read yet.
    expect(out).toContain(D.typed);
    expect(out).toContain(D.route);
  });

  it("marks the routes declared already and doesn't offer them again", () => {
    const out = panel({ state: "ready", data: view(edge()) });
    expect(out).toContain(D.declaredList("Harbor Audit", 1));
    expect(out).toContain(D.declaredAlready);
    const done = out.slice(out.indexOf(D.declaredList("Harbor Audit", 1)));
    expect(done).toContain("/edge/audit/v1/r11");
    expect(done).not.toContain('type="checkbox"');
    const offered = out.slice(0, out.indexOf(D.declaredList("Harbor Audit", 1)));
    expect(offered).not.toContain("/edge/audit/v1/r11<");
    // Every route declared: said, and nothing to tick.
    const all = panel({
      state: "ready",
      data: view(edge([route(1, { declared: true }), route(2, { declared: true })])),
    });
    expect(all).toContain(D.allDeclared("Harbor Audit", "forge-edge"));
    expect(all).not.toContain('type="checkbox"');
  });

  it("offers no search for a few routes", () => {
    const out = panel({ state: "ready", data: view(edge([route(1), route(2)])) });
    expect(out).not.toMatch(/type="search"/);
    expect(out.match(/<input type="checkbox"/g)).toHaveLength(2);
  });

  it("holds the write back with the reason while nothing is ticked: no button that writes nothing", () => {
    const out = panel({ state: "ready", data: view(edge()) });
    expect(out).toContain(D.pickFirst);
    expect(out).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${D.preview}</button>`));
    expect(out).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${D.confirm}</button>`));
  });

  it("says the routes are being read, and when they couldn't be, with Try again", () => {
    const loading = panel({ state: "loading" });
    expect(loading).toMatch(
      new RegExp(`<p role="status" aria-busy="true"[^>]*>${D.routesLoading}</p>`),
    );
    const failed = panel({ state: "error", error: "the facts folder is locked" });
    expect(failed).toMatch(/role="alert"/);
    expect(failed).toContain(D.routesFailed("the facts folder is locked"));
    expect(failed).toContain(D.again);
    // The typed form still works without the list.
    expect(failed).toContain(D.typed);
  });

  it("says truthfully that an ordinary service's entry can't be declared, and what works instead", () => {
    const out = panel(
      {
        state: "ready",
        data: view({ repo: "forge-ledger", gateway: false, routes: [], entries: 7 }),
      },
      "forge-ledger",
    );
    expect(out).toContain(D.ends("Harbor Audit", "forge-ledger"));
    expect(out).toContain(
      "Declaring who calls an entry of forge-ledger isn't supported yet: only a gateway's routes can be declared.",
    );
    expect(out).toContain(D.notGatewayEntries("forge-ledger", 7));
    expect(out).toContain(D.notGatewayDo("Harbor Audit", "forge-ledger", true));
    expect(out).not.toContain('type="checkbox"');
    // The repo it was dropped on stays named in the list, with the gateways to pick instead.
    expect(out).toContain(
      `<option value="forge-ledger" selected="">${D.notGatewayOption("forge-ledger")}`,
    );
    expect(out).toContain('<option value="forge-edge">');
    expect(D.notGatewayDo("Harbor Audit", "forge-ledger", false)).not.toContain(
      "pick that gateway",
    );
  });

  it("says a repo with nothing on record how to read it", () => {
    const out = panel(
      {
        state: "ready",
        data: view({
          repo: "forge-edge-new",
          gateway: false,
          routes: [],
          entries: 0,
          notRead: { why: "not-read", command: "atticus map --all --repos forge-edge-new" },
        }),
      },
      "forge-edge-new",
    );
    expect(out).toContain(D.notRead["not-read"]!("forge-edge-new"));
    expect(out).not.toContain(D.notGateway("forge-edge-new"));
  });
});

describe("Declare a link… on the outside system's own box", () => {
  it("starts as before, asking for a topic, and reads no routes until Calls a gateway route is chosen", () => {
    const paths: (string | undefined)[] = [];
    const out = panel({ state: "loading" }, null, (p) => paths.push(p));
    expect(paths).toEqual([undefined]);
    expect(out).toMatch(/<label for="[^"]+" class="hud">Topic or queue/);
    expect(out).not.toContain(D.routesLoading);
    expect(out).not.toContain(D.ends("Harbor Audit", ""));
  });
});
