import type { ManualStep } from "@maycombhq/core";
import type { Approval } from "../common.js";
import type {
  WorkItem,
  WorkItemInput,
  WorkItemQuery,
  WorkItemType,
  WorkTracker,
} from "../work-tracker.js";
import { ManualBase, provisionalId, stepOfProvisional, type ManualOptions } from "./base.js";
import { shortHash } from "./steps.js";

/** How the common trackers name each work item type in their forms. */
const TYPE_NAME: Record<WorkItemType, string> = {
  epic: "Epic",
  feature: "Feature",
  story: "User Story",
  task: "Task",
  bug: "Bug",
};

/** Reads work items from exports (intake's work-item reader, ADR 0032 point 3). */
export type WorkItemExportReader = () => Promise<WorkItem[]>;

/**
 * The work tracker when Atticus can't reach it: each create, update or link becomes a step
 * with every field ready to copy (or a CSV row to import); the person records the new item's
 * id. Until then the item has a provisional id (`manual:<step>`) that children can name as
 * their parent: the child's step says which id to use and depends on the parent's step.
 * Reads come from exported work items and from the steps already recorded.
 */
export class ManualWorkTracker extends ManualBase implements WorkTracker {
  constructor(
    opts: ManualOptions,
    private readonly exports: WorkItemExportReader = async () => [],
  ) {
    super("work-tracker", "work-tracker", opts);
  }

  private idPattern(): string {
    return this.setting("idPattern") ?? "[A-Za-z]*-?\\d+";
  }

  /** The real id once its step is recorded, else the id as given. */
  async resolveId(id: string): Promise<string> {
    const stepId = stepOfProvisional(id);
    if (!stepId) return id;
    const s = await this.opts.store.get(stepId);
    const real = s?.state === "done" ? s.recorded?.values.id : undefined;
    return typeof real === "string" ? real : id;
  }

  private parentField(parent: string | undefined, deps: string[]): string {
    if (!parent) return "";
    const stepId = stepOfProvisional(parent);
    if (!stepId) return parent;
    deps.push(stepId);
    return `the id you record for step ${stepId}`;
  }

