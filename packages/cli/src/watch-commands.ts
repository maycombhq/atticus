import { changeStore } from "@maycombhq/changes";
import type { Output } from "./commands.js";
import { readMe, writeMe } from "./me-file.js";

/**
 * Watch a change (WP7.5): follow it without being on it. The person's own .atticus/me.yaml
 * (never committed) lists what they watch; the digest and `atticus watch` say how each is
 * doing: where it is, what blocks it, the questions that wait and what comes next.
 */

/** One line about a watched change, from its cockpit. */
export async function watchLine(root: string, change: string): Promise<string> {
  const { cockpit } = await import("./cockpit.js");
  try {
    const c = await cockpit(root, change);
    const parts = [
      `in ${c.state}`,
      ...(c.reasons.length
        ? [`${c.reasons.length} thing${c.reasons.length === 1 ? "" : "s"} block it`]
        : []),
      ...(c.openQuestions
        ? [`${c.openQuestions} question${c.openQuestions === 1 ? "" : "s"} wait`]
        : []),
    ];
    return `${change}: ${parts.join("; ")}. Next: ${c.nextStep}`;
  } catch {
    return `${change}: no longer there (archived or removed); atticus watch ${change} --off stops watching it.`;
  }
}

/**
 * atticus watch [<change>] [--off] [--json]: watch a change (or stop with --off); with no change,
 * say how each watched change is doing. Exit 0 done, 1 no such change, 2 for usage.
 */
export async function watchCommand(
  root: string,
  change: string | undefined,
  o: { off?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const me = await readMe(root);
  if (!change) {
    if (o.off) {
      io.err("Say which change to stop watching: atticus watch <change> --off");
      return 2;
    }
    const lines = [];
    for (const c of me.watch) lines.push(await watchLine(root, c));
    if (o.json) io.out(JSON.stringify({ watching: me.watch, lines }, null, 2));
    else if (!lines.length) io.out("You watch no change. atticus watch <change> starts.");
    else for (const l of lines) io.out(l);
    return 0;
  }
  if (o.off) {
    await writeMe(root, { ...me, watch: me.watch.filter((c) => c !== change) });
    io.out(`You no longer watch ${change}.`);
    return 0;
  }
  const known = await changeStore(root)
    .read(change)
    .then(
      () => true,
      () => false,
    );
  if (!known) {
    io.err(`There is no change ${change}: atticus change list shows them.`);
    return 1;
  }
  await writeMe(root, { ...me, watch: [...me.watch, change] });
  io.out(`You watch ${change}: your digest and atticus watch say how it is doing.`);
  io.out(await watchLine(root, change));
  return 0;
}
