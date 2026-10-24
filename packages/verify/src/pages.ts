import { normalizePath } from "@maycombhq/core";

/**
 * Routes a page's file gives (held-out run of ADR 0124 A4): a framework that routes by file
 * place writes the path on no line, so the verifier works it out from the file and checks the
 * line that makes the file a page.
 *
 * - Razor Pages: `Pages/<path>.cshtml` (or `Areas/<area>/Pages/...`) whose first line is
 *   `@page`; `Index` is its folder; a template after `@page` is appended (or replaces the path
 *   when it starts with `/`).
 * - WebForms: an `.aspx` page with a `<%@ Page` directive, at its path from the folder that
 *   holds `Web.config`.
 * - Next.js: `app/<path>/page.tsx` (route groups `(x)` left out) and `pages/<path>.tsx`
 *   (`index` is its folder); `[id]` and `[...id]` are parameters.
 */
export function pageRouteOf(
  file: string,
  lines: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  const first = lines.find((l) => l.trim() !== "")?.trim() ?? "";
  const razor = /(?:^|\/)(?:Areas\/([^/]+)\/)?Pages\/(.+)\.cshtml$/.exec(file);
  if (razor && /^@page\b/.test(first)) {
    const template = /^@page\s+"([^"]*)"/.exec(first)?.[1];
    if (template?.startsWith("/")) return template;
    const rel = razor[2]!.replace(/(^|\/)Index$/, "");
    const path = `${razor[1] ? `/${razor[1]}` : ""}/${rel}`.replace(/\/+$/, "") || "/";
    return template ? `${path.replace(/\/$/, "")}/${template}` : path;
  }
  if (/\.aspx$/i.test(file) && lines.some((l) => /<%@\s*Page\b/i.test(l))) {
    const dirs = file.split("/").slice(0, -1);
    for (let n = dirs.length; n >= 0; n--) {
      const root = dirs.slice(0, n).join("/");
      const at = (name: string) => (root ? `${root}/${name}` : name);
      if (exists(at("Web.config")) || exists(at("web.config")))
        return `/${file.slice(root ? root.length + 1 : 0)}`;
    }
    return undefined;
  }
  const param = (s: string) => s.replace(/^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/, "{$1}");
  const app = /(?:^|\/)(?:src\/)?app\/((?:.+\/)?)page\.[jt]sx?$/.exec(file);
  if (app)
    return (
      "/" +
      app[1]!
        .split("/")
        .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
        .map(param)
        .join("/")
    );
  const pages = /(?:^|\/)(?:src\/)?pages\/(.+)\.[jt]sx?$/.exec(file);
  if (pages && !/(^|\/)_(app|document|error)$/.test(pages[1]!))
    return (
      "/" +
      pages[1]!
        .replace(/(^|\/)index$/, "")
        .split("/")
        .filter(Boolean)
        .map(param)
        .join("/")
    );
  return undefined;
}

/** Whether a page's file gives this route (parameters in any style, letter case aside). */
export function pageRouteMatches(
  file: string,
  lines: readonly string[],
  exists: (path: string) => boolean,
  path: string,
): boolean {
  const route = pageRouteOf(file, lines, exists);
  if (route === undefined) return false;
  const norm = (p: string) =>
    normalizePath(p.replace(/\{([^}:?]*)[^}]*\}/g, "{$1}")).toLowerCase() || "/";
  return norm(route) === norm(path);
}
