import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { runsDirOf, type ChangeRepos } from "@maycombhq/core";
import { intellijProjectPath, vscodeWorkspacePath, WORKSPACE_DIR } from "./layout.js";

/**
 * Per-change editor workspaces, so the assistant (Copilot or Claude Code) sees exactly the
 * metarepo and the change's worktrees, plus the context pack when one has been built.
 * No editor plugin is needed: VS Code opens a .code-workspace file, IntelliJ opens a folder
 * with an .idea project. Paths are relative, so the files work wherever the metarepo lives.
 */

const posix = (p: string) => p.split(sep).join("/");

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function vscodeWorkspace(root: string, repos: ChangeRepos): object {
  const from = join(root, WORKSPACE_DIR);
  const folders: { name: string; path: string }[] = [
    { name: "metarepo", path: posix(relative(from, root)) },
  ];
  for (const r of repos.repos)
    folders.push({ name: r.id, path: posix(relative(from, join(root, r.worktree))) });
  const runs = join(runsDirOf(root), repos.change);
  if (existsSync(runs)) folders.push({ name: "context pack", path: posix(relative(from, runs)) });
  return {
    folders,
    settings: {
      // The metarepo folder must not show the clones a second time.
      "files.exclude": { workspace: true, ".index": true },
      "search.exclude": { workspace: true, ".index": true, ".runs": true },
      "git.autoRepositoryDetection": "subFolders",
    },
  };
}

/** IntelliJ project files for the change: one module per worktree plus the metarepo. */
export function intellijProject(root: string, repos: ChangeRepos): Record<string, string> {
  const projectDir = intellijProjectPath(root, repos.change);
  const ideaDir = join(projectDir, ".idea");
  const rel = (p: string) => "$MODULE_DIR$/" + posix(relative(ideaDir, p));
  const projectRel = (p: string) => "$PROJECT_DIR$/" + posix(relative(projectDir, p));
  const modules: { name: string; dir: string; excludes: string[] }[] = [
    { name: "metarepo", dir: root, excludes: [join(root, WORKSPACE_DIR), join(root, ".index")] },
    ...repos.repos.map((r) => ({ name: r.id, dir: join(root, r.worktree), excludes: [] })),
  ];
  const runs = join(runsDirOf(root), repos.change);
  if (existsSync(runs)) modules.push({ name: "context-pack", dir: runs, excludes: [] });

  const files: Record<string, string> = {};
  files[".name"] = `${repos.change}\n`;
  files["modules.xml"] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="4">`,
    `  <component name="ProjectModuleManager">`,
    `    <modules>`,
    ...modules.map(
      (m) =>
        `      <module fileurl="file://$PROJECT_DIR$/.idea/${xmlEscape(m.name)}.iml" filepath="$PROJECT_DIR$/.idea/${xmlEscape(m.name)}.iml" />`,
    ),
    `    </modules>`,
    `  </component>`,
    `</project>`,
    ``,
  ].join("\n");
  for (const m of modules) {
    files[`${m.name}.iml`] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<module type="GENERAL_MODULE" version="4">`,
      `  <component name="NewModuleRootManager" inherit-compiler-output="true">`,
      `    <exclude-output />`,
      `    <content url="file://${xmlEscape(rel(m.dir))}">`,
      ...m.excludes.map((e) => `      <excludeFolder url="file://${xmlEscape(rel(e))}" />`),
      `    </content>`,
      `    <orderEntry type="sourceFolder" forTests="false" />`,
      `  </component>`,
      `</module>`,
      ``,
    ].join("\n");
  }
  files["vcs.xml"] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="4">`,
    `  <component name="VcsDirectoryMappings">`,
    // The metarepo and each worktree are separate Git repositories.
    ...modules
      .filter((m) => m.name !== "context-pack")
      .map((m) => `    <mapping directory="${xmlEscape(projectRel(m.dir))}" vcs="Git" />`),
    `  </component>`,
    `</project>`,
    ``,
  ].join("\n");
  return files;
}

export async function writeEditorWorkspaces(
  root: string,
  repos: ChangeRepos,
): Promise<{ vscode: string; intellij: string }> {
  const vscode = vscodeWorkspacePath(root, repos.change);
  await mkdir(join(root, WORKSPACE_DIR), { recursive: true });
  await writeFile(vscode, JSON.stringify(vscodeWorkspace(root, repos), null, 2) + "\n", "utf8");

  const intellij = intellijProjectPath(root, repos.change);
  const ideaDir = join(intellij, ".idea");
  await rm(ideaDir, { recursive: true, force: true });
  await mkdir(ideaDir, { recursive: true });
  for (const [name, text] of Object.entries(intellijProject(root, repos))) {
    await writeFile(join(ideaDir, name), text, "utf8");
  }
  return { vscode, intellij };
}

export async function removeEditorWorkspaces(root: string, change: string): Promise<void> {
  await rm(vscodeWorkspacePath(root, change), { force: true });
  await rm(intellijProjectPath(root, change), { recursive: true, force: true });
}
