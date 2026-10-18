import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/screens/know/common.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("the artifact Markdown view", () => {
  it("draws headings, lists and pipe tables, dropping the separator row", () => {
    const out = html(
      "# Tasks\n\n- [ ] 1.1 Add `V3__add_daily_limit.sql`\n\n| Story | Title |\n| --- | --- |\n| s1 | Refuse **over** limit |\n",
    );
    expect(out).toContain("Tasks</div>");
    expect(out).toContain("<li>1.1 Add <code");
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).not.toContain("---");
    expect(out).toContain("<strong>over</strong>");
  });

  it("never renders HTML from the artifact: tags come out as text", () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="x()">');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("joins a paragraph wrapped over several lines, and keeps lists after it in order", () => {
    const out = html("Portal customers can send\nany amount in one day.\n- first\n- second");
    expect(out).toContain("<p");
    expect(out).toContain("Portal customers can send any amount in one day.");
    expect(out.indexOf("any amount")).toBeLessThan(out.indexOf("<li>first"));
  });

  it("keeps fenced code as code", () => {
    expect(html("```\nflowchart LR\n  a --> b\n```")).toContain("<pre");
  });
});
