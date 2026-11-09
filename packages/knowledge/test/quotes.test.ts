import { describe, expect, it } from "vitest";
import { checkQuote } from "../src/quotes.js";

/** Review round 50: the quote check matches whole words, and forgives inline Markdown. */
describe("checkQuote: whole words", () => {
  it("doesn't match a quote inside a longer word at its start", () => {
    expect(
      checkQuote("# Deploys\n\nUnsafe to deploy on Fridays.\n", "safe to deploy on Fridays").ok,
    ).toBe(false);
    expect(
      checkQuote(
        "# Auth\n\nInvalid tokens are rejected at the gateway.\n",
        "valid tokens are rejected at the gateway",
      ).ok,
    ).toBe(false);
    expect(
      checkQuote(
        "# T\n\nServices cannot call the ledger directly.\n",
        "not call the ledger directly",
      ).ok,
    ).toBe(false);
  });

  it("doesn't match a quote that stops inside a word or a number", () => {
    expect(checkQuote("# T\n\nThe timeout is 500 ms per call.\n", "The timeout is 5").ok).toBe(
      false,
    );
    expect(checkQuote("# T\n\nThe timeout is 500 ms per call.\n", "The timeout is 5.").ok).toBe(
      false,
    );
  });

  it("finds the whole-word match after a match inside a word", () => {
    const page = "# Deploys\n\nUnsafe to deploy on Fridays.\n\nSafe to deploy on Mondays.\n";
    expect(checkQuote(page, "safe to deploy on")).toMatchObject({ ok: false });
    expect(checkQuote(page, "Safe to deploy on Mondays")).toMatchObject({ ok: true, line: 5 });
    const two = "# T\n\nThe timeout is 500 ms. The timeout is 5 seconds.\n";
    expect(checkQuote(two, "The timeout is 5")).toMatchObject({ ok: true, line: 3 });
  });

  it("still matches whole words, a quote ending at punctuation and one starting with it", () => {
    const page = '# T\n\nThe timeout is 5 seconds, "always".\n';
    expect(checkQuote(page, "The timeout is 5 seconds").ok).toBe(true);
    expect(checkQuote(page, "timeout is 5 seconds,").ok).toBe(true);
    expect(checkQuote(page, '"always". and more').ok).toBe(false);
    expect(checkQuote(page, 'is 5 seconds, "always"').ok).toBe(true);
  });
});

describe("checkQuote: inline Markdown and typography", () => {
  const ok = (page: string, quote: string, section?: string) => checkQuote(page, quote, section).ok;

  it("reads bold, emphasis, strike-through and code as their text", () => {
    expect(ok("# R\n\nNever **retry** a payment call.\n", "Never retry a payment call")).toBe(true);
    expect(ok("# R\n\nNever __retry__ a _payment_ call.\n", "Never retry a payment call")).toBe(
      true,
    );
    expect(ok("# R\n\nNever ~~ever~~ retry a call.\n", "Never ever retry a call")).toBe(true);
    expect(
      ok("# R\n\nSet `maxRetries` to 3 for refunds.\n", "Set maxRetries to 3 for refunds"),
    ).toBe(true);
    // A quote that keeps the page's marks matches too.
    expect(ok("# R\n\nNever **retry** a payment call.\n", "Never **retry** a payment call")).toBe(
      true,
    );
    // Underscores inside a word are the word's.
    expect(ok("# R\n\nSet max_retry_count to 3.\n", "Set max_retry_count to 3")).toBe(true);
  });

  it("reads a link and an image as their text", () => {
    expect(
      ok(
        "# R\n\nUse the [payments gateway](https://x.example/gw) for refunds.\n",
        "Use the payments gateway for refunds",
      ),
    ).toBe(true);
    expect(
      ok(
        "# R\n\nUse the [payments gateway][gw] for refunds.\n",
        "Use the payments gateway for refunds",
      ),
    ).toBe(true);
  });

  it("reads entities, inline HTML and zero-width spaces as what a reader sees", () => {
    expect(ok("# R\n\nThe R&amp;D team owns the sandbox.\n", "The R&D team owns the sandbox")).toBe(
      true,
    );
    expect(
      ok("# R\n\nThe limit is 30&nbsp;seconds per call.\n", "The limit is 30 seconds per call"),
    ).toBe(true);
    expect(
      ok("# R\n\nThe limit is 30​seconds per call.\n", "The limit is 30seconds per call"),
    ).toBe(true);
    expect(
      ok(
        "# R\n\nRefunds <b>must</b> be approved by <em>finance</em>.\n",
        "Refunds must be approved by finance",
      ),
    ).toBe(true);
    expect(
      ok(
        "# R\n\nUse the \\*nightly\\* batch for refunds.\n",
        "Use the *nightly* batch for refunds",
      ),
    ).toBe(true);
  });

  it("reads dashes and an ellipsis as their ASCII forms", () => {
    expect(ok("# R\n\nRefunds take 3–5 working days.\n", "Refunds take 3-5 working days")).toBe(
      true,
    );
    expect(ok("# R\n\nRefunds take 3-5 working days.\n", "Refunds take 3—5 working days")).toBe(
      true,
    );
    expect(ok("# R\n\nWait… then retry the transfer.\n", "Wait... then retry the transfer")).toBe(
      true,
    );
  });

  it("reads a setext heading as a heading", () => {
    const page =
      "Retries\n=======\n\nRetry at most twice per call.\n\nTimeouts\n--------\n\nWait 30 seconds.\n";
    expect(checkQuote(page, "Retry at most twice per call", "Retries")).toMatchObject({
      ok: true,
      line: 4,
      section: "Retries",
    });
    expect(checkQuote(page, "Wait 30 seconds", "Timeouts")).toMatchObject({
      ok: true,
      section: "Timeouts",
    });
    // A thematic break after a blank line is not a heading.
    const rule = "# R\n\nRetry at most twice per call.\n\n---\n\nWait 30 seconds always.\n";
    expect(checkQuote(rule, "Wait 30 seconds always", "R")).toMatchObject({ ok: true });
  });

  it("still forgives nothing else, and whole words hold through the folding", () => {
    expect(ok("# R\n\nNever **retry** a payment call.\n", "Never retry the payment call")).toBe(
      false,
    );
    expect(ok("# D\n\n**Un**safe to deploy on Fridays.\n", "safe to deploy on Fridays")).toBe(
      false,
    );
  });
});
