import type { Api } from "@maycombhq/core";
import { api, ApiError, renewedPageKey } from "./client.js";

/**
 * Review round 48 (ADR 0186): a write to a shared system (a hand-off PR, the release PRs, a
 * merge, a task's PR, the digest, Propose for review, a step with a team's tool, where the
 * model's key goes) is the person's, so their click asks the server for a confirmation of that
 * write and target first. Only this page can: it has the page key, which the server put in it
 * (or the VS Code panel did) and never prints, so an assistant or a script given the session
 * token can't. The confirmation is used once and lasts two minutes: one per click.
 */

/**
 * The page key, from <meta name="atticus-page-key">; empty where there is no page. Beta.27
 * review: after a restart of the server, the one read again with the session token.
 */
export function pageKey(): string {
  const renewed = renewedPageKey();
  if (renewed) return renewed;
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="atticus-page-key"]')?.content ?? "";
}

/** The person's confirmation of one write, to send in its body: `{ confirmation }`. */
export async function confirmed(
  write: Api.ConfirmedWriteT,
  target: string,
): Promise<{ confirmation?: string }> {
  const ask = (key: string) =>
    api<{ confirmation?: string } | undefined>("/api/confirmations", {
      method: "POST",
      body: { write, target, pageKey: key },
    });
  const sent = pageKey();
  let r: { confirmation?: string } | undefined;
  try {
    r = await ask(sent);
  } catch (e) {
    // Beta.27 re-review: right after a restart the call went again with the old page key, and
    // was refused (403, no page's): asked once more with the key read again with the new token.
    const refused = e instanceof ApiError && e.problem.status === 403;
    if (!refused || pageKey() === sent) throw e;
    r = await ask(pageKey());
  }
  return r?.confirmation ? { confirmation: r.confirmation } : {};
}
