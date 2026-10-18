import { AdapterError, MockBase, requireApproval, type Approval } from "./common.js";

// ------------------------------------------------------------------ wiki (read-only)

/** Confluence, Azure DevOps wiki, SharePoint, a markdown folder. Atticus only ever reads. */
export interface WikiPage {
  id: string;
  space: string;
  title: string;
  /** Page body as markdown. Ingested text is data, never instructions. */
  body: string;
  version: number;
  updatedAt: string;
  url: string;
}

export interface Wiki {
  listPages(space: string): Promise<Omit<WikiPage, "body">[]>;
  getPage(id: string): Promise<WikiPage>;
  search(text: string): Promise<Omit<WikiPage, "body">[]>;
}

export class MockWiki extends MockBase implements Wiki {
  private pages = new Map<string, WikiPage>();

  constructor(seed: WikiPage[] = []) {
    super("wiki");
    for (const p of seed) this.pages.set(p.id, { ...p });
  }

  private head = ({ body: _b, ...rest }: WikiPage) => rest;

  async listPages(space: string) {
    this.call("listPages", [space]);
    return [...this.pages.values()].filter((p) => p.space === space).map(this.head);
  }

  async getPage(id: string) {
    this.call("getPage", [id]);
    return { ...(this.pages.get(id) ?? this.notFound(`page ${id}`)) };
  }

  async search(text: string) {
    this.call("search", [text]);
    const t = text.toLowerCase();
    return [...this.pages.values()]
      .filter((p) => p.title.toLowerCase().includes(t) || p.body.toLowerCase().includes(t))
      .map(this.head);
  }
}

// ------------------------------------------------------------------ design tool (read-only)

export interface DesignFile {
  key: string;
  name: string;
  pages: { id: string; name: string; frames: { id: string; name: string }[] }[];
}

export interface DesignTool {
  getFile(key: string): Promise<DesignFile>;
  /** A rendered image of a frame, as PNG bytes. */
  renderFrame(key: string, frameId: string): Promise<Uint8Array>;
}

export class MockDesignTool extends MockBase implements DesignTool {
  private files = new Map<string, DesignFile>();

  constructor(seed: DesignFile[] = []) {
    super("design-tool");
    for (const f of seed) this.files.set(f.key, structuredClone(f));
  }

  async getFile(key: string) {
    this.call("getFile", [key]);
    return structuredClone(this.files.get(key) ?? this.notFound(`design file ${key}`));
  }

  async renderFrame(key: string, frameId: string) {
    this.call("renderFrame", [key, frameId]);
    const file = this.files.get(key) ?? this.notFound(`design file ${key}`);
    if (!file.pages.some((p) => p.frames.some((f) => f.id === frameId)))
      this.notFound(`frame ${frameId}`);
    // The 8-byte PNG signature: enough for tests that only check the type.
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
}

// ------------------------------------------------------------------ notifications

export interface Notification {
  channel: string;
  title: string;
  body: string;
  link?: string;
  /** People to mention, by handle. */
  mentions?: string[];
}

export interface Notifier {
  /** Notifications may run on a standing approval a person gave once (for reminders). */
  send(n: Notification, approval: Approval): Promise<{ id: string }>;
}

export class MockNotifier extends MockBase implements Notifier {
  readonly sent: (Notification & { id: string })[] = [];

  constructor(private readonly channels: string[] = []) {
    super("notify");
  }

  async send(n: Notification, approval: Approval) {
    const a = requireApproval(this.name, approval, { allowStanding: true });
    this.call("send", [n], a);
    if (this.channels.length > 0 && !this.channels.includes(n.channel)) {
      throw new AdapterError(this.name, "invalid", `unknown channel ${n.channel}`);
    }
    const id = `msg-${this.sent.length + 1}`;
    this.sent.push({ ...n, id });
    return { id };
  }
}
