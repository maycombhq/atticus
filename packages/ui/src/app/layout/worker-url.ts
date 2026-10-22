/**
 * A Web Worker's script must come from the page's own origin. In the browser the app and its
 * assets share one (the local server). In a VS Code panel (ADR 0097) the page and its files don't,
 * so the worker gets a same-origin copy of its own script, made from the file the panel serves.
 */
export async function usableWorkerUrl(
  url: string,
  here: string = location.href,
  get: (u: string) => Promise<string> = (u) => fetch(u).then((r) => r.text()),
  copy: (text: string) => string = (text) =>
    URL.createObjectURL(new Blob([text], { type: "text/javascript" })),
): Promise<string> {
  const u = new URL(url, here);
  const page = new URL(here);
  if (u.origin !== "null" && u.origin === page.origin) return u.href;
  return copy(await get(u.href));
}
