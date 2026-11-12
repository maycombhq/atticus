import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf, SCREENS } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import {
  CrossCheckPage,
  firstShow,
  itemsShown,
  PromotePreview,
  reposInOrder,
  RepoCrossCheckView,
  showCounts,
  valueText,
} from "../src/screens/map/CrossCheck.js";
import { TrustRow } from "../src/screens/map/Trust.js";

/**
 * ADR 0195 point 3 (ticket CS3): Map › Trust › Readers found / facts say. The data is the Forge
 * estate's real cross-check (fixtures/forge/expected/crosscheck.json, the golden the scanner's
 * test makes from the Forge slots): one repo compared, the others without facts. Each state
 * (loading, error, empty, no readers slot, legacy, all agree) is said in words from the copy
 * file, and nothing on the page writes until a person presses Dismiss.
 */

const X = COPY.crossCheck;
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = JSON.parse(
  readFileSync(join(HERE, "../../../fixtures/forge/expected/crosscheck.json"), "utf8"),
) as Api.CrossCheckViewT;
const LEDGER = FORGE.repos.find((r) => r.repo === "forge-ledger")!;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const ready = <T,>(data: T) => ({ state: "ready" as const, data });
const never = () => Promise.reject(new Error("no write in a render"));

describe("the page in the app's map", () => {
  it("is a Map page reached from Trust, and Catalog builds a Set up page reached from Scans", () => {
    expect(screenOf("#/crosscheck?repo=forge-ledger").id).toBe("crosscheck");
    expect(SCREENS.find((s) => s.id === "crosscheck")).toMatchObject({
      section: "Map",
      aside: true,
      label: X.title,
    });
    expect(SCREENS.find((s) => s.id === "catalog-builds")).toMatchObject({
      section: "SetUp",
      aside: true,
    });
  });

  it("is linked from each repo on Trust that has facts", () => {
    const repo: Api.TrustRepoT = {
      repo: "forge-ledger",
      facts: {
        path: "facts/forge-ledger.jsonl",
        present: true,
        count: 17,
        unverified: 0,
        commit: "0123abc",
      },
      verify: { path: "facts/forge-ledger.verify.yaml", report: null },
      checkout: { path: "workspace/forge-ledger", present: false },
      sameCommit: false,
      catalog: { from: "facts", fromFacts: 31, fromReaders: 0 },
      state: "trusted",
    };
    expect(html(<TrustRow r={repo} />)).toContain('href="#/crosscheck?repo=forge-ledger"');
    expect(html(<TrustRow r={{ ...repo, state: "not-read" } as Api.TrustRepoT} />)).not.toContain(
      "#/crosscheck",
    );
  });
});

describe("the filters", () => {
  it("opens on what the readers found, and counts each filter", () => {
    expect(firstShow(LEDGER.items)).toBe("readers-only");
    const n = showCounts(LEDGER.items);
    expect(n["readers-only"]).toBe(LEDGER.counts.readersOnly);
    expect(n.disagree).toBe(LEDGER.counts.disagree);
    expect(n["facts-only"]).toBe(LEDGER.counts.factsOnly);
    expect(n.all).toBe(LEDGER.items.length);
  });

  it("narrows by state, kind and words; dismissed items only under Dismissed and All", () => {
    const columns = itemsShown(LEDGER.items, { show: "readers-only", kind: "Column", find: "" });
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((i) => i.kind === "Column" && i.state === "readers-only")).toBe(true);
    const byFile = itemsShown(LEDGER.items, { show: "all", kind: "", find: "ledger-openapi" });
    expect(byFile.length).toBeGreaterThan(0);
    const one = { ...LEDGER.items[0]!, dismissed: true as const };
    const items = [one, ...LEDGER.items.slice(1)];
    expect(itemsShown(items, { show: "readers-only", kind: "", find: "" })).not.toContain(one);
    expect(itemsShown(items, { show: "dismissed", kind: "", find: "" })).toEqual([one]);
    expect(itemsShown(items, { show: "all", kind: "", find: "" })).toContain(one);
  });

  it("says a value in words", () => {
    expect(valueText("2500")).toBe("2500");
    expect(valueText({ method: "GET", path: "/a" })).toBe("method: GET · path: /a");
    expect(valueText(null)).toBe(X.nothing);
  });

  it("lists the compared repos first", () => {
    expect(reposInOrder(FORGE)[0]!.repo).toBe("forge-ledger");
  });
});

