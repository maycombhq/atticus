/**
 * The "Atticus" output channel as the extension writes it. VS Code keeps the channel in its log
 * folder, the log people attach to a support ticket, so every line it gets is checked here:
 *
 * - a secret is never written: the app's session token (said after "session token is", or one
 *   the extension made and registered with `hideInLog`) becomes "(hidden)";
 * - each line starts with the time, so a log says how long a step took (the app's start, say).
 *
 * Nothing here imports `vscode`: service.ts wraps the channel, and this is tested outside it.
 */

export interface LineChannel {
  append(value: string): void;
  appendLine(value: string): void;
}

const secrets = new Set<string>();

/** Keep a value out of the channel from now on (the session token the extension gives the app). */
export function hideInLog(secret: string): void {
  if (secret.length >= 8) secrets.add(secret);
}

/** The text with every secret replaced by "(hidden)". */
export function maskSecrets(text: string): string {
  let out = text.replace(/(session token is )\S+/gi, "$1(hidden)");
  for (const s of secrets) out = out.split(s).join("(hidden)");
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");

/** 14:03:07.215: the local time, to the millisecond. */
export function timeOf(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** The channel, each line it is given masked and stamped with the time. */
export function guardChannel<T extends LineChannel>(
  channel: T,
  now: () => Date = () => new Date(),
): T {
  const appendLine = channel.appendLine.bind(channel);
  const append = channel.append.bind(channel);
  return new Proxy(channel, {
    get(target, prop) {
      if (prop === "appendLine")
        return (value: string) => {
          const at = timeOf(now());
          appendLine(
            maskSecrets(value)
              .split("\n")
              .map((l) => `[${at}] ${l}`)
              .join("\n"),
          );
        };
      if (prop === "append") return (value: string) => append(maskSecrets(value));
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
