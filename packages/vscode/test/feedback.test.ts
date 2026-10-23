import { describe, expect, it } from "vitest";
import {
  aiProgressTitle,
  emptyBelow,
  errorLabel,
  findOutcome,
  loadingLabel,
  runProgressTitle,
  upgradeNotice,
} from "../src/feedback";

describe("the upgrade check when the window opens", () => {
  it("says what the upgrade does, not a line that ends in a colon", () => {
    expect(
      upgradeNotice(
        "1 upgrade step to run (atticus upgrade):\n  gates.yaml at version 2: the critic round limit written out: 1 file\n",
      ),
    ).toBe(
      "The metarepo needs 1 upgrade step: gates.yaml at version 2: the critic round limit written out: 1 file",
    );
    expect(
      upgradeNotice("3 upgrade steps to run (atticus upgrade):\r\n  a: 1 file\r\n  b\r\n  c\r\n"),
    ).toBe("The metarepo needs 3 upgrade steps: a: 1 file, and 2 more");
    expect(upgradeNotice("")).toBe("The metarepo needs an upgrade");
  });
});

/**
 * What a person reads between a click and its result (0.3.1): every run says in plain words what
 * it is doing, every section and part of one says it is reading, and what finds nothing says so.
 */

describe("what an AI step says while it runs", () => {
  it("says what Copilot is doing, in plain words", () => {
    expect(aiProgressTitle(["knowledge", "find", "Kafka topic"])).toBe(
      "Searching the wikis for “Kafka topic”: Copilot reads the pages that mention it",
    );
    expect(aiProgressTitle(["knowledge", "find", "SSO", "--source", "forge-wiki"])).toBe(
      "Searching forge-wiki for “SSO”: Copilot reads the pages that mention it",
    );
    expect(aiProgressTitle(["knowledge", "scan"])).toBe(
      "Reading the wiki pages with Copilot (only those that changed)",
    );
    expect(aiProgressTitle(["knowledge", "scan", "--source", "forge-wiki"])).toBe(
      "Reading forge-wiki's pages with Copilot (only those that changed)",
    );
    expect(aiProgressTitle(["knowledge", "scan", "--full"])).toBe(
      "Reading every wiki page again with Copilot",
    );
    expect(aiProgressTitle(["knowledge", "ask", "Who owns payments?"])).toBe(
      "Asking the knowledge: “Who owns payments?”",
    );
    expect(aiProgressTitle(["change", "needs", "add-note-tags"])).toBe(
      "Finding what add-note-tags needs from the organisation, with Copilot",
    );
    expect(aiProgressTitle(["scan", "survey", "forge-notes"])).toBe(
      "Drafting forge-notes's scan settings with Copilot",
    );
    expect(aiProgressTitle(["scan", "verify", "forge-notes"])).toBe(
      "Checking forge-notes's scan against the code with Copilot",
    );
    expect(aiProgressTitle(["spec", "draft", "forge-notes"])).toBe(
      "Drafting forge-notes's spec with Copilot",
    );
    expect(aiProgressTitle(["change", "feature", "add-note-tags"])).toBe(
      "Placing add-note-tags on the flows and features, with Copilot",
    );
    expect(aiProgressTitle(["plan", "stories", "add-note-tags"])).toBe(
      "Writing add-note-tags's stories with Copilot",
    );
  });

  it("names the command when it has no words of its own for it", () => {
    expect(aiProgressTitle(["onboard", "forge-legacy"])).toBe(
      "Running atticus onboard forge-legacy with Copilot",
    );
  });
});

