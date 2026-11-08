/** The oldest Node Atticus runs on: doctor's MIN_NODE and package.json's engines say the same. */
export const NODE_NEEDED = "22.13";

/** Whether a Node version (`process.versions.node`) is older than Atticus needs. */
export function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 22 || (major === 22 && minor < 13);
}

/** What `atticus` says on an older Node, instead of failing on whatever it meets first. */
export const nodeTooOldMessage = (version: string) =>
  `Atticus needs Node.js ${NODE_NEEDED} or later; this is Node ${version}. Install a newer Node (from your company's software portal, or nodejs.org), then run atticus again.`;
