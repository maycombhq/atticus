import type { AiRequest, ToolBox } from "@maycombhq/ai";

/**
 * The `check_draft` tool for a stage's drafter in model mode (ADR 0087 addendum, W3a), as this
 * CLI offers it beside the context tools. The planner does the work (`draftCheckBox`); it is
 * loaded on the first call, so a command that never drafts doesn't load it.
 */
export function draftCheckTool(root: string, request: AiRequest): ToolBox | undefined {
  if (
    !request.selfCheck ||
    !/^(feature|architecture|stories|small)-answer\.yaml$/.test(request.outputPath)
  )
    return undefined;
  let box: Promise<ToolBox | undefined> | undefined;
  const planner = () =>
    (box ??= import("@maycombhq/planner").then((p) => p.draftCheckBox(root, request)));
  return {
    definitions: [
      {
        name: "check_draft",
        description:
          "Check your draft the way the stage will: give your whole answer, as YAML. Returns each problem with its line and what is allowed, or that it is clean. Call it before you answer, and again after each fix, until it is clean.",
        inputSchema: {
          type: "object",
          properties: { draft: { type: "string", description: "Your whole answer, as YAML." } },
          required: ["draft"],
        },
      },
    ],
    call: async (name, input) => (await planner())!.call(name, input),
  };
}

/** Two tool boxes as one: a name in the second is answered by it. */
export function bothTools(a: ToolBox, b: ToolBox | undefined): ToolBox {
  if (!b) return a;
  const own = new Set(b.definitions.map((d) => d.name));
  return {
    definitions: [...a.definitions.filter((d) => !own.has(d.name)), ...b.definitions],
    call: (name, input) => (own.has(name) ? b.call(name, input) : a.call(name, input)),
  };
}
