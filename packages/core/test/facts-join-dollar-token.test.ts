import { describe, expect, it } from "vitest";
import { joinFacts, type Fact, type JoinRepo } from "../src/index.js";

/**
 * ADR 0195 addendum (a deploy token's host is asked, build 2.0.0-beta.28.1), its sub-addendum of
 * 2026-11-19: a host written as `${NAME}` that nothing sets is a deploy token nothing sets, as
 * `@name@` is: no file the join reads says where it goes, so a path guess would be an arrow no
 * line cites. It is asked about, never joined by its path alone. (A gateway's BasePath that
 * starts the whole path still joins it, as beta.25 decided: facts-join-gateway-review-b25.) The
 * same for the shell's `$NAME` and a Windows or CI `%NAME%`, which nothing resolves. One that
 * something sets, or that carries its own default, is resolved as before.
 */

const fact = (repo: string, id: string, kind: string, extra: Record<string, unknown>): Fact =>
  ({
    kind,
    id,
    repo,
    commit: "8888ccc",
    cite: { file: "src/app.ts", line: 3, value: "x" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;
const ledger = (hosts: string[] = []): JoinRepo => ({
  repo: "forge-ledger",
  component: "ledger-api",
  hosts,
  facts: [
    fact("forge-ledger", "e-put-statement", "entry", {
      entryType: "rest",
      method: "PUT",
      path: "/v1/statements/{id}",
    }),
  ],
});
const put = (extra: Record<string, unknown>) =>
  fact("forge-payments", "c-put-statement", "call", {
    callType: "rest",
    method: "PUT",
    path: "/v1/statements/{id}",
    ...extra,
  });
const join1 = (payments: Fact[], other = ledger()) =>
  joinFacts({ repos: [{ repo: "forge-payments", facts: payments }, other] });

describe("a host written as ${NAME} that nothing sets is asked about, as @name@ is", () => {
  it("asks, for the call's host or base, and never joins it by its path", () => {
    for (const extra of [
      { host: "${FORGE_LEDGER_URL}" },
      { host: "https://${FORGE_LEDGER_URL}/v1" },
      { host: "${FORGE_LEDGER_URL}:8443" },
      { base: "${FORGE_LEDGER_URL}" },
      { base: "${forge.ledger.url}/v1" },
      { base: "${FORGE_LEDGER_URL:-}" },
      // Nothing resolves the shell's `$NAME` or a Windows or CI `%NAME%`: unset to the join.
      { host: "$FORGE_LEDGER_URL" },
      { base: "$FORGE_LEDGER_URL/v1" },
      { host: "%FORGE_LEDGER_URL%" },
    ]) {
      const out = join1([put(extra)]);
      const what = JSON.stringify(extra);
      expect(out.joins, what).toEqual([]);
      expect(
        out.asks.map((a) => [a.call.fact, a.reason]),
        what,
      ).toEqual([["c-put-statement", "unknown-host"]]);
    }
  });

  it("asks when the setting the base names is itself ${NAME} that nothing sets", () => {
    const yml = fact("forge-payments", "cfg-ledger", "config", {
      key: "forge.ledger.url",
      value: "${FORGE_LEDGER_URL}",
      cite: { file: "src/main/resources/application.yml", line: 4, value: "${FORGE_LEDGER_URL}" },
    });
    const out = join1([put({ base: "${forge.ledger.url}" }), yml]);
    expect(out.joins).toEqual([]);
    expect(out.asks.map((a) => a.reason)).toEqual(["unknown-host"]);
  });

  it("joins it by its host as before when a setting sets it, or its default names the host", () => {
    const set = fact("forge-payments", "cfg-ledger", "config", {
      key: "FORGE_LEDGER_URL",
      value: "https://ledger.apps.forge.internal",
      cite: { file: "deploy/configmap.yaml", line: 5, value: "FORGE_LEDGER_URL" },
    });
    const listed = ledger(["ledger.apps.forge.internal"]);
    const bySetting = join1([put({ base: "${FORGE_LEDGER_URL}" }), set], listed);
    expect(bySetting.joins.map((j) => [j.call.fact, j.how])).toEqual([["c-put-statement", "host"]]);
    const byDefault = join1(
      [put({ base: "${FORGE_LEDGER_URL:https://ledger.apps.forge.internal}" })],
      listed,
    );
    expect(byDefault.joins.map((j) => [j.call.fact, j.how])).toEqual([["c-put-statement", "host"]]);
    // The shell's default, after `:-`, as Spring's after `:`.
    const byShellDefault = join1(
      [put({ base: "${FORGE_LEDGER_URL:-https://ledger.apps.forge.internal}" })],
      listed,
    );
    expect(byShellDefault.joins.map((j) => [j.call.fact, j.how])).toEqual([
      ["c-put-statement", "host"],
    ]);
  });

  it("keeps a host ${NAME} is only part of as it was: a placeholder host joined by its path", () => {
    const part = join1([put({ host: "ledger-${ENV}.apps.forge.internal" })]);
    expect(part.asks).toEqual([]);
    expect(part.joins.map((j) => j.entry.fact)).toEqual(["e-put-statement"]);
  });
});
