import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { screenOf } from "../src/app/screens.js";
import { branchesOf, RepoRow } from "../src/screens/run/Repos.js";

/** Set up › Repos (ADR 0123): each repo's branches, scanned beside the baseline and compared. */

const R = COPY.repos;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const REPO: Api.RepoBranchesViewT = {
  id: "forge-notes",
  platform: "forge",
  url: "https://git.example.com/forge/forge-notes.git",
  type: "spring-boot",
  owner: "team-notes",
  defaultBranch: "main",
  remoteDefault: "develop",
  branches: ["develop", "release/2026.11"],
  commit: "0123456789abcdef0123456789abcdef01234567",
  scans: [
    {
      branch: "develop",
      scannedAt: "2026-10-24T06:00:00Z",
      commit: "89abcdef0123456789abcdef0123456789abcdef",
    },
  ],
};

describe("Set up › Repos (ADR 0123)", () => {
  it("is a tab of Set up", () => {
    expect(screenOf("repos")?.section).toBe("SetUp");
  });

  it("shows the default branch and its commit, the remote's default when it differs, and the other branches", () => {
    const out = renderToStaticMarkup(<RepoRow r={REPO} />);
    expect(out).toContain("forge-notes");
    expect(out).toContain(esc(R.atCommit("0123456")));
    expect(out).toContain(esc(R.remoteSays("develop")));
    expect(out).toContain("develop, release/2026.11");
    expect(out).toContain(esc(R.scanned("develop", "2026-10-24", "89abcde")));
    expect(out).toContain(esc(R.scan("release/2026.11")));
    expect(out).toContain(esc(R.compare("develop", "main")));
    expect(out).toContain(esc(R.edit));
  });

  it("says nothing about the remote when it agrees, and none listed when there are no branches", () => {
    const out = renderToStaticMarkup(
      <RepoRow r={{ ...REPO, remoteDefault: "main", branches: [], scans: [] }} />,
    );
    expect(out).not.toContain(esc(R.remoteSays("main")));
    expect(out).toContain(esc(R.noBranches));
  });

  it("reads branches one a line or comma-separated, without blanks or repeats", () => {
    expect(branchesOf("develop\n\nrelease/2026.11, develop ,")).toEqual([
      "develop",
      "release/2026.11",
    ]);
  });
});
