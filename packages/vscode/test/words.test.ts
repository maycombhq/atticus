import { describe, expect, it } from "vitest";
import { commandTitle, stepTitle } from "../src/words";

/** ADR 0098: the extension speaks in plain words first; the command is beside it, not instead. */

describe("the next step, in plain words", () => {
  it("says what the step does, naming the repo or change", () => {
    const s = (step: string, o: Record<string, string> = {}) =>
      stepTitle({ step, command: "atticus x", why: "Because. Then more.", ...o });
    expect(s("accept", { repo: "nadiengine" })).toBe(
      "Review and accept nadiengine's scan proposal",
    );
    expect(s("survey", { repo: "forge-web" })).toBe("Draft forge-web's scan settings with Copilot");
    expect(s("spec", { repo: "forge-web" })).toBe("Draft forge-web's spec with Copilot");
    expect(s("feature", { change: "add-note-tags" })).toBe(
      "Place add-note-tags on the flows and features",
    );
    expect(s("answer")).toBe("Answer the open questions");
    expect(s("new-change")).toBe("Start a change");
  });

  it("names what a change needs from the organisation by the change's title (ADR 0101)", () => {
    const titles = (id: string) =>
      id === "let-a-chat-member-export"
        ? "Let a chat member export the chat's messages"
        : undefined;
    const why =
      "let-a-chat-member-export is placed on the estate: your assistant says what it needs.";
    expect(
      stepTitle(
        {
          step: "needs",
          command: "atticus change needs let-a-chat-member-export",
          why,
          change: "let-a-chat-member-export",
        },
        titles,
      ),
    ).toBe("Find what “Let a chat member export the chat's messages” needs from the organisation");
    expect(
      stepTitle(
        {
          step: "raise-needs",
          command: "atticus needs --change let-a-chat-member-export",
          why,
          change: "let-a-chat-member-export",
          person: true,
        },
        titles,
      ),
    ).toBe("Raise “Let a chat member export the chat's messages”'s open needs");
    // Without its title, the id, never the why's raw text.
    expect(stepTitle({ step: "needs", command: "x", why, change: "add-tags" })).toBe(
      "Find what add-tags needs from the organisation",
    );
  });

  it("falls back to the first sentence of why, for a step it doesn't know", () => {
    expect(
      stepTitle({ step: "brand-new", command: "atticus y", why: "Do the new thing. More." }),
    ).toBe("Do the new thing");
  });
});

describe("a command, in plain words", () => {
  it("leads with what the command does, from its summary", () => {
    expect(
      commandTitle(
        "Your assistant reads the repo and drafts its scan settings (folders to leave out, path prefixes, client base URLs); checked against the code [--attempts 3] [--force]",
      ),
    ).toBe("Your assistant reads the repo and drafts its scan settings");
    expect(commandTitle("Start a change from a template: --type <type>")).toBe(
      "Start a change from a template",
    );
    expect(commandTitle("Check record files: schema, location and canonical form")).toBe(
      "Check record files",
    );
    expect(commandTitle("")).toBe("");
  });
});

describe("keeping the knowledge current, in plain words (ADR 0101)", () => {
  it("names the org pack draft, its accept and checking what changes use", () => {
    const s = (step: string) => stepTitle({ step, command: "atticus x", why: "Because." });
    expect(s("orgpack-draft")).toBe("Draft the org pack's systems from the wikis");
    expect(s("accept-orgpack")).toBe("Accept the systems drafted from the wikis");
    expect(s("verify-knowledge")).toBe("Check the knowledge items your changes use");
  });
});
