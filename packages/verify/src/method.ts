import type { Fact } from "@maycombhq/core";

/**
 * P2: the HTTP method an entry or a call claims, looked for in the code: on its cited line, the
 * line after it, or a `cite.with` line. A text check that reads any language, with no parser:
 * each line is split into words at every non-letter and at each camelCase capital
 * (`@GetMapping` → get, mapping; `HttpGet`; `RequestMethod.POST`; `rest.getForObject`), and the
 * method must be one of them. A method found on none of those lines is a note in verify's
 * report, counted, never a rejection (yet).
 */

/** The HTTP methods checked; anything else (`ANY`, `*`) isn't looked for. */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** A line's words, lowercased: split at non-letters and at camelCase capitals. */
function wordsOf(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Whether any of the lines writes the method as a word of its own. */
export function methodOnLines(method: string, lines: readonly string[]): boolean {
  const m = method.toLowerCase();
  return lines.some((l) => wordsOf(l).includes(m));
}

/** A fact whose claimed method its lines don't write (P2): a note, not a rejection. */
export interface MethodUnseen {
  id: string;
  kind: "entry" | "call";
  method: string;
  /** `file:line` of the fact's cite. */
  cite: string;
  message: string;
}

/**
 * The note for one fact, or undefined when its method is written on its cited line, the next
 * line or a `cite.with` line, or it claims no HTTP method. `lines` gives a file's lines.
 */
export function methodUnseenOf(
  f: Fact,
  lines: (path: string) => readonly string[] | undefined,
): MethodUnseen | undefined {
  if (f.kind !== "entry" && f.kind !== "call") return undefined;
  if (!f.method || !HTTP_METHODS.has(f.method.toUpperCase())) return undefined;
  const at = (file: string, line: number) => lines(file)?.[line - 1];
  const looked = [
    at(f.cite.file, f.cite.line),
    at(f.cite.file, f.cite.line + 1),
    ...(f.cite.with ?? []).map((p) => at(p.file, p.line)),
  ].filter((l): l is string => l !== undefined);
  if (methodOnLines(f.method, looked)) return undefined;
  const cite = `${f.cite.file}:${f.cite.line}`;
  const method = f.method.toUpperCase();
  return {
    id: f.id,
    kind: f.kind,
    method,
    cite,
    message: `${f.id} claims ${method}, which neither ${cite}, the next line, nor a cite.with line writes`,
  };
}
