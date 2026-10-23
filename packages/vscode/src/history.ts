import { randomBytes } from "node:crypto";
import type { Cli } from "./types";

/**
 * The prompt history from VS Code (ADR 0110): every `@atticus` request and the reply the
 * extension streamed go to `atticus history add`, the text on stdin, so only the command line
 * writes `.atticus/history/`. VS Code gives an extension its own chat participant's requests and
 * nothing else: Copilot's other chats can't be recorded, and nothing here tries to.
 */

/** The app's Prompt history screen. */
export const HISTORY_HASH = "#/history";

/** A request as the person typed it: `@atticus /stories add-transfer-limit`. */
export function promptText(r: { command?: string; prompt: string }): string {
  return ["@atticus", ...(r.command ? [`/${r.command}`] : []), r.prompt.trim()]
    .filter(Boolean)
    .join(" ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** A request turn of a chat's history (vscode.ChatRequestTurn): it has the prompt. */
const isRequest = (t: unknown): t is { prompt: string; command?: string } =>
  !!t && typeof (t as { prompt?: unknown }).prompt === "string";
const keyOf = (t: { prompt: string; command?: string }) => `${t.command ?? ""}\u0000${t.prompt}`;

/**
 * The session of a request. VS Code names no chat, so a chat is known by its first request: a
 * request with no history starts a new session, and the later ones of that chat (whose history
 * begins with that request) share it.
 */
export class ChatSessions {
  private readonly byFirst = new Map<string, string>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => string = () => randomBytes(3).toString("hex"),
  ) {}

  sessionFor(request: { prompt: string; command?: string }, history: readonly unknown[]): string {
    const first = history.find(isRequest);
    const key = keyOf(first ?? request);
    const known = first ? this.byFirst.get(key) : undefined;
    if (known) return known;
    const id = `vscode-${stamp(this.now())}-${this.random()}`;
    this.byFirst.set(key, id);
    return id;
  }
}

/** A chat stream whose markdown is also kept, to record as the reply; every call passes on. */
export function recordingStream<S extends object>(stream: S): { stream: S; text: () => string } {
  const parts: string[] = [];
  const wrapped = new Proxy(stream, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (prop !== "markdown") return (v as (...a: unknown[]) => unknown).bind(target);
      return (m: unknown, ...rest: unknown[]) => {
        parts.push(
          typeof m === "string"
            ? m
            : typeof (m as { value?: unknown })?.value === "string"
              ? (m as { value: string }).value
              : "",
        );
        return (v as (...a: unknown[]) => unknown).call(target, m, ...rest);
      };
    },
  });
  return { stream: wrapped, text: () => parts.join("").trim() };
}

/**
 * Record a request, then its reply once it has ended: one `atticus history add` each. The command
 * line says when recording is off; a failure is never the chat's.
 */
export async function recordChat(
  cli: Cli,
  root: string,
  c: { session: string; command?: string; prompt: string; response: Promise<string> },
): Promise<void> {
  const add = async (kind: "prompt" | "response", text: string) => {
    if (!text.trim()) return;
    try {
      await cli(
        [
          "history",
          "add",
          "--surface",
          "vscode",
          "--kind",
          kind,
          "--session",
          c.session,
          ...(c.command ? ["--command", c.command] : []),
          "--root",
          root,
        ],
        undefined,
        text,
      );
    } catch {
      // The history is a record, not the work: the chat goes on without it.
    }
  };
  await add("prompt", c.prompt);
  const reply = await c.response.catch(() => "");
  await add("response", reply);
}