  private itemFrom(step: ManualStep): WorkItem {
    const f = (n: string) => step.fields.find((x) => x.name === n)?.value ?? "";
    const rec = step.state === "done" ? step.recorded?.values : undefined;
    const type = (Object.entries(TYPE_NAME).find(([, v]) => v === f("Work item type"))?.[0] ??
      "task") as WorkItemType;
    const parent = (step.inputs.parent as string | undefined) ?? undefined;
    return {
      id: typeof rec?.id === "string" ? rec.id : provisionalId(step.id),
      type,
      title: f("Title"),
      description: f("Description"),
      acceptanceCriteria: f("Acceptance criteria"),
      state: rec ? "New" : "Not created yet",
      ...(parent ? { parent } : {}),
      ...(f("Assigned to") ? { assignee: f("Assigned to") } : {}),
      tags: f("Tags")
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean),
      url: typeof rec?.url === "string" ? rec.url : "",
    };
  }

  private async known(): Promise<WorkItem[]> {
    const created = await this.opts.store.list({
      system: "work-tracker",
      action: "create-work-item",
    });
    const fromSteps = created.map((s) => this.itemFrom(s));
    const exported = await this.exports();
    const ids = new Set(fromSteps.map((i) => i.id));
    return [...fromSteps, ...exported.filter((i) => !ids.has(i.id))];
  }

  async getItem(id: string): Promise<WorkItem> {
    this.journal.push({ method: "getItem" });
    const real = await this.resolveId(id);
    const item = (await this.known()).find((i) => i.id === real || i.id === id);
    return (
      item ??
      this.notFound(
        `work item ${id}`,
        "export the work items from the tracker into inputs/ (CSV or JSON) so Atticus can read them",
      )
    );
  }

  async query(q: WorkItemQuery): Promise<WorkItem[]> {
    this.journal.push({ method: "query" });
    const text = q.text?.toLowerCase();
    return (await this.known()).filter(
      (i) =>
        (!q.type || i.type === q.type) &&
        (!q.parent || i.parent === q.parent) &&
        (!q.state || i.state === q.state) &&
        (!q.tag || i.tags.includes(q.tag)) &&
        (!text ||
          i.title.toLowerCase().includes(text) ||
          i.description.toLowerCase().includes(text)),
    );
  }

  async createItem(input: WorkItemInput, approval: Approval): Promise<WorkItem> {
    const a = this.approve(approval);
    const deps: string[] = [];
    const parent = input.parent ? await this.resolveId(input.parent) : undefined;
    const keyTag = input.tags?.find((t) => t.startsWith("atticus:"));
    const proc = this.procedureFor("create-work-item");
    const step = await this.step(
      "createItem",
      {
        slug: `create-${input.type}-${input.title}`,
        action: "create-work-item",
        key: `work-tracker|create|${keyTag ?? `${input.type}|${input.title}`}`,
        title: `Create the ${TYPE_NAME[input.type].toLowerCase()} "${input.title}" in the work tracker`,
        where: `Work tracker${this.setting("project") ? `, project ${this.setting("project")}` : ""}: new ${TYPE_NAME[input.type]}`,
        ...(proc ?? {}),
        inputs: {
          type: input.type,
          title: input.title,
          ...(parent ? { parent } : {}),
        },
        fields: [
          { name: "Work item type", value: TYPE_NAME[input.type] },
          { name: "Title", value: input.title },
          { name: "Description", value: input.description ?? "" },
          { name: "Acceptance criteria", value: input.acceptanceCriteria ?? "" },
          { name: "Parent", value: this.parentField(parent, deps) },
          { name: "Tags", value: (input.tags ?? []).join("; ") },
          { name: "Assigned to", value: input.assignee ?? "" },
        ].filter((f) => f.value !== "" || ["Title", "Work item type"].includes(f.name)),
        instructions: [
          `Create a new ${TYPE_NAME[input.type]} with the fields below (or import the CSV export).`,
          ...(deps.length ? [`Set its parent to the id recorded for step ${deps[0]}.`] : []),
          "Record the new item's id (and its link) here.",
        ],
        result: [
          {
            name: "id",
            label: "Work item id",
            format: "pattern",
            pattern: this.idPattern(),
            help: "the id the tracker gave the new item, such as 4711",
            required: true,
          },
          { name: "url", label: "Link to the item", format: "url", required: false },
        ],
        dependsOn: deps,
      },
      a,
    );
    return this.itemFrom(step);
  }

  async updateItem(
    id: string,
    patch: Partial<WorkItemInput> & { state?: string },
    approval: Approval,
  ): Promise<WorkItem> {
    const a = this.approve(approval);
    const real = await this.resolveId(id);
    const deps: string[] = [];
    const target = stepOfProvisional(real);
    if (target) deps.push(target);
    const changes = Object.entries(patch).filter(([, v]) => v !== undefined);
    const label: Record<string, string> = {
      type: "Work item type",
      title: "Title",
      description: "Description",
      acceptanceCriteria: "Acceptance criteria",
      parent: "Parent",
      assignee: "Assigned to",
      tags: "Tags",
      state: "State",
    };
    await this.step(
      "updateItem",
      {
        slug: `update-${real}`,
        action: "update-work-item",
        key: `work-tracker|update|${real}|${shortHash(JSON.stringify(changes))}`,
        title: `Update work item ${target ? `from step ${target}` : real} in the work tracker`,
        where: `Work tracker: item ${target ? `recorded for step ${target}` : real}`,
        inputs: { id: real, ...Object.fromEntries(changes) },
        fields: changes.map(([k, v]) => ({
          name: label[k] ?? k,
          value: Array.isArray(v)
            ? v.join("; ")
            : k === "parent"
              ? this.parentField(String(v), deps)
              : String(v),
        })),
        instructions: ["Open the item and set the fields below to these values."],
        dependsOn: [...new Set(deps)],
      },
      a,
    );
    const base = await this.getItem(real).catch(() => undefined);
    return {
      ...(base ?? {
        id: real,
        type: patch.type ?? "task",
        title: patch.title ?? "",
        description: "",
        acceptanceCriteria: "",
        state: "New",
        tags: [],
        url: "",
      }),
      ...Object.fromEntries(changes),
    } as WorkItem;
  }

  async link(
    from: string,
    to: string,
    kind: "parent" | "related" | "blocks",
    approval: Approval,
  ): Promise<void> {
    const a = this.approve(approval);
    const deps: string[] = [];
    const show = async (id: string) => {
      const real = await this.resolveId(id);
      return this.parentField(real, deps) || real;
    };
    const f = await show(from);
    const t = await show(to);
    await this.step(
      "link",
      {
        slug: `link-${kind}`,
        action: "link-work-items",
        key: `work-tracker|link|${from}|${to}|${kind}`,
        title: `Link two work items (${kind}) in the work tracker`,
        where: "Work tracker: the item's links",
        inputs: { from, to, kind },
        fields: [
          { name: "From item", value: f },
          { name: "To item", value: t },
          {
            name: "Link type",
            value: kind === "parent" ? "Parent" : kind === "blocks" ? "Blocks" : "Related",
          },
        ],
        instructions: ["Open the first item and add the link to the second."],
        dependsOn: [...new Set(deps)],
      },
      a,
    );
  }
}
