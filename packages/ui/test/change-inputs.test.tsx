import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { ChangeInputs, toBase64 } from "../src/screens/ChangeInputs.js";

/** ADR 0113: "Attach a file" on a change's pages. */
const T = COPY.changes;

describe("the change's files attached", () => {
  it("has a labelled file picker with its help, and shows loading until the list comes", () => {
    const out = renderToStaticMarkup(<ChangeInputs change="add-limit" />);
    expect(out).toContain(T.attachLabel);
    expect(out).toMatch(/<label for="([^"]+)"[^>]*>Attach a file<\/label><input id="\1"/);
    expect(out).toContain('type="file"');
    expect(out).toMatch(/aria-describedby="[^"]+-help"/);
    expect(out).toContain(T.attachHelp.replace(/'/g, "&#x27;"));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(`<h2 id="p-files-attached" class="h">${T.inputs}</h2>`);
  });

  it("sends a file's bytes as base64, however big", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(toBase64(new TextEncoder().encode("# Limits\n"))).toBe("IyBMaW1pdHMK");
  });

  it("says what a file is, whether it was read, and when one hides instructions", () => {
    expect(T.inputRead("text", "page")).toBe("Read, cited by page");
    expect(T.inputRead("needs-reading")).toBe("Not read: open it to see it");
    expect(T.inputWhen("pat", "2026-10-23T09:00:00Z")).toBe("pat, 2026-10-23");
    expect(T.attachTooLarge(22)).toMatch(/up to 15 MB/);
  });

  it("can copy a file into general knowledge, and says the change keeps it (ADR 0122)", () => {
    expect(T.promoteFor("inputs/refund-rules.pdf")).toBe(
      "Copy inputs/refund-rules.pdf to general knowledge",
    );
    expect(T.promoted("inputs/refund-rules.pdf")).toMatch(/inputs\/inbox\/.*keeps its copy/);
  });
});
