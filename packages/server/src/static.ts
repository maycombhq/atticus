import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

/**
 * The app's files. index.html gets the session token in its <meta name="atticus-token">: only a
 * page from this server can read it (other sites can't read a cross-origin response, and the
 * Host check stops DNS rebinding), so the app can call the API without the person pasting it.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticFile {
  status: number;
  type: string;
  body: Buffer | string;
  cache: string;
}

/** Content-Security-Policy for the app: everything from this server, nothing from elsewhere. */
export function appCsp(port: number): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function staticFile(dir: string, path: string, token: string): Promise<StaticFile> {
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    return { status: 400, type: TYPES[".txt"]!, body: "Bad path", cache: "no-store" };
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = normalize(join(dir, rel));
  if (file !== dir && !file.startsWith(dir.endsWith(sep) ? dir : dir + sep))
    return { status: 404, type: TYPES[".txt"]!, body: "Not found", cache: "no-store" };
  const info = await stat(file).catch(() => undefined);
  // An unknown path that isn't a file is a screen the app routes itself: hand out the app.
  const target = info?.isFile() ? file : extname(rel) ? undefined : join(dir, "index.html");
  if (!target) return { status: 404, type: TYPES[".txt"]!, body: "Not found", cache: "no-store" };
  const ext = extname(target).toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  if (ext === ".html") {
    const html = (await readFile(target, "utf8")).replace(
      /<meta name="atticus-token" content="[^"]*"\s*\/?>/,
      `<meta name="atticus-token" content="${escapeAttr(token)}" />`,
    );
    return { status: 200, type, body: html, cache: "no-store" };
  }
  return {
    status: 200,
    type,
    body: await readFile(target),
    // Built assets carry a content hash in their name.
    cache: /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(target)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
}
