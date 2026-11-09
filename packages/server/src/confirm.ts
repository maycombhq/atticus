import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Api } from "@maycombhq/core";
import { HttpError } from "./http.js";

/**
 * Review round 48 (ADR 0186): a write to a shared system from the app (a PR, a push, a merge, a
 * message, a team's tool, where the model's key goes) needs a person's confirmation, not only the
 * session token: `atticus ui --show-token` prints that token for assistants and scripts, so it
 * can't stand for the person's yes. The app's page asks for a confirmation when the person
 * clicks; only the page can, with the page key the server puts in the page and never prints. A
 * confirmation is for one write and one target, used once, and expires after two minutes.
 */

export type ConfirmedWrite = Api.ConfirmedWriteT;

/** How long a confirmation lasts: long enough for the click's call, too short to keep. */
export const CONFIRM_TTL_MS = 120_000;
/** At most this many wait at once; the oldest goes first (a page that asks and never writes). */
const MAX_OPEN = 256;

export class Confirmations {
  private open = new Map<string, { write: string; target: string; until: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(write: ConfirmedWrite, target: string): Api.ConfirmationViewT {
    const t = this.now();
    for (const [k, v] of this.open) if (v.until < t) this.open.delete(k);
    while (this.open.size >= MAX_OPEN) this.open.delete(this.open.keys().next().value!);
    const confirmation = randomBytes(32).toString("base64url");
    const until = t + CONFIRM_TTL_MS;
    this.open.set(confirmation, { write, target, until });
    return { confirmation, write, target, expiresAt: new Date(until).toISOString() };
  }

  /**
   * Whether `given` confirms this write of this target now. It is spent whatever the answer, so a
   * confirmation is never tried twice: a replay, another target or another write is refused.
   */
  take(write: ConfirmedWrite, target: string, given: unknown): boolean {
    if (typeof given !== "string" || !given) return false;
    const c = this.open.get(given);
    if (!c) return false;
    this.open.delete(given);
    return c.write === write && c.target === target && this.now() <= c.until;
  }
}

/** Whether two secrets are the same, in a time that doesn't say how much of them matched. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What each write is, and how a person does it without the app, for the 403's words. */
const WITHOUT_THE_APP: Record<ConfirmedWrite, { what: string; cli: string }> = {
  handoff: {
    what: "Raising a hand-off opens a PR",
    cli: "atticus change handoff <change> --approve",
  },
  "release-prs": {
    what: "Raising the release PRs pushes the change branch and opens PRs",
    cli: "atticus change release-prs <change> --approve",
  },
  merge: { what: "Merging a ready PR", cli: "atticus change sync <change> --approve" },
  "task-pr": {
    what: "Raising a task's PR pushes its branch and opens a PR",
    cli: "atticus task run <change> <task> --level pr --approve",
  },
  "digest-send": {
    what: "Sending the digest posts a message",
    cli: "atticus digest --send",
  },
  propose: {
    what: "Propose for review pushes a branch and opens a PR",
    cli: "git commit, push and open the PR yourself",
  },
  "step-run": {
    what: "Running a step with a team's tool acts on their systems",
    cli: "atticus todo run <step> --with <executor> --approve <you> --inputs <sha-256>",
  },
  "ai-model": {
    what: "Changing where runtime.yaml sends the model's key (its provider, keyEnv or address)",
    cli: "edit runtime.yaml yourself and propose it for review",
  },
  "ai-test": {
    what: "Testing model settings that aren't committed sends the key to them",
    cli: "commit runtime.yaml first, or run the step from the command line",
  },
};

/** The 403 for a write that came without the person's confirmation. */
export function needsConfirmation(write: ConfirmedWrite): HttpError {
  const w = WITHOUT_THE_APP[write];
  return new HttpError(
    403,
    "This needs a person's confirmation",
    `${w.what}, which a person confirms: click it in the Atticus app, or run ${w.cli} in a terminal. The session token alone (atticus ui --show-token, for assistants and scripts) never approves a write to a shared system (ADR 0186).`,
    { confirm: write },
  );
}

/** Take the person's confirmation for this write, or refuse it with 403. */
export function requireConfirmation(
  c: Confirmations,
  write: ConfirmedWrite,
  target: string,
  given: unknown,
): void {
  if (!c.take(write, target, given)) throw needsConfirmation(write);
}
