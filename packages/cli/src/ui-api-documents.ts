import { Api } from "@maycombhq/core";
import { badRequest, HttpError, notFound, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/**
 * General knowledge as files (ADR 0122), through the local API: the Documents tab's list of
 * inputs/, adding a file to inputs/inbox/, and copying a change's file there. Files only.
 */

/** The largest file the app may add: the same as a change attachment (ADR 0113). */
const MAX_FILE = 15 * 1024 * 1024;

export function uiDocumentRoutes(r: Router, ctx: ServerContext): Router {
  const root = ctx.root;
  const changed = (path: string) => ctx.events.publish({ type: "file.changed", path });
  return r
    .add("GET", "/api/knowledge/documents", async () => {
      const { listDocuments } = await import("./documents.js");
      return { status: 200, body: Api.DocumentList.parse(await listDocuments(root)) };
    })
    .add(
      "POST",
      "/api/knowledge/documents",
      async ({ body }) => {
        const b = Api.AttachFileRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Send the file's name and its bytes in base64.");
        const bytes = new Uint8Array(Buffer.from(b.data.content, "base64"));
        if (bytes.length > MAX_FILE)
          throw new HttpError(413, "The file is too large", "Add a file of 15 MB or less.");
        const { addToInbox } = await import("./intake-commands.js");
        const res = await addToInbox(root, [{ name: b.data.name, bytes }]);
        if (!res.added.length)
          throw new HttpError(422, "Atticus can't add that", res.refused[0]?.why ?? "", {
            lines: res.refused.map((x) => `${x.name}: ${x.why}`),
          });
        for (const a of res.added) changed(a.path);
        return { status: 201, body: Api.AddDocumentResult.parse(res) };
      },
      { maxBody: Math.ceil((MAX_FILE * 4) / 3) + 64 * 1024 },
    )
    .add("POST", "/api/changes/{changeId}/inputs/{name}/promote", async ({ params }) => {
      const { AttachError, promoteChangeInput } = await import("./attach-commands.js");
      try {
        const res = await promoteChangeInput(root, params.changeId!, params.name!);
        changed(res.path);
        return { status: 200, body: Api.PromoteResult.parse(res) };
      } catch (e) {
        if (e instanceof AttachError)
          throw e.code === "not-found"
            ? notFound(e.message)
            : new HttpError(422, "Atticus can't copy that", e.message);
        throw e;
      }
    });
}
