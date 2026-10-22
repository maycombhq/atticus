/**
 * The links a page gives (ADR 0101): a request's form in the service-desk catalogue, a runbook,
 * a contact page. A knowledge item keeps the links under the heading it quotes, and any the AI
 * names that are on the page; a link the page doesn't have is refused.
 */

export interface PageLink {
  url: string;
  label?: string;
}

const LINK =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()[\]"'`]+)/g;

/** Every link in a text, in order, each once: Markdown links keep their label. */
export function linksIn(text: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const add = (raw: string, label?: string) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) return;
    seen.add(url);
    out.push(label?.trim() ? { label: label.trim(), url } : { url });
  };
  for (const m of text.matchAll(LINK)) {
    if (m[2]) add(m[2], m[1]);
    else if (m[3]) add(m[3]);
    else if (m[4]) add(m[4]);
  }
  return out;
}

/**
 * The text of the section a line is in: from the heading above it to the next heading of the
 * same or a higher level (1-based line; the whole text when there is no heading above).
 */
export function sectionAt(text: string, line: number): string {
  const lines = text.split(/\r?\n/);
  const at = Math.max(0, Math.min(line - 1, lines.length - 1));
  let start = 0;
  let level = 7;
  for (let i = at; i >= 0; i--) {
    const h = /^(#{1,6})\s/.exec(lines[i]!);
    if (h) {
      start = i;
      level = h[1]!.length;
      break;
    }
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]!);
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
