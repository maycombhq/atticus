// Vitest global setup: tests make their folders with mkdtemp(tmpdir()) and most never remove
// them (a thousand after a few runs on one laptop). Point the temp folder at a fresh one per
// package run, which the workers inherit, and remove it when the run ends. The name is short:
// Windows paths stop at 260 characters and tests nest Git worktrees deep inside it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "at-"));
  for (const k of ["TMPDIR", "TEMP", "TMP"]) process.env[k] = dir;
  // Review round 50: what Atticus keeps for the person outside the metarepo (the user's state
  // folder) goes to the run's own temporary folder, never the real one.
  process.env.XDG_STATE_HOME = join(dir, "state");
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
