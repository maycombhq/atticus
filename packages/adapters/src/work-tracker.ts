import { MockBase, requireApproval, type Approval } from "./common.js";

/** Azure DevOps Boards, Jira and the like: epics, features, stories, tasks, bugs. */
export type WorkItemType = "epic" | "feature" | "story" | "task" | "bug";

export interface WorkItem {
  id: string;
  type: WorkItemType;
  title: string;
  description: string;
  acceptanceCriteria: string;
  state: string;
  parent?: string;
  assignee?: string;
  tags: string[];
  url: string;
}

export interface WorkItemInput {
  type: WorkItemType;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  parent?: string;
  assignee?: string;
  tags?: string[];
}

export interface WorkItemQuery {
  type?: WorkItemType;
  parent?: string;
  state?: string;
  /** Case-insensitive text in the title or description. */
  text?: string;
  tag?: string;
}

export interface WorkTracker {
  getItem(id: string): Promise<WorkItem>;
  query(q: WorkItemQuery): Promise<WorkItem[]>;
  createItem(input: WorkItemInput, approval: Approval): Promise<WorkItem>;
  updateItem(
    id: string,
    patch: Partial<WorkItemInput> & { state?: string },
    approval: Approval,
  ): Promise<WorkItem>;
  link(
    from: string,
    to: string,
    kind: "parent" | "related" | "blocks",
    approval: Approval,
  ): Promise<void>;
}

export class MockWorkTracker extends MockBase implements WorkTracker {
  private items = new Map<string, WorkItem>();
  readonly links: { from: string; to: string; kind: string }[] = [];
  private next = 1000;

  constructor(seed: WorkItem[] = []) {
    super("work-tracker");
    for (const i of seed) this.items.set(i.id, { ...i });
  }

  /** Load the shape the fixture's ticket export uses. */
  static fromExport(
    rows: {
      id: number | string;
      type: string;
      title: string;
      acceptanceCriteria?: string;
      description?: string;
      state?: string;
    }[],
  ): MockWorkTracker {
    const type = (t: string): WorkItemType => {
      const k = t.toLowerCase();
      if (k.includes("story")) return "story";
      if (k.includes("epic")) return "epic";
      if (k.includes("feature")) return "feature";
      if (k.includes("bug")) return "bug";
      return "task";
    };
    return new MockWorkTracker(
      rows.map((r) => ({
        id: String(r.id),
        type: type(r.type),
        title: r.title,
        description: r.description ?? "",
        acceptanceCriteria: r.acceptanceCriteria ?? "",
        state: r.state ?? "New",
        tags: [],
        url: `https://work.example.com/items/${r.id}`,
      })),
    );
  }

  async getItem(id: string) {
    this.call("getItem", [id]);
    return { ...(this.items.get(id) ?? this.notFound(`work item ${id}`)) };
  }

  async query(q: WorkItemQuery) {
    this.call("query", [q]);
    const text = q.text?.toLowerCase();
    return [...this.items.values()]
      .filter(
        (i) =>
          (!q.type || i.type === q.type) &&
          (!q.parent || i.parent === q.parent) &&
          (!q.state || i.state === q.state) &&
          (!q.tag || i.tags.includes(q.tag)) &&
          (!text ||
            i.title.toLowerCase().includes(text) ||
            i.description.toLowerCase().includes(text)),
      )
      .map((i) => ({ ...i }));
  }

  async createItem(input: WorkItemInput, approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("createItem", [input], a);
    if (input.parent && !this.items.has(input.parent)) this.notFound(`parent ${input.parent}`);
    const id = String(this.next++);
    const item: WorkItem = {
      id,
      type: input.type,
      title: input.title,
      description: input.description ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? "",
      state: "New",
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {}),
      tags: input.tags ?? [],
      url: `https://work.example.com/items/${id}`,
    };
    this.items.set(id, item);
    return { ...item };
  }

  async updateItem(
    id: string,
    patch: Partial<WorkItemInput> & { state?: string },
    approval: Approval,
  ) {
    const a = requireApproval(this.name, approval);
    this.call("updateItem", [id, patch], a);
    const item = this.items.get(id) ?? this.notFound(`work item ${id}`);
    const updated = {
      ...item,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as WorkItem;
    this.items.set(id, updated);
    return { ...updated };
  }

  async link(from: string, to: string, kind: "parent" | "related" | "blocks", approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("link", [from, to, kind], a);
    if (!this.items.has(from)) this.notFound(`work item ${from}`);
    if (!this.items.has(to)) this.notFound(`work item ${to}`);
    this.links.push({ from, to, kind });
    if (kind === "parent") this.items.get(from)!.parent = to;
  }
}
