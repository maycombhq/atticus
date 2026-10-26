import { setupProgress, type SetupStep } from "./guided";
import type { NextStep } from "./types";
import { modelChoice, modelSetting, stepTitle, WORDS, type ChangeTitles } from "./words";

/**
 * The Next and Waiting section's rows (ADR 0090, 0098, 0100; Phase D), as plain data: view.ts turns them into tree
 * items. Every row a person can act on runs something when clicked: the next step and each step
 * after it run through atticus.runStep (the same path as Run the next step), a setup step runs
 * its fix. No `vscode` here, so it is tested outside the editor.
 */

export type NextNode =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "next"; step: NextStep }
  | { kind: "then"; step: NextStep }
  | { kind: "no-next" }
  | { kind: "setup"; steps: SetupStep[] }
  | { kind: "setup-step"; step: SetupStep }
  | { kind: "app" }
  /**
   * What runs a step (ADR 0121 item 6): runtime.yaml's line, and the model the next step will
   * run on in VS Code (its addendum): its kind's first choice, as a setting says it (`model`),
   * and its kind (`stepClass`) when the next step is an AI step.
   */
  | { kind: "runs"; runs: string; model: string; stepClass?: string }
  | { kind: "no-root" }
  /** Phase D: what waits on you, under the steps (Next and Waiting); its rows are view.ts's. */
  | { kind: "waiting" };

export interface NextRow {
  label: string;
  id?: string;
  description?: string;
  /** Markdown, unless plain is set. */
  tooltip?: string;
  plain?: boolean;
  icon: string;
  /** For the inline Run button (package.json menus). */
  context?: string;
  command?: { command: string; title: string; args?: unknown[] };
  /** A parent row: open or closed to start with. */
  expanded?: boolean;
}

export function nextRow(node: NextNode, titles?: ChangeTitles): NextRow {
  switch (node.kind) {
    case "loading":
      return { label: "Reading the metarepo...", icon: "loading~spin" };
    case "no-root":
      return {
        label: "Open the metarepo folder (the one with org-pack/).",
        icon: "info",
        command: { command: "vscode.openFolder", title: "Open a folder" },
      };
    case "error":
      return {
        label: node.message,
        icon: "warning",
        tooltip: `${node.message}\nThe commands run are in the Atticus output.`,
        plain: true,
        command: { command: "atticus.showLog", title: "Show the commands run" },
      };
    case "next":
    case "then": {
      const s = node.step;
      return {
        label: stepTitle(s, titles),
        tooltip: `${node.kind === "next" ? "**Next:** " : ""}${s.why}\n\n\`${s.command}\`\n\nClick to ${s.person ? "take this step" : "run it"}.`,
        description:
          node.kind === "next"
            ? s.person
              ? "your step"
              : "next"
            : s.person
              ? "your step"
              : "then",
        icon: node.kind === "next" ? "arrow-right" : "circle-small",
        context: "atticus.next",
        command: { command: "atticus.runStep", title: "Run this step", args: [s] },
      };
    }
    case "setup": {
      const p = setupProgress(node.steps);
      return {
        id: "setup",
        label: `Set up: ${p.done} of ${p.total} done`,
        expanded: !p.complete,
        description: p.complete ? "accept the catalog" : p.next ? `next: ${p.next.label}` : "",
        tooltip:
          "The setup checklist (atticus setup), until the catalog is accepted. Click to do the next step.",
        icon: "checklist",
        command: p.next
          ? { command: "atticus.setupStep", title: "Do it", args: [p.next.id] }
          : { command: "atticus.acceptCatalog", title: "Accept the catalog" },
      };
    }
    case "setup-step": {
      const s = node.step;
      return {
        id: `setup:${s.id}`,
        label: s.label,
        description: s.done ? s.detail : s.optional ? "optional" : s.detail,
        tooltip: `${s.label}${s.detail ? `: ${s.detail}` : ""}${s.done ? "\n\nDone. Click to do it again." : `\n\n${s.fix ?? ""}\n\nClick to do it.`}`,
        icon: s.done ? "pass-filled" : s.optional ? "circle-small" : "circle-large-outline",
        ...(s.done ? {} : { context: "atticus.setupStep" }),
        command: { command: "atticus.setupStep", title: "Do it", args: [s.id] },
      };
    }
    case "no-next":
      return { label: "Nothing to do next: everything is up to date.", icon: "check" };
    case "runs": {
      const c = modelChoice(node.model);
      const here =
        c === "configured" ? WORDS.modelConfigured : c ? modelSetting(c) : WORDS.modelChatOrCopilot;
      return {
        label: node.runs,
        description: WORDS.runsModel(node.stepClass, here),
        icon: "hubot",
        tooltip:
          "How AI steps run here, from runtime.yaml (Set up › AI in the app), and the model VS Code runs the next step on: its kind of step's model (atticus.models.*), else runtime.yaml's for it, else atticus.model. Click to pick the model.",
        plain: true,
        command: { command: "atticus.pickModel", title: WORDS.pickModel },
      };
    }
    case "app":
      return {
        label: "Open the app",
        icon: "type-hierarchy",
        tooltip:
          "The app with its diagrams, in a VS Code tab. Atticus: Open the app in the browser opens it there instead.",
        plain: true,
        command: { command: "atticus.showApp", title: "Open the app" },
      };
    case "waiting":
      return {
        id: "next:waiting",
        label: WORDS.waitingHead,
        tooltip: WORDS.waitingHeadTip,
        plain: true,
        icon: "bell",
        expanded: true,
      };
  }
}
