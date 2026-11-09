import { Api } from "@maycombhq/core";

/**
 * Review round 48 (ADR 0186): what the app's page does when the person clicks a write to a
 * shared system: ask the server for a confirmation of that write and target, with the page key
 * the server put in the page. A script with only the session token can't.
 */
export async function confirmFor(
  srv: { url: string; token: string; pageKey: string },
  write: Api.ConfirmedWriteT,
  target: string,
): Promise<string> {
  const r = await fetch(`${srv.url}/api/confirmations`, {
    method: "POST",
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    body: JSON.stringify({ write, target, pageKey: srv.pageKey }),
  });
  if (r.status !== 201) throw new Error(`No confirmation (${r.status}): ${await r.text()}`);
  return Api.ConfirmationView.parse(await r.json()).confirmation;
}

/** A POST body as the app sends it: a task's PR carries the person's confirmation of it. */
export async function asTheApp(
  srv: { url: string; token: string; pageKey: string },
  path: string,
  body: unknown = {},
): Promise<string> {
  const pr = /^\/api\/changes\/([^/]+)\/tasks\/([^/]+)\/pr$/.exec(path);
  if (!pr) return JSON.stringify(body);
  const confirmation = await confirmFor(srv, "task-pr", `${pr[1]}/${pr[2]}`);
  return JSON.stringify({ ...(body as object), confirmation });
}