describe("what a command says while it runs", () => {
  it("says what it is doing, in plain words", () => {
    expect(runProgressTitle(["sources", "sync", "--source", "forge-wiki"])).toBe(
      "Copying forge-wiki's pages (a snapshot)",
    );
    expect(runProgressTitle(["sources", "sync"])).toBe("Copying every wiki's pages (a snapshot)");
    expect(runProgressTitle(["digest"])).toBe("Reading what waits on you");
    expect(runProgressTitle(["digest", "--send"])).toBe("Sending what waits on you");
    expect(runProgressTitle(["knowledge", "verify", "request-kafka-topic"])).toBe(
      "Recording that request-kafka-topic is right",
    );
    expect(runProgressTitle(["knowledge", "correct", "request-kafka-topic", "--set", "x=y"])).toBe(
      "Recording your correction of request-kafka-topic",
    );
    expect(runProgressTitle(["knowledge", "reject", "request-kafka-topic", "--note", "no"])).toBe(
      "Recording that request-kafka-topic is wrong",
    );
    expect(runProgressTitle(["knowledge", "keep", "request-kafka-acl", "--find", "kafka"])).toBe(
      "Keeping request-kafka-acl as a knowledge item you verified",
    );
    expect(runProgressTitle(["needs", "done", "add-note-tags", "request-kafka-topic"])).toBe(
      "Recording the need as done",
    );
    expect(runProgressTitle(["needs", "skip", "add-note-tags", "request-kafka-topic"])).toBe(
      "Recording the need as not needed",
    );
    expect(runProgressTitle(["needs", "reopen", "add-note-tags", "request-kafka-topic"])).toBe(
      "Opening the need again",
    );
    expect(runProgressTitle(["repos", "discover", "C:/clones", "--dry-run"])).toBe(
      "Looking for repos (a dry run: nothing is written)",
    );
    expect(runProgressTitle(["repos", "discover", "C:/clones"])).toBe(
      "Adding the repos to the manifest",
    );
    expect(runProgressTitle(["absorb", "C:/x", "--id", "x", "--dry-run", "--json"])).toBe(
      "Reading what it holds (a dry run: nothing is written)",
    );
    expect(runProgressTitle(["absorb", "accept", "x", "--dry-run", "--json"])).toBe(
      "Checking what accepting it copies (a dry run: nothing is written)",
    );
    expect(runProgressTitle(["orgpack", "draft", "--json"])).toBe(
      "Drafting the org pack's systems from the knowledge items",
    );
    expect(runProgressTitle(["scan"])).toBe("Scanning the repos (files only, no network)");
    expect(runProgressTitle(["next", "--json"])).toBe("Reading the next step");
  });

  it("names the command when it has no words of its own for it", () => {
    expect(runProgressTitle(["estate", "join"])).toBe("Running atticus estate join");
  });
});

describe("what a search of the wikis ended with", () => {
  it("says when no page mentions the phrase", () => {
    expect(
      findOutcome([
        'No page of the wikis mentions "Kafka topic". Nothing was sent to the assistant.',
      ]),
    ).toEqual({
      kind: "nothing",
      message: "No page of the wikis mentions “Kafka topic”. Nothing was sent to Copilot.",
    });
  });

  it("finds the search it saved", () => {
    expect(
      findOutcome([
        '"Kafka topic" is on 1 page: forge-wiki/messaging/kafka-topics.',
        "Saved in knowledge/finds/kafka-topic.yaml. Keep one with atticus knowledge keep <item> --find kafka-topic.",
      ]),
    ).toEqual({ kind: "saved", slug: "kafka-topic" });
    expect(findOutcome(["Saved in .atticus\\knowledge\\finds\\sso-intake-2.yaml."])).toEqual({
      kind: "saved",
      slug: "sso-intake-2",
    });
  });

  it("says when it can't tell", () => {
    expect(findOutcome([])).toEqual({ kind: "unknown" });
  });
});

describe("what a section shows while it reads, when it fails and when it is empty", () => {
  it("says what it is reading", () => {
    expect(loadingLabel("repos")).toBe("Reading the repos…");
    expect(loadingLabel("changes")).toBe("Reading the changes…");
    expect(loadingLabel("knowledge")).toBe("Reading the knowledge…");
    expect(loadingLabel("catalog")).toBe("Reading the catalog…");
    expect(loadingLabel("runs")).toBe("Reading the runs…");
    expect(loadingLabel("runs", "run")).toBe("Reading the run…");
    expect(loadingLabel("knowledge", "knowledge-group")).toBe("Reading the items…");
    expect(loadingLabel("changes", "needs")).toBe("Reading what it needs…");
    expect(loadingLabel("knowledge", "finds")).toBe("Reading the searches…");
    expect(loadingLabel("knowledge", "find")).toBe("Reading what it found…");
    expect(loadingLabel("knowledge", "last-scan")).toBe("Reading what the last scan changed…");
    expect(loadingLabel("repos", "flows")).toBe("Reading the flows…");
  });

  it("says why it couldn't read", () => {
    expect(errorLabel("connect ECONNREFUSED 127.0.0.1:4321")).toBe(
      "Couldn't read this: connect ECONNREFUSED 127.0.0.1:4321",
    );
  });

  it("says what fills a part that is empty", () => {
    expect(emptyBelow("tasks")).toBe("No tasks yet: the stories stage writes them.");
    expect(emptyBelow("targets")).toBe("No target flows yet: the feature stage writes them.");
    expect(emptyBelow("needs")).toBe("No needs: nothing to raise.");
    expect(emptyBelow("find")).toBe("Nothing found that isn't an item already.");
    expect(emptyBelow("last-scan")).toBe("The last scan changed nothing.");
    expect(emptyBelow("evidence")).toBe("Nothing here yet.");
  });
});
