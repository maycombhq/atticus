/**
 * The app in a VS Code panel from the extension's own files (ADR 0097). The extension ships the
 * app's build (media/app/) and loads its index.html into the panel, so no page on 127.0.0.1 has
 * to be framed: that works where an organisation's VS Code blocks framing, and over SSH or in a
 * container. The page's API calls come to the extension as messages; it answers them from the
 * local API, which keeps the session token. No `vscode` here, so it is tested outside the editor.
 */
import { APP_HOME } from "./surface";

/** Only the app's own screens: #/<screen>[/<id>][?query]. */
const SCREEN_HASH = /^#\/[a-z][a-z0-9-]*(\/[^?\s"<>]*)?(\?[^\s"<>]*)?$/;

export function bundledHtml(
  index: string,
  o: { base: string; cspSource: string; nonce: string; hash?: string },
): string {
  const hash = o.hash && SCREEN_HASH.test(o.hash) ? o.hash : APP_HOME;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${o.nonce}' ${o.cspSource}`,
    `style-src ${o.cspSource} 'unsafe-inline'`,
    `font-src ${o.cspSource} data:`,
    `img-src ${o.cspSource} data:`,
    `connect-src ${o.cspSource}`,
    "worker-src blob:",
  ].join("; ");
  // The files get their full address, never a <base>: under a <base> the app's own links
  // (#/architecture) point at another page, which a panel refuses, so clicking them did nothing.
  // The scripts load from there, so what they import or start resolves next to them.
  return index
    .replace(/\s*<meta name="atticus-token"[^>]*>/, "")
    .replace(/\b(src|href)="\.\//g, `$1="${o.base}`)
    .replace(
      /<head>/,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <script nonce="${o.nonce}">location.hash = ${JSON.stringify(hash)};</script>`,
    )
    .replace(/<script (?!nonce)/g, `<script nonce="${o.nonce}" `);
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type Msg = Record<string, unknown>;

/** The reply to one message from the page, or undefined when it isn't a call. */
export async function answerApp(
  m: unknown,
  call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: unknown }>,
): Promise<Msg | undefined> {
  if (typeof m !== "object" || m === null || (m as Msg).type !== "api") return undefined;
  const { id, method, path, body } = m as Msg;
  const refuse = (detail: string) => ({
    type: "api-reply",
    id,
    status: 400,
    body: { type: "about:blank", title: "Not a call the app makes", status: 400, detail },
  });
  if (typeof method !== "string" || !METHODS.has(method))
    return refuse(`No method ${String(method)}.`);
  if (typeof path !== "string" || !/^\/api\/[^\s]*$/.test(path) || path.includes(".."))
    return refuse("Only the local API's own paths, /api/…");
  try {
    const r = await call(method, path, body);
    return { type: "api-reply", id, status: r.status, body: r.body };
  } catch (e) {
    return {
      type: "api-reply",
      id,
      status: 503,
      body: {
        type: "about:blank",
        title: "The Atticus app isn't answering",
        status: 503,
        detail: (e as Error).message,
      },
    };
  }
}