describe("Readers found / facts say, in every state", () => {
  const page = (o: Partial<Parameters<typeof CrossCheckPage>[0]> = {}) =>
    html(
      <CrossCheckPage
        list={ready(FORGE)}
        repo="forge-ledger"
        onRepo={() => undefined}
        one={ready(LEDGER)}
        show={undefined}
        onShow={() => undefined}
        run={never}
        {...o}
      />,
    );

  it("says it is loading, and why a load failed with Try again", () => {
    expect(page({ list: { state: "loading" } })).toContain('aria-busy="true"');
    const out = page({ list: { state: "error", error: "boom", reload: () => undefined } as never });
    expect(out).toContain('role="alert"');
    expect(out).toContain(COPY.app.tryAgain);
  });

  it("says there is nothing to compare when no repo has facts", () => {
    const none = { repos: FORGE.repos.filter((r) => r.state === "no-facts"), problems: [] };
    expect(page({ list: ready(none) })).toContain(esc(X.empty));
  });

  it("shows what the readers found, each with its line, and a Dismiss for each", () => {
    const out = page();
    expect(out).toContain(esc(X.title));
    expect(out).toContain(esc(X.commits("aaaaaaa", "0123abc")));
    const found = LEDGER.items.filter((i) => i.state === "readers-only");
    for (const i of found.slice(0, 3)) {
      expect(out).toContain(esc(X.dismissOf(i.key)));
      const c = i.readers!.cites[0]!;
      expect(out).toContain(esc(`${c.file}:${c.line}`));
    }
    // Two lines for one endpoint: the controller and the OpenAPI file beside it.
    expect(out).toContain("api/ledger-openapi.yaml:6");
    expect(out).toContain("src/main/java/forge/ledger/LedgerEndpoints.java:8");
    expect(out).toContain(`aria-label="${esc(X.listLabel("forge-ledger"))}"`);
    // The filter is a group of radios (the arrow keys move between them).
    expect(out).toMatch(/<fieldset class="xc-show"><legend[^>]*>Show<\/legend>/);
    expect(out).toContain('type="radio"');
    expect(out).toContain(esc(X.filter["readers-only"]!(LEDGER.counts.readersOnly)));
  });

  it("shows both values of a disagreement in a table", () => {
    const out = html(
      <RepoCrossCheckView
        of={ready(LEDGER)}
        show="disagree"
        onShow={() => undefined}
        run={never}
      />,
    );
    expect(out).toContain(`<caption class="sr">${esc(X.fieldsCaption("Component|ledger-api"))}`);
    expect(out).toContain("forge-service");
    expect(out).toContain(">service<");
    expect(out).toContain('scope="col">Readers');
  });

  it("says facts only items are for information, with no Dismiss", () => {
    const out = html(
      <RepoCrossCheckView
        of={ready(LEDGER)}
        show="facts-only"
        onShow={() => undefined}
        run={never}
      />,
    );
    expect(out).toContain(esc(X.factsOnlyNote));
    expect(out).not.toContain(">Dismiss<");
  });

  it("says a repo not yet compared, and why", () => {
    for (const state of ["no-readers", "legacy", "no-facts"] as const) {
      const out = html(
        <RepoCrossCheckView
          of={ready({ ...LEDGER, state, items: [] })}
          show={undefined}
          onShow={() => undefined}
          run={never}
        />,
      );
      expect(out).toContain(esc(X.state[state]!));
    }
    const legacy = X.state.legacy!;
    expect(legacy).toMatch(/Kept from before the upgrade, not yet read/);
  });

  it("says when the readers and the facts agree on everything", () => {
    const out = html(
      <RepoCrossCheckView
        of={ready({ ...LEDGER, items: [] })}
        show={undefined}
        onShow={() => undefined}
        run={never}
      />,
    );
    expect(out).toContain(esc(X.allAgree));
  });

  it("says a slot behind the base clone is read at its own commit", () => {
    const out = html(
      <RepoCrossCheckView
        of={ready({ ...LEDGER, head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })}
        show={undefined}
        onShow={() => undefined}
        run={never}
      />,
    );
    expect(out).toContain(esc(X.behind("bbbbbbb")));
  });
});

