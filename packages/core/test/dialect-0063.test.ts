import { describe, expect, it } from "vitest";
import { parseTemplate, renderTemplate, type TemplateSource } from "../src/index.js";

/** ADR 0063: the before/after filters. */

describe("before and after filters (ADR 0063)", () => {
  const value = (v: string) => (s: TemplateSource) => (s.type === "attr" ? v : undefined);

  it("keep the text before or after the first occurrence of their argument", () => {
    expect(renderTemplate("${attr.route_key | after(' ')}", value("GET /orders/{id}"))).toBe(
      "/orders/{id}",
    );
    expect(renderTemplate("${attr.route_key | before(' ')}", value("GET /orders/{id}"))).toBe(
      "GET",
    );
    expect(
      renderTemplate(
        "${attr.arn | after(':function:')}",
        value("arn:aws:lambda:eu:1:function:quote"),
      ),
    ).toBe("quote");
  });

  it("give an empty value when the argument isn't there, which default can fill", () => {
    expect(renderTemplate("${attr.route_key | after(' ')}", value("$default"))).toBe("");
    expect(renderTemplate("${attr.route_key | before(' ')}", value("$default"))).toBe("");
    expect(renderTemplate("${attr.route_key | after(' ') | default('/')}", value("$default"))).toBe(
      "/",
    );
  });

  it("need an argument", () => {
    expect(() => parseTemplate("${attr.x | after}")).toThrow(/after needs a value/);
    expect(() => parseTemplate("${attr.x | before}")).toThrow(/before needs a value/);
    expect(() => parseTemplate("${attr.x | lower('a')}")).toThrow(/takes no argument/);
  });
});
