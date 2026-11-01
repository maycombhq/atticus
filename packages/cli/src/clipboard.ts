import { spawn } from "node:child_process";

/**
 * Put a line on the person's clipboard (ADR 0161): Windows `clip`, macOS `pbcopy`, Linux
 * `wl-copy` under Wayland, else `xclip`. No shell; the text goes on the tool's standard input.
 * Resolves false when none is there or it fails, and the caller just prints the line.
 */
export function clipboardTools(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { file: string; args: string[] }[] {
  if (platform === "win32") return [{ file: "clip", args: [] }];
  if (platform === "darwin") return [{ file: "pbcopy", args: [] }];
  return [
    ...(env.WAYLAND_DISPLAY ? [{ file: "wl-copy", args: [] }] : []),
    { file: "xclip", args: ["-selection", "clipboard"] },
  ];
}

const tryTool = (tool: { file: string; args: string[] }, text: string) =>
  new Promise<boolean>((resolve) => {
    try {
      const p = spawn(tool.file, tool.args, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.on("error", () => resolve(false));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });

export async function copyToClipboard(text: string): Promise<boolean> {
  for (const tool of clipboardTools()) if (await tryTool(tool, text)) return true;
  return false;
}
