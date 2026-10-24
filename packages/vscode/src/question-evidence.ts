import { join } from "node:path";

/**
 * Evidence beside a question in VS Code (WP7.2): each `path:line` a question cites, with the
 * text of that line, so a person answers looking at the code; picking one opens the file there.
 * A repo's question reads its code (the open folder or the base clone); a change's question, or
 * a repo not here, reads the metarepo. No `vscode` here, so it is tested outside the editor.
 */

export interface EvidenceRow {
  label: string;
  description: string;
  open?: { path: string; line: number };
}

export function evidenceRows(
  q: { repo: string; evidence: string[] },
  paths: { root: string; codeRoot: (repo: string) => string | undefined },
  read: (file: string) => string | undefined,
): EvidenceRow[] {
  const bases = [paths.codeRoot(q.repo), paths.root].filter((b): b is string => !!b);
  return q.evidence.map((ref) => {
    const m = /^(.+):(\d+)$/.exec(ref);
    if (m && !m[1]!.split(/[\\/]/).includes(".."))
      for (const base of bases) {
        const file = join(base, ...m[1]!.split("/"));
        const text = read(file);
        if (text === undefined) continue;
        const line = Number(m[2]);
        const at = text.replace(/\r\n?/g, "\n").split("\n")[line - 1];
        if (at === undefined) break;
        return { label: ref, description: at.trim(), open: { path: file, line } };
      }
    return { label: ref, description: "not here" };
  });
}
