/**
 * A file rewritten keeps its line endings: a Windows file's CRLF stays CRLF (where Git doesn't
 * normalise them, the whole file would otherwise show as changed in the upgrade's pull request).
 */
export function keepLineEndings(was: string, now: string): string {
  return was.includes("\r\n") ? now.replace(/\r?\n/g, "\r\n") : now;
}
