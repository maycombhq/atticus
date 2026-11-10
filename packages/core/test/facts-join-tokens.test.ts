import { describe, expect, it } from "vitest";
import { joinFacts, placeholderIn, type Fact, type JoinRepo } from "../src/index.js";

/**
 * The forms a value names a setting in (J0), each one resolver of the same kind: Spring's
 * `${name}` and `${name:default}`, `env:NAME`, a build or deploy tool's `@name@` token, and a
 * template's `{{name}}` (a Mustache or Jinja value, a CI variable). A Helm expression
 * (`{{ .Values.host }}`) names no setting by itself and is left alone, as before.
 */
describe("placeholderIn: the token forms a setting is named in", () => {
  it("reads each form, with what is around it", () => {
    expect(placeholderIn("${forge.gw.host}")).toMatchObject({ name: "forge.gw.host" });
    expect(placeholderIn("${HOST:gw.forge.example}")).toMatchObject({
      name: "HOST",
      fallback: "gw.forge.example",
    });
    expect(placeholderIn("env:GW_HOST")).toMatchObject({ name: "GW_HOST" });
    expect(placeholderIn("@targetLedgerUrl@/v1")).toMatchObject({
      name: "targetLedgerUrl",
      before: "",
      after: "/v1",
    });
    expect(placeholderIn("https://{{ gateway_host }}/v1")).toMatchObject({
      name: "gateway_host",
      before: "https://",
      after: "/v1",
    });
  });

  it("leaves a Helm expression and plain text alone", () => {
    expect(placeholderIn("{{ .Values.route.host }}")).toBeUndefined();
    expect(placeholderIn("https://gw.forge.example")).toBeUndefined();
  });

  it("resolves a {{name}} host through the setting of that name", () => {
    const cite = { file: "deploy/vars.yml", line: 1, value: "x" };
    const base = { repo: "forge-teller", commit: "abc1234", verified: "line", by: "assistant" };
    const repos: JoinRepo[] = [
      {
        repo: "forge-teller",
        component: "teller-api",
        facts: [
          {
            ...base,
            kind: "call",
            id: "call.get.limits",
            callType: "rest",
            method: "GET",
            path: "/limits",
            host: "https://{{ limits_host }}",
            cite: { ...cite, file: "src/Client.java", value: "/limits" },
          },
          {
            ...base,
            kind: "config",
            id: "config.limits-host",
            settingKind: "config",
            key: "limits_host",
            value: "limits.forge.internal",
            cite,
          },
        ] as Fact[],
      },
      {
        repo: "forge-limits",
        component: "limits-api",
        hosts: ["limits.forge.internal"],
        facts: [
          {
            ...base,
            repo: "forge-limits",
            kind: "entry",
            id: "entry.get.limits",
            entryType: "rest",
            method: "GET",
            path: "/limits",
            cite: { ...cite, file: "src/Limits.java", value: "/limits" },
          },
        ] as Fact[],
      },
    ];
    const out = joinFacts({ repos });
    const [j] = out.joins;
    expect(j).toMatchObject({ how: "host", entry: { fact: "entry.get.limits" } });
  });
});
