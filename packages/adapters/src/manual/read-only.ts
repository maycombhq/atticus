import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Approval } from "../common.js";
import type {
  DesignFile,
  DesignTool,
  Notification,
  Notifier,
  Wiki,
  WikiPage,
} from "../read-only.js";
import { ManualBase, provisionalId, type ManualOptions } from "./base.js";
import { shortHash } from "./steps.js";

/** A folder setting, relative to the metarepo root. */
function folder(opts: ManualOptions, value: string | undefined, fallback: string): string {
  const v = value ?? fallback;
  return isAbsolute(v) ? v : join(opts.root ?? ".", v);
}

/**
 * The wiki when Atticus can't reach it: pages come from an export folder of Markdown files
 * (settings `exportDir`, default `inputs/wiki`). The first folder level is the space. Wikis
 * are read-only, so there is nothing to turn into steps.
 */
export class ManualWiki extends ManualBase implements Wiki {
  constructor(opts: ManualOptions) {
    super("wiki", "wiki", opts);
  }

  private dir() {
    return folder(this.opts, this.setting("exportDir"), "inputs/wiki");
  }

  private async pages(): Promise<WikiPage[]> {
    const root = this.dir();
    const out: WikiPage[] = [];
    const walk = async (d: string) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name.startsWith(".")) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(md|markdown)$/i.test(e.name)) {
          const id = relative(root, full).split(sep).join("/");
          const body = await readFile(full, "utf8");
          const title =
            /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? e.name.replace(/\.(md|markdown)$/i, "");
          out.push({
            id,
            space: id.includes("/") ? id.split("/")[0]! : "default",
            title,
            body,
            version: 1,
            updatedAt: (await stat(full)).mtime.toISOString(),
            url: `file:${id}`,
          });
        }
      }
    };
    await walk(root);
    return out;
  }

  async listPages(space: string) {
    this.journal.push({ method: "listPages" });
    return (await this.pages()).filter((p) => p.space === space).map(({ body: _b, ...h }) => h);
  }

  async getPage(id: string) {
    this.journal.push({ method: "getPage" });
    return (
      (await this.pages()).find((p) => p.id === id) ??
      this.notFound(`page ${id}`, `export the page into ${this.dir()}`)
    );
  }

  async search(text: string) {
    this.journal.push({ method: "search" });
    const t = text.toLowerCase();
    return (await this.pages())
      .filter((p) => p.title.toLowerCase().includes(t) || p.body.toLowerCase().includes(t))
      .map(({ body: _b, ...h }) => h);
  }
}

/**
 * The design tool when Atticus can't reach it: files come from exports in `exportDir`
 * (default `inputs/design`): `<key>.json` in the DesignFile shape, and frames as
 * `<key>/<frame id>.png`. Read-only.
 */
export class ManualDesignTool extends ManualBase implements DesignTool {
  constructor(opts: ManualOptions) {
    super("design-tool", "design", opts);
  }

  private dir() {
    return folder(this.opts, this.setting("exportDir"), "inputs/design");
  }

  async getFile(key: string): Promise<DesignFile> {
    this.journal.push({ method: "getFile" });
    try {
      return JSON.parse(await readFile(join(this.dir(), `${key}.json`), "utf8")) as DesignFile;
    } catch {
      return this.notFound(`design file ${key}`, `export it as ${key}.json into ${this.dir()}`);
    }
  }

  async renderFrame(key: string, frameId: string): Promise<Uint8Array> {
    this.journal.push({ method: "renderFrame" });
    try {
      return new Uint8Array(await readFile(join(this.dir(), key, `${frameId}.png`)));
    } catch {
      return this.notFound(
        `frame ${frameId}`,
        `export it as ${key}/${frameId}.png into ${this.dir()}`,
      );
    }
  }
}

/**
 * Notifications when Atticus can't reach the chat or mail system: each message becomes a step
 * to send it by hand. A standing approval (reminders a person turned on once) still covers it.
 */
export class ManualNotifier extends ManualBase implements Notifier {
  constructor(opts: ManualOptions) {
    super("notify", "notify", opts);
  }

  async send(n: Notification, approval: Approval): Promise<{ id: string }> {
    const a = this.approve(approval, { allowStanding: true });
    const step = await this.step(
      "send",
      {
        slug: `message-${n.channel}`,
        action: "send-notification",
        key: `notify|${n.channel}|${shortHash(`${n.title}\n${n.body}\n${n.link ?? ""}`)}`,
        title: `Send "${n.title}" to ${n.channel}`,
        where: `Messages: ${n.channel}`,
        inputs: { channel: n.channel },
        fields: [
          { name: "Channel", value: n.channel },
          { name: "Title", value: n.title },
          { name: "Message", value: n.body },
          ...(n.link ? [{ name: "Link", value: n.link }] : []),
          ...(n.mentions?.length ? [{ name: "Mention", value: n.mentions.join(", ") }] : []),
        ],
        instructions: ["Send the message below to the channel, mentioning the people named."],
      },
      a,
    );
    return { id: provisionalId(step.id) };
  }
}