describe("promote to assert (ADR 0195 point 3)", () => {
  const steps = { preview: never, promote: never };
  const BALANCE = "Endpoint|GET /accounts/{}/balance";
  const view = (items: Api.CrossCheckItemT[] = LEDGER.items, withSteps = true) =>
    html(
      <RepoCrossCheckView
        of={ready({ ...LEDGER, items })}
        show="all"
        onShow={() => undefined}
        run={never}
        {...(withSteps ? { steps } : {})}
      />,
    );
  const promoted = (state: "written" | "verified" | "rejected", message?: string) =>
    LEDGER.items.map((i) =>
      i.key === BALANCE
        ? {
            ...i,
            promoted: {
              fact: "person-endpoint-0123456789ab",
              state,
              file: "src/main/java/forge/ledger/LedgerEndpoints.java",
              line: 8,
              ...(message ? { message } : {}),
            },
          }
        : i,
    );

  it("offers it on what only the readers found, not on a disagreement, a dismissed or a facts-only item", () => {
    const out = view();
    const found = LEDGER.items.filter((i) => i.state === "readers-only" && !i.dismissed);
    for (const i of found) expect(out).toContain(`aria-label="${esc(X.promoteOf(i.key))}"`);
    for (const i of LEDGER.items.filter((x) => x.state !== "readers-only" || x.dismissed))
      expect(out).not.toContain(`aria-label="${esc(X.promoteOf(i.key))}"`);
    // Nothing opens or writes until pressed: no dialog in the page as it loads.
    expect(out).not.toContain('role="dialog"');
    // Without the steps (a test or an old server) it isn't offered.
    expect(view(LEDGER.items, false)).not.toContain(esc(X.promote));
  });

  it("says where a promoted fact stands: not verified yet, verified on its line, or rejected", () => {
    const written = view(promoted("written"));
    expect(written).toContain(esc(X.promoted.written!));
    expect(written).toContain(
      "person-endpoint-0123456789ab · src/main/java/forge/ledger/LedgerEndpoints.java:8",
    );
    expect(written).not.toContain(`aria-label="${esc(X.promoteOf(BALANCE))}"`);
    const verified = view(promoted("verified"));
    expect(verified).toContain(esc(X.promoted.verified!));
    expect(verified).toContain(esc(X.promotedVerifiedHint("forge-ledger")));
    const rejected = view(promoted("rejected", "value-not-on-line: it isn't on line 8"));
    expect(rejected).toContain(esc(X.promoted.rejected!));
    expect(rejected).toContain("value-not-on-line: it isn&#x27;t on line 8");
    expect(rejected).toContain(esc(X.promotedRejectedHint));
    // A rejected fact can be promoted again once the line is checked.
    expect(rejected).toContain(`aria-label="${esc(X.promoteOf(BALANCE))}"`);
  });

  it("shows the fact it writes before it writes it: the kind, the cited line and its text", () => {
    const plan: Api.CrossCheckPromoteViewT = {
      repo: "forge-ledger",
      key: BALANCE,
      can: true,
      factsFile: "facts/forge-ledger.jsonl",
      fact: "person-endpoint-0123456789ab",
      factKind: "entry",
      line: "{}",
      sha256: "1".repeat(64),
      cite: {
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 8,
        value: "/accounts/{id}/balance",
        text: '  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance")',
        commit: "a".repeat(40),
      },
      fromSnapshot: true,
    };
    const out = html(<PromotePreview plan={plan} />);
    expect(out).toContain(esc(X.promoteFact("entry", "person-endpoint-0123456789ab")));
    expect(out).toContain(
      esc(X.promoteCite("src/main/java/forge/ledger/LedgerEndpoints.java:8", "aaaaaaa")),
    );
    expect(out).toContain(`<pre class="xc-line mono">${esc(plan.cite!.text!)}</pre>`);
    expect(out).toContain(esc(X.promoteValue("/accounts/{id}/balance")));
    expect(out).toContain(esc(X.promoteInto("facts/forge-ledger.jsonl")));
    expect(out).toContain(esc(X.promoteFromSnapshot("facts/forge-ledger.jsonl")));
    const noText = { ...plan, cite: { ...plan.cite!, text: undefined } } as never;
    expect(html(<PromotePreview plan={noText} />)).toContain(esc(X.promoteNoText));
  });
});
